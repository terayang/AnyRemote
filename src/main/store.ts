/**
 * Saved-connection store (F5, stage 6): persists connection bookmarks to
 * `app.getPath('userData')/connections.json` with the secret encrypted via
 * Electron safeStorage (macOS Keychain / Windows DPAPI).
 *
 * On-disk shape per entry: { id, name, host, protocols, username, secret? }
 * where secret.data is the base64 of safeStorage.encryptString(plaintext) —
 * the file never contains a plaintext secret. The decrypted form exists only
 * in memory inside get() and crosses IPC to the renderer there.
 *
 * Encryption is a hard requirement: when safeStorage.isEncryptionAvailable()
 * is false, save() refuses to persist a secret and throws a StoreError with
 * code 'ENCRYPTION_UNAVAILABLE' (never falling back to plaintext).
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app, safeStorage } from 'electron'
import type {
  SavedConnection,
  SavedConnectionInput,
  SavedConnectionSummary
} from '../shared/ipc'

/** Error carrying an IPC-visible code (picked up by serializeError). */
export class StoreError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'StoreError'
    this.code = code
  }
}

const connectionsFile = (): string => join(app.getPath('userData'), 'connections.json')

/** Reads the whole store file; a missing file means an empty store. */
async function readAll(): Promise<SavedConnection[]> {
  let raw: string
  try {
    raw = await readFile(connectionsFile(), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) {
    throw new StoreError('STORE_CORRUPT', `${connectionsFile()} is not a JSON array`)
  }
  return parsed as SavedConnection[]
}

/** Writes the store atomically (tmp file + rename) so a crash cannot truncate it. */
async function writeAll(connections: SavedConnection[]): Promise<void> {
  const file = connectionsFile()
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(connections, null, 2), 'utf8')
  await rename(tmp, file)
}

/** Strips the secret for list results. */
function toSummary({ id, name, host, protocols, username }: SavedConnection): SavedConnectionSummary {
  return { id, name, host, protocols, username }
}

/** Lists every saved connection without secrets. */
export async function list(): Promise<SavedConnectionSummary[]> {
  return (await readAll()).map(toSummary)
}

/**
 * Returns one connection with its secret DECRYPTED (for establishing a
 * session), or null when the id is unknown.
 */
export async function get(id: string): Promise<SavedConnection | null> {
  const found = (await readAll()).find((conn) => conn.id === id)
  if (!found) return null
  if (!found.secret) return toSummary(found)
  if (!safeStorage.isEncryptionAvailable()) {
    throw new StoreError(
      'ENCRYPTION_UNAVAILABLE',
      'safeStorage encryption is not available; cannot decrypt the saved secret'
    )
  }
  return {
    ...toSummary(found),
    secret: {
      kind: found.secret.kind,
      data: safeStorage.decryptString(Buffer.from(found.secret.data, 'base64'))
    }
  }
}

/**
 * Creates (no id) or updates (existing id) a connection. The secret's
 * plaintext data is encrypted with safeStorage before it touches the disk.
 */
export async function save(input: SavedConnectionInput): Promise<SavedConnectionSummary> {
  let secret: SavedConnection['secret']
  if (input.secret) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new StoreError(
        'ENCRYPTION_UNAVAILABLE',
        'safeStorage encryption is not available; refusing to store the secret'
      )
    }
    secret = {
      kind: input.secret.kind,
      data: safeStorage.encryptString(input.secret.data).toString('base64')
    }
  }
  const connections = await readAll()
  const id = input.id ?? randomUUID()
  const record: SavedConnection = {
    id,
    name: input.name,
    host: input.host,
    protocols: [...input.protocols],
    username: input.username,
    ...(secret ? { secret } : {})
  }
  const at = connections.findIndex((conn) => conn.id === id)
  if (at === -1) {
    connections.push(record)
  } else {
    connections[at] = record
  }
  await writeAll(connections)
  return toSummary(record)
}

/** Removes one connection; an unknown id is a no-op. */
export async function remove(id: string): Promise<void> {
  const connections = await readAll()
  const kept = connections.filter((conn) => conn.id !== id)
  if (kept.length !== connections.length) await writeAll(kept)
}
