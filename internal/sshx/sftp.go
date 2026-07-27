// SFTP file-management service, ported from src/main/ssh/sftpService.ts.
// Every operation runs over the existing SSH connection of a session created
// by Manager.CreateSession (one short-lived SFTP subsystem channel per
// call), so the file manager never re-authenticates.
//
// Remote failures return *SshError with code REMOTE_ERROR; an unknown or
// closed session id fails with SESSION_NOT_FOUND.
package sshx

import (
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/pkg/sftp"
)

// transferChunkSize matches the ssh2 fastPut/fastGet chunk size (32 KB) of
// the TS service, so progress callbacks fire at the same granularity.
const transferChunkSize = 32 * 1024

// withSftp runs one operation on a fresh SFTP channel, always closing it.
func (m *Manager) withSftp(id string, op func(*sftp.Client) error) error {
	sess, err := m.requireSession(id)
	if err != nil {
		return err
	}
	client, err := sftp.NewClient(sess.client)
	if err != nil {
		return &SshError{Code: ErrConnectionLost, Message: "Failed to open SFTP channel: " + err.Error()}
	}
	defer func() { _ = client.Close() }()
	return op(client)
}

func remoteError(action string, err error) *SshError {
	return &SshError{Code: ErrRemoteError, Message: fmt.Sprintf("%s: %v", action, err)}
}

// HomeDir resolves the session's initial (home) directory to an absolute path.
func (m *Manager) HomeDir(id string) (string, error) {
	var home string
	err := m.withSftp(id, func(client *sftp.Client) error {
		path, err := client.Getwd()
		if err != nil {
			return remoteError("Failed to resolve home directory", err)
		}
		home = path
		return nil
	})
	return home, err
}

