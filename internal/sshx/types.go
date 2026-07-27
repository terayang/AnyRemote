// Package sshx provides SSH session and SFTP file-management services for
// the Wails backend. It is a pure-Go port of the Electron services in
// src/main/ssh/sshService.ts and src/main/ssh/sftpService.ts and has no
// Wails dependencies; the JSON shapes mirror src/shared/ssh.ts so results
// can be fed to the frontend unchanged.
package sshx

// ErrorCode classifies failures so the UI can render plain-language errors.
// Values mirror the SshErrorCode union in src/shared/ssh.ts.
type ErrorCode string

const (
	// ErrAuthFailed: credentials rejected by the server.
	ErrAuthFailed ErrorCode = "AUTH_FAILED"
	// ErrTimeout: connect or handshake did not finish within the ready timeout.
	ErrTimeout ErrorCode = "TIMEOUT"
	// ErrUnreachable: socket-level failure (refused, no route, DNS, reset
	// before auth); also an unreadable private-key file, matching the TS
	// service which fails before touching the network in that case.
	ErrUnreachable ErrorCode = "UNREACHABLE"
	// ErrSessionNotFound: operation referenced an unknown or closed session id.
	ErrSessionNotFound ErrorCode = "SESSION_NOT_FOUND"
	// ErrConnectionLost: established connection dropped or failed while in use.
	ErrConnectionLost ErrorCode = "CONNECTION_LOST"
	// ErrRemoteError: a remote (shell/SFTP) operation failed after login.
	ErrRemoteError ErrorCode = "REMOTE_ERROR"
)

// SshError carries a machine-readable ErrorCode alongside the message.
type SshError struct {
	Code    ErrorCode `json:"code"`
	Message string    `json:"message"`
}

func (e *SshError) Error() string { return e.Message }

// AuthConfig holds the credentials and endpoint for one SSH connection.
// JSON tags mirror SshAuthConfig in src/shared/ssh.ts.
type AuthConfig struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	// Password auth; ignored when a private key is set.
	Password string `json:"password,omitempty"`
	// PEM/OpenSSH-encoded private key content. For compatibility with the TS
	// renderer's credential flow, a value without a "-----BEGIN" header is
	// treated as a key file path instead of key content.
	PrivateKey string `json:"privateKey,omitempty"`
	// Path to a local private-key file, read when PrivateKey is absent. A
	// leading "~/" expands to the user's home directory. An unreadable file
	// fails the connect with an UNREACHABLE error naming the path.
	PrivateKeyPath string `json:"privateKeyPath,omitempty"`
	// Passphrase decrypting an encrypted private key.
	Passphrase string `json:"passphrase,omitempty"`
}

// FileEntry is one directory entry as shown by the SFTP file manager.
// JSON tags mirror FileEntry in src/shared/ssh.ts.
type FileEntry struct {
	Name string `json:"name"`
	// "file", "directory" or "symlink".
	Type string `json:"type"`
	// Size in bytes.
	Size int64 `json:"size"`
	// Modification time in ms since the Unix epoch.
	MtimeMs int64 `json:"mtimeMs"`
	// Full POSIX mode (type bits + permission bits).
	Mode uint32 `json:"mode"`
}

// TransferProgress reports the progress of one upload/download.
// JSON tags mirror TransferProgress in src/shared/ssh.ts.
type TransferProgress struct {
	// Bytes transferred so far.
	Transferred int64 `json:"transferred"`
	// Total file size in bytes.
	Total int64 `json:"total"`
	// 0-100, derived from Transferred / Total.
	Percent float64 `json:"percent"`
}
