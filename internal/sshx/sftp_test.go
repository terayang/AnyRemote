package sshx

import (
	"bytes"
	"crypto/rand"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// newSftpSession returns a manager with one authenticated session against a
// fresh mock server.
func newSftpSession(t *testing.T) (*Manager, string) {
	t.Helper()
	server := startMockSSHServer(t)
	m := newTestManager(t, 5*time.Second)
	id, err := m.CreateSession(passwordAuth(server.port))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	return m, id
}

func entryNames(entries []FileEntry) []string {
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name)
	}
	return names
}

func findEntry(entries []FileEntry, name string) *FileEntry {
	for i := range entries {
		if entries[i].Name == name {
			return &entries[i]
		}
	}
	return nil
}

func contains(names []string, name string) bool {
	for _, n := range names {
		if n == name {
			return true
		}
	}
	return false
}

// writeRandomFile writes size random bytes to a new file inside dir.
func writeRandomFile(t *testing.T, dir, name string, size int) string {
	t.Helper()
	data := make([]byte, size)
	if _, err := rand.Read(data); err != nil {
		t.Fatalf("rand: %v", err)
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("write file: %v", err)
	}
	return path
}

// TestSftpFullChain exercises the whole file-manager flow on one session:
// homeDir, mkdir, list, upload (increasing progress, exact content),
// download, rename, deleteFile, deleteDir.
func TestSftpFullChain(t *testing.T) {
	m, id := newSftpSession(t)
	localDir := t.TempDir()

	// homeDir resolves to the sandbox root.
	home, err := m.HomeDir(id)
	if err != nil {
		t.Fatalf("HomeDir: %v", err)
	}
	if home != "/" {
		t.Fatalf("expected home %q, got %q", "/", home)
	}

	// mkdir, then list shows the new directory entry.
	if err := m.Mkdir(id, "/xfer"); err != nil {
		t.Fatalf("Mkdir: %v", err)
	}
	entries, err := m.List(id, "/")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	dir := findEntry(entries, "xfer")
	if dir == nil {
		t.Fatalf("expected /xfer in listing, got %v", entryNames(entries))
	}
	if dir.Type != "directory" {
		t.Fatalf("expected xfer to be a directory, got %q", dir.Type)
	}
	if dir.MtimeMs <= 0 {
		t.Fatalf("expected mtimeMs > 0, got %d", dir.MtimeMs)
	}
	if dir.Mode == 0 {
		t.Fatal("expected mode > 0")
	}

	// Upload 100 KB (> one 32 KB chunk) with increasing progress.
	const fileSize = 100_000
	localUp := writeRandomFile(t, localDir, "big.bin", fileSize)
	var uploadProgress []TransferProgress
	if err := m.Upload(id, localUp, "/xfer/big.bin", func(p TransferProgress) {
		uploadProgress = append(uploadProgress, p)
	}); err != nil {
		t.Fatalf("Upload: %v", err)
	}
	if len(uploadProgress) <= 1 {
		t.Fatalf("expected more than one progress event, got %d", len(uploadProgress))
	}
	for i := 1; i < len(uploadProgress); i++ {
		if uploadProgress[i].Transferred <= uploadProgress[i-1].Transferred {
			t.Fatalf("progress not increasing at %d: %+v after %+v", i, uploadProgress[i], uploadProgress[i-1])
		}
		if uploadProgress[i].Total != fileSize {
			t.Fatalf("expected total %d, got %d", fileSize, uploadProgress[i].Total)
		}
	}
	lastUp := uploadProgress[len(uploadProgress)-1]
	if lastUp.Transferred != fileSize || lastUp.Percent != 100 {
		t.Fatalf("expected final progress %d/100%%, got %+v", fileSize, lastUp)
	}

	// The remote listing reflects the upload.
	entries, err = m.List(id, "/xfer")
	if err != nil {
		t.Fatalf("List /xfer: %v", err)
	}
	up := findEntry(entries, "big.bin")
	if up == nil {
		t.Fatalf("expected big.bin in /xfer, got %v", entryNames(entries))
	}
	if up.Type != "file" || up.Size != fileSize {
		t.Fatalf("unexpected entry for big.bin: %+v", up)
	}

	// Download the file back with progress and identical content.
	localDown := filepath.Join(localDir, "big-downloaded.bin")
	var downloadProgress []TransferProgress
	if err := m.Download(id, "/xfer/big.bin", localDown, func(p TransferProgress) {
		downloadProgress = append(downloadProgress, p)
	}); err != nil {
		t.Fatalf("Download: %v", err)
	}
	if len(downloadProgress) <= 1 {
		t.Fatalf("expected more than one progress event, got %d", len(downloadProgress))
	}
	lastDown := downloadProgress[len(downloadProgress)-1]
	if lastDown.Transferred != fileSize || lastDown.Percent != 100 {
		t.Fatalf("expected final progress %d/100%%, got %+v", fileSize, lastDown)
	}
	want, err := os.ReadFile(localUp)
	if err != nil {
		t.Fatalf("read local upload: %v", err)
	}
	got, err := os.ReadFile(localDown)
	if err != nil {
		t.Fatalf("read download: %v", err)
	}
	if !bytes.Equal(want, got) {
		t.Fatal("downloaded content differs from uploaded content")
	}

	// Rename, then delete the file.
	if err := m.Rename(id, "/xfer/big.bin", "/xfer/renamed.bin"); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	entries, err = m.List(id, "/xfer")
	if err != nil {
		t.Fatalf("List /xfer after rename: %v", err)
	}
	names := entryNames(entries)
	if !contains(names, "renamed.bin") || contains(names, "big.bin") {
		t.Fatalf("rename not reflected in listing: %v", names)
	}
	if err := m.DeleteFile(id, "/xfer/renamed.bin"); err != nil {
		t.Fatalf("DeleteFile: %v", err)
	}
	entries, err = m.List(id, "/xfer")
	if err != nil {
		t.Fatalf("List /xfer after delete: %v", err)
	}
	if contains(entryNames(entries), "renamed.bin") {
		t.Fatal("renamed.bin still present after DeleteFile")
	}

	// deleteDir is non-recursive: a non-empty directory is refused, an
	// empty one is removed.
	if err := m.Mkdir(id, "/nonempty"); err != nil {
		t.Fatalf("Mkdir /nonempty: %v", err)
	}
	small := writeRandomFile(t, localDir, "small.txt", 4)
	if err := m.Upload(id, small, "/nonempty/small.txt", nil); err != nil {
		t.Fatalf("Upload small: %v", err)
	}
	requireSshError(t, m.DeleteDir(id, "/nonempty"), ErrRemoteError)

	if err := m.Mkdir(id, "/empty"); err != nil {
		t.Fatalf("Mkdir /empty: %v", err)
	}
	if err := m.DeleteDir(id, "/empty"); err != nil {
		t.Fatalf("DeleteDir /empty: %v", err)
	}
	entries, err = m.List(id, "/")
	if err != nil {
		t.Fatalf("List /: %v", err)
	}
	names = entryNames(entries)
	if contains(names, "empty") {
		t.Fatal("/empty still present after DeleteDir")
	}
	if !contains(names, "nonempty") {
		t.Fatal("/nonempty should still be present")
	}
}

