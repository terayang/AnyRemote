/**
 * SFTP file-management service (stage 4). Every operation runs over the
 * existing SSH connection of a session created by sshService.createSession
 * (same ssh2 Client, one short-lived SFTP subsystem channel per call), so
 * the file manager never re-authenticates.
 *
 * Remote failures reject with SshError code REMOTE_ERROR; an unknown or
 * closed session id rejects with SESSION_NOT_FOUND.
 */

import type { FileEntryWithStats, SFTPWrapper } from 'ssh2'
import {
  SshError,
  type FileEntry,
  type TransferProgress
} from '../../shared/ssh'
import { getSessionClient } from './sshService'

/** Opens a short-lived SFTP channel on the session's connection. */
function openSftp(sessionId: string): Promise<SFTPWrapper> {
  const client = getSessionClient(sessionId) // throws SESSION_NOT_FOUND
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) {
        reject(new SshError('CONNECTION_LOST', `Failed to open SFTP channel: ${err.message}`))
        return
      }
      resolve(sftp)
    })
  })
}

/** Runs one operation on a fresh SFTP channel, always closing it after. */
async function withSftp<T>(
  sessionId: string,
  op: (sftp: SFTPWrapper) => Promise<T>
): Promise<T> {
  const sftp = await openSftp(sessionId)
  try {
    return await op(sftp)
  } finally {
    sftp.end()
  }
}

function remoteError(action: string, err: Error): SshError {
  return new SshError('REMOTE_ERROR', `${action}: ${err.message}`)
}

function toFileEntry(entry: FileEntryWithStats): FileEntry {
  const attrs = entry.attrs
  return {
    name: entry.filename,
    type: attrs.isDirectory() ? 'directory' : attrs.isSymbolicLink() ? 'symlink' : 'file',
    size: attrs.size,
    mtimeMs: attrs.mtime * 1000,
    mode: attrs.mode
  }
}

/** Adapts the fastPut/fastGet step callback to a TransferProgress callback. */
function toStep(onProgress?: (progress: TransferProgress) => void) {
  if (!onProgress) return undefined
  return (transferred: number, _chunkBytes: number, total: number) => {
    onProgress({
      transferred,
      total,
      percent: total > 0 ? (transferred / total) * 100 : 100
    })
  }
}

/** Lists one remote directory. Throws REMOTE_ERROR when it does not exist. */
export function list(sessionId: string, path: string): Promise<FileEntry[]> {
  return withSftp(
    sessionId,
    (sftp) =>
      new Promise((resolve, reject) => {
        sftp.readdir(path, (err, entries) => {
          if (err) {
            reject(remoteError(`Failed to list ${path}`, err))
            return
          }
          resolve(entries.map(toFileEntry))
        })
      })
  )
}

/** Creates one remote directory (non-recursive). */
export function mkdir(sessionId: string, path: string): Promise<void> {
  return withSftp(
    sessionId,
    (sftp) =>
      new Promise((resolve, reject) => {
        sftp.mkdir(path, (err) => {
          if (err) {
            reject(remoteError(`Failed to create directory ${path}`, err))
            return
          }
          resolve()
        })
      })
  )
}

/** Renames/moves a remote file or directory. */
export function rename(
  sessionId: string,
  oldPath: string,
  newPath: string
): Promise<void> {
  return withSftp(
    sessionId,
    (sftp) =>
      new Promise((resolve, reject) => {
        sftp.rename(oldPath, newPath, (err) => {
          if (err) {
            reject(remoteError(`Failed to rename ${oldPath} to ${newPath}`, err))
            return
          }
          resolve()
        })
      })
  )
}

/** Deletes one remote file (or symlink). */
export function deleteFile(sessionId: string, path: string): Promise<void> {
  return withSftp(
    sessionId,
    (sftp) =>
      new Promise((resolve, reject) => {
        sftp.unlink(path, (err) => {
          if (err) {
            reject(remoteError(`Failed to delete file ${path}`, err))
            return
          }
          resolve()
        })
      })
  )
}

/** Removes one remote directory. Non-recursive: it must be empty. */
export function deleteDir(sessionId: string, path: string): Promise<void> {
  return withSftp(
    sessionId,
    (sftp) =>
      new Promise((resolve, reject) => {
        sftp.rmdir(path, (err) => {
          if (err) {
            reject(remoteError(`Failed to remove directory ${path}`, err))
            return
          }
          resolve()
        })
      })
  )
}

/**
 * Uploads a local file in chunks (ssh2 fastPut, parallel writes). Progress
 * callbacks fire per flushed chunk; an empty file completes without any.
 */
export function upload(
  sessionId: string,
  localPath: string,
  remotePath: string,
  onProgress?: (progress: TransferProgress) => void
): Promise<void> {
  return withSftp(
    sessionId,
    (sftp) =>
      new Promise((resolve, reject) => {
        sftp.fastPut(localPath, remotePath, { step: toStep(onProgress) }, (err) => {
          if (err) {
            reject(remoteError(`Failed to upload ${localPath} to ${remotePath}`, err))
            return
          }
          resolve()
        })
      })
  )
}

/**
 * Downloads a remote file in chunks (ssh2 fastGet, parallel reads). Progress
 * callbacks fire per received chunk; an empty file completes without any.
 */
export function download(
  sessionId: string,
  remotePath: string,
  localPath: string,
  onProgress?: (progress: TransferProgress) => void
): Promise<void> {
  return withSftp(
    sessionId,
    (sftp) =>
      new Promise((resolve, reject) => {
        sftp.fastGet(remotePath, localPath, { step: toStep(onProgress) }, (err) => {
          if (err) {
            reject(remoteError(`Failed to download ${remotePath} to ${localPath}`, err))
            return
          }
          resolve()
        })
      })
  )
}

/** Resolves the session's initial (home) directory to an absolute path. */
export function homeDir(sessionId: string): Promise<string> {
  return withSftp(
    sessionId,
    (sftp) =>
      new Promise((resolve, reject) => {
        sftp.realpath('.', (err, absPath) => {
          if (err) {
            reject(remoteError('Failed to resolve home directory', err))
            return
          }
          resolve(absPath)
        })
      })
  )
}
