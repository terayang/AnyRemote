/**
 * Types for SSH terminal sessions and SFTP file management, shared between
 * the main-process services (src/main/ssh/) and their consumers (renderer
 * terminal / file manager via IPC, tests). Electron-free so vitest can
 * exercise the services directly.
 */

/** Credentials and endpoint for one SSH connection. */
export interface SshAuthConfig {
  host: string
  port: number
  username: string
  /** Password auth; ignored when privateKey is set. */
  password?: string
  /** PEM/OpenSSH-encoded private key for publickey auth. */
  privateKey?: string
  /** Passphrase decrypting privateKey when the key is encrypted. */
  passphrase?: string
}

/** Distinguishable failure causes surfaced to the UI for plain-language errors. */
export type SshErrorCode =
  /** Credentials rejected by the server. */
  | 'AUTH_FAILED'
  /** Connect or handshake did not finish within the ready timeout. */
  | 'TIMEOUT'
  /** Socket-level failure: refused, no route, DNS, reset before auth. */
  | 'UNREACHABLE'
  /** Operation referenced an unknown or already-closed session id. */
  | 'SESSION_NOT_FOUND'
  /** Established connection dropped or failed while in use. */
  | 'CONNECTION_LOST'
  /** A remote (shell/SFTP) operation failed after login. */
  | 'REMOTE_ERROR'

/** Error carrying a machine-readable SshErrorCode alongside the message. */
export class SshError extends Error {
  readonly code: SshErrorCode

  constructor(code: SshErrorCode, message: string) {
    super(message)
    this.name = 'SshError'
    this.code = code
  }
}

export type SshFileType = 'file' | 'directory' | 'symlink'

/** One directory entry as shown by the SFTP file manager. */
export interface FileEntry {
  name: string
  type: SshFileType
  /** Size in bytes. */
  size: number
  /** Modification time in ms since the Unix epoch. */
  mtimeMs: number
  /** Full POSIX mode (type bits + permission bits). */
  mode: number
}

/** Progress of one upload/download, delivered via callback. */
export interface TransferProgress {
  /** Bytes transferred so far. */
  transferred: number
  /** Total file size in bytes. */
  total: number
  /** 0-100, derived from transferred / total. */
  percent: number
}

/** Initial pseudo-terminal dimensions for a shell session. */
export interface ShellSize {
  cols: number
  rows: number
}

/** Callbacks receiving shell output and lifecycle events. */
export interface ShellCallbacks {
  onData: (data: string) => void
  onClose: () => void
}