func TestListMissingDir(t *testing.T) {
	m, id := newSftpSession(t)
	_, err := m.List(id, "/no-such-dir")
	requireSshError(t, err, ErrRemoteError)
}

func TestUploadMissingLocalFile(t *testing.T) {
	m, id := newSftpSession(t)
	err := m.Upload(id, filepath.Join(t.TempDir(), "missing.bin"), "/x.bin", nil)
	requireSshError(t, err, ErrRemoteError)
}

func TestDownloadMissingRemoteFile(t *testing.T) {
	m, id := newSftpSession(t)
	err := m.Download(id, "/no-such-file.bin", filepath.Join(t.TempDir(), "out.bin"), nil)
	requireSshError(t, err, ErrRemoteError)
}

func TestSftpOperationsAfterCloseSession(t *testing.T) {
	m, id := newSftpSession(t)
	if err := m.CloseSession(id); err != nil {
		t.Fatalf("CloseSession: %v", err)
	}
	// A real local file so Upload reaches the session lookup before failing.
	local := writeRandomFile(t, t.TempDir(), "a.bin", 4)
	_, err := m.List(id, "/")
	requireSshError(t, err, ErrSessionNotFound)
	_, err = m.HomeDir(id)
	requireSshError(t, err, ErrSessionNotFound)
	requireSshError(t, m.Mkdir(id, "/x"), ErrSessionNotFound)
	requireSshError(t, m.Upload(id, local, "/a.bin", nil), ErrSessionNotFound)
	requireSshError(t, m.Download(id, "/a.bin", local+".out", nil), ErrSessionNotFound)
}

func TestSftpOperationsUnknownSession(t *testing.T) {
	m := newTestManager(t, 5*time.Second)
	_, err := m.List("no-such-session", "/")
	requireSshError(t, err, ErrSessionNotFound)
}
