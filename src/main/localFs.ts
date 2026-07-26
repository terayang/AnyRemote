/**
 * Local filesystem listing service: backs the left (local) pane of the file
 * manager. Entries use the same FileEntry shape as the remote SFTP side
 * (src/shared/ssh.ts) so both panes render with one component.
 */

import { lstat, readdir } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { FileEntry } from '../shared/ssh'

/** The local user's home directory (starting path of the local pane). */
export function homeDir(): string {
  return homedir()
}

/**
 * Lists one local directory, directories first (each group sorted by name).
 * Entries that vanish or become unreadable mid-listing are skipped; a
 * failure to read the directory itself rejects with the Node system error,
 * surfaced over IPC as an IpcError carrying its errno code (ENOENT, EACCES).
 */
export async function list(dirPath: string): Promise<FileEntry[]> {
  const dirents = await readdir(dirPath, { withFileTypes: true })
  const entries: FileEntry[] = []
  await Promise.all(
    dirents.map(async (dirent) => {
      let stats: Stats
      try {
        // lstat (not stat): mirrors SFTP readdir semantics — a symlink
        // reports the link's own attributes, not its target's.
        stats = await lstat(join(dirPath, dirent.name))
      } catch {
        return // raced deletion or unreadable entry: skip it
      }
      entries.push({
        name: dirent.name,
        type: dirent.isDirectory() ? 'directory' : dirent.isSymbolicLink() ? 'symlink' : 'file',
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        mode: stats.mode
      })
    })
  )
  entries.sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1
    if (a.type !== 'directory' && b.type === 'directory') return 1
    return a.name.localeCompare(b.name)
  })
  return entries
}