// List lists one remote directory. It fails with REMOTE_ERROR when the
// directory does not exist.
func (m *Manager) List(id, path string) ([]FileEntry, error) {
	var entries []FileEntry
	err := m.withSftp(id, func(client *sftp.Client) error {
		infos, err := client.ReadDir(path)
		if err != nil {
			return remoteError("Failed to list "+path, err)
		}
		entries = make([]FileEntry, 0, len(infos))
		for _, info := range infos {
			entries = append(entries, toFileEntry(info))
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return entries, nil
}

// Mkdir creates one remote directory (non-recursive).
func (m *Manager) Mkdir(id, path string) error {
	return m.withSftp(id, func(client *sftp.Client) error {
		if err := client.Mkdir(path); err != nil {
			return remoteError("Failed to create directory "+path, err)
		}
		return nil
	})
}

// Rename renames/moves a remote file or directory.
func (m *Manager) Rename(id, oldPath, newPath string) error {
	return m.withSftp(id, func(client *sftp.Client) error {
		if err := client.Rename(oldPath, newPath); err != nil {
			return remoteError(fmt.Sprintf("Failed to rename %s to %s", oldPath, newPath), err)
		}
		return nil
	})
}

// DeleteFile deletes one remote file (or symlink).
func (m *Manager) DeleteFile(id, path string) error {
	return m.withSftp(id, func(client *sftp.Client) error {
		if err := client.Remove(path); err != nil {
			return remoteError("Failed to delete file "+path, err)
		}
		return nil
	})
}

// DeleteDir removes one remote directory. Non-recursive: it must be empty.
func (m *Manager) DeleteDir(id, path string) error {
	return m.withSftp(id, func(client *sftp.Client) error {
		if err := client.RemoveDirectory(path); err != nil {
			return remoteError("Failed to remove directory "+path, err)
		}
		return nil
	})
}

// Upload copies a local file to the remote host in chunks, invoking
// onProgress after each written chunk. An empty file completes without any
// progress callback, matching the TS fastPut step callback.
func (m *Manager) Upload(id, localPath, remotePath string, onProgress func(TransferProgress)) error {
	src, err := os.Open(localPath)
	if err != nil {
		return remoteError(fmt.Sprintf("Failed to upload %s to %s", localPath, remotePath), err)
	}
	defer func() { _ = src.Close() }()
	info, err := src.Stat()
	if err != nil {
		return remoteError(fmt.Sprintf("Failed to upload %s to %s", localPath, remotePath), err)
	}
	return m.withSftp(id, func(client *sftp.Client) error {
		dst, err := client.Create(remotePath)
		if err != nil {
			return remoteError(fmt.Sprintf("Failed to upload %s to %s", localPath, remotePath), err)
		}
		defer func() { _ = dst.Close() }()
		if err := copyWithProgress(dst, src, info.Size(), onProgress); err != nil {
			return remoteError(fmt.Sprintf("Failed to upload %s to %s", localPath, remotePath), err)
		}
		return nil
	})
}

// Download copies a remote file to the local disk in chunks, invoking
// onProgress after each received chunk. An empty file completes without any
// progress callback, matching the TS fastGet step callback.
func (m *Manager) Download(id, remotePath, localPath string, onProgress func(TransferProgress)) error {
	return m.withSftp(id, func(client *sftp.Client) error {
		src, err := client.Open(remotePath)
		if err != nil {
			return remoteError(fmt.Sprintf("Failed to download %s to %s", remotePath, localPath), err)
		}
		defer func() { _ = src.Close() }()
		info, err := src.Stat()
		if err != nil {
			return remoteError(fmt.Sprintf("Failed to download %s to %s", remotePath, localPath), err)
		}
		dst, err := os.Create(localPath)
		if err != nil {
			return remoteError(fmt.Sprintf("Failed to download %s to %s", remotePath, localPath), err)
		}
		defer func() { _ = dst.Close() }()
		if err := copyWithProgress(dst, src, info.Size(), onProgress); err != nil {
			return remoteError(fmt.Sprintf("Failed to download %s to %s", remotePath, localPath), err)
		}
		return nil
	})
}

// copyWithProgress copies src to dst in transferChunkSize chunks, reporting
// cumulative progress after each chunk. total is the expected byte count
// (from the source's stat); percent follows the TS formula.
func copyWithProgress(dst io.Writer, src io.Reader, total int64, onProgress func(TransferProgress)) error {
	buf := make([]byte, transferChunkSize)
	var transferred int64
	for {
		n, readErr := src.Read(buf)
		if n > 0 {
			written, writeErr := dst.Write(buf[:n])
			transferred += int64(written)
			if writeErr == nil && written != n {
				writeErr = io.ErrShortWrite
			}
			if writeErr != nil {
				return writeErr
			}
			if onProgress != nil {
				onProgress(TransferProgress{
					Transferred: transferred,
					Total:       total,
					Percent:     percent(transferred, total),
				})
			}
		}
		if errors.Is(readErr, io.EOF) {
			return nil
		}
		if readErr != nil {
			return readErr
		}
	}
}

func percent(transferred, total int64) float64 {
	if total > 0 {
		return float64(transferred) / float64(total) * 100
	}
	return 100
}

// toFileEntry maps SFTP attributes onto the wire shape of the TS FileEntry.
// The POSIX mode comes from the raw sftp.FileStat when available so it keeps
// the type bits (S_IFDIR/S_IFLNK) exactly as the server sent them.
func toFileEntry(info os.FileInfo) FileEntry {
	entryType := "file"
	switch {
	case info.IsDir():
		entryType = "directory"
	case info.Mode()&os.ModeSymlink != 0:
		entryType = "symlink"
	}
	mode := uint32(info.Mode().Perm())
	if stat, ok := info.Sys().(*sftp.FileStat); ok {
		mode = stat.Mode
	}
	return FileEntry{
		Name:    info.Name(),
		Type:    entryType,
		Size:    info.Size(),
		MtimeMs: info.ModTime().UnixMilli(),
		Mode:    mode,
	}
}
