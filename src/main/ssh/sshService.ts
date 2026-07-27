/**
 * SSH session manager (stages 3-4): owns one ssh2 Client connection per
 * session and exposes a single interactive shell per session on top of it.
 *
 * Electron-free on purpose so vitest can drive it directly against the
 * in-process mock server (tests/helpers/mockSshServer.ts). The SFTP service
 * reuses the same connections through getSessionClient().
 *
 * Connect-time failures reject with SshError carrying a distinguishable
 * code: AUTH_FAILED (credentials rejected), TIMEOUT (handshake timeout),
 * UNREACHABLE (socket/DNS/protocol failure before the session was ready).
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'
import {
  SshError,
  type SshAuthConfig,
  type ShellCallbacks,
  type ShellSize
} from '../../shared/ssh'

interface SessionRecord {
  client: Client
  /** At most one open shell channel per session (undefined when none). */
  shell?: ClientChannel
}

interface CreateSessionOptions {
  /** Handshake/auth timeout in ms. Default 10000. */
  readyTimeoutMs?: number
}

const DEFAULT_READY_TIMEOUT_MS = 10_000

const sessions = new Map<string, SessionRecord>()

/** Maps an ssh2 connect-time error onto a distinguishable SshError. */
function mapConnectError(err: Error & { level?: string }): SshError {
  const reason = err.message || 'unknown error'
  switch (err.level) {
    case 'client-authentication':
      return new SshError('AUTH_FAILED', `Authentication failed: ${reason}`)
    case 'client-timeout':
      return new SshError('TIMEOUT', `Connection timed out: ${reason}`)
    case 'client-dns':
    case 'client-socket':
      return new SshError('UNREACHABLE', `Host unreachable: ${reason}`)
    default:
      return new SshError('UNREACHABLE', `Connection failed: ${reason}`)
  }
}

function requireRecord(sessionId: string): SessionRecord {
  const record = sessions.get(sessionId)
  if (!record) {
    throw new SshError('SESSION_NOT_FOUND', `Unknown or closed session: ${sessionId}`)
  }
  return record
}

/**
 * Resolves the private key to authenticate with, returning PEM/OpenSSH key
 * content or undefined.
 *
 * Resolution order:
 * 1. config.privateKey holding actual key content (contains a BEGIN header)
 *    is used as-is.
 * 2. config.privateKey without a BEGIN header is a key FILE PATH — the
 *    renderer's credential flow (SessionCredentials.privateKey, documented
 *    as a path) forwards paths through this field, and the panel components
 *    passing them predate the explicit privateKeyPath field.
 * 3. config.privateKeyPath is read from disk (a leading `~/` expands to the
 *    user's home directory).
 *
 * An unreadable key file throws an UNREACHABLE SshError naming the path.
 */
export function resolvePrivateKey(config: SshAuthConfig): string | undefined {
  let path = config.privateKeyPath
  if (config.privateKey !== undefined) {
    if (config.privateKey.includes('-----BEGIN')) return config.privateKey
    path = config.privateKey
  }
  if (path === undefined) return undefined
  const expanded = path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
  try {
    return readFileSync(expanded, 'utf8')
  } catch (err) {
    throw new SshError(
      'UNREACHABLE',
      `Private key file is not readable: ${path} (${(err as Error).message})`
    )
  }
}

/**
 * Opens one SSH connection (password or private-key auth) and resolves with
 * its session id once the connection is authenticated and ready.
 */
export function createSession(
  config: SshAuthConfig,
  options?: CreateSessionOptions
): Promise<string> {
  return new Promise((resolve, reject) => {
    const sessionId = randomUUID()
    const client = new Client()
    let settled = false

    const settleReject = (err: SshError) => {
      if (settled) return
      settled = true
      client.removeListener('error', onConnectError)
      client.removeListener('close', onConnectClose)
      // Swallow late errors from the socket teardown.
      client.on('error', () => {})
      client.end()
      reject(err)
    }
    const onConnectError = (err: Error & { level?: string }) => {
      settleReject(mapConnectError(err))
    }
    const onConnectClose = () => {
      settleReject(
        new SshError('UNREACHABLE', 'Connection closed before the session was ready')
      )
    }

    client.once('error', onConnectError)
    client.once('close', onConnectClose)
    client.once('ready', () => {
      if (settled) return
      settled = true
      client.removeListener('error', onConnectError)
      client.removeListener('close', onConnectClose)
      // Post-ready failures surface via 'close'; 'error' still needs a listener.
      client.on('error', () => {})
      client.on('close', () => {
        sessions.delete(sessionId)
      })
      sessions.set(sessionId, { client })
      resolve(sessionId)
    })

    let privateKey: string | undefined
    try {
      privateKey = resolvePrivateKey(config)
    } catch (err) {
      // The key file could not be read: fail before touching the network.
      settleReject(err as SshError)
      return
    }

    const connectConfig: ConnectConfig = {
      host: config.host,
      port: config.port,
      username: config.username,
      readyTimeout: options?.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
    }
    if (privateKey) {
      connectConfig.privateKey = privateKey
      if (config.passphrase) connectConfig.passphrase = config.passphrase
    } else if (config.password !== undefined) {
      connectConfig.password = config.password
    }

    try {
      client.connect(connectConfig)
    } catch (err) {
      // Structurally invalid config throws synchronously instead of emitting.
      settleReject(
        new SshError('UNREACHABLE', `Failed to initiate connection: ${(err as Error).message}`)
      )
    }
  })
}

/**
 * Opens the session's interactive shell with a pseudo-TTY. One shell per
 * session; resolves once the channel is up. Output (stdout and stderr
 * merged) streams to callbacks.onData; remote exit fires callbacks.onClose.
 */
export function openShell(
  sessionId: string,
  size: ShellSize,
  callbacks: ShellCallbacks
): Promise<void> {
  return new Promise((resolve, reject) => {
    let record: SessionRecord
    try {
      record = requireRecord(sessionId)
    } catch (err) {
      reject(err) // unknown session: reject asynchronously like other failures
      return
    }
    if (record.shell) {
      reject(new SshError('REMOTE_ERROR', 'A shell is already open for this session'))
      return
    }
    record.client.shell(
      { cols: size.cols, rows: size.rows, term: 'xterm-256color' },
      (err, channel) => {
        if (err) {
          reject(new SshError('REMOTE_ERROR', `Failed to open shell: ${err.message}`))
          return
        }
        record.shell = channel
        channel.on('data', (chunk: Buffer) => callbacks.onData(chunk.toString('utf8')))
        channel.stderr.on('data', (chunk: Buffer) => callbacks.onData(chunk.toString('utf8')))
        channel.once('close', () => {
          if (record.shell === channel) record.shell = undefined
          callbacks.onClose()
        })
        resolve()
      }
    )
  })
}

/** Writes raw input to the session's open shell. Throws when no shell is open. */
export function writeToShell(sessionId: string, data: string): void {
  const record = requireRecord(sessionId)
  if (!record.shell) {
    throw new SshError('REMOTE_ERROR', 'No open shell for this session')
  }
  record.shell.write(data)
}

/** Resizes the session's pseudo-TTY. Throws when no shell is open. */
export function resizeShell(sessionId: string, cols: number, rows: number): void {
  const record = requireRecord(sessionId)
  if (!record.shell) {
    throw new SshError('REMOTE_ERROR', 'No open shell for this session')
  }
  record.shell.setWindow(rows, cols, 0, 0)
}

/** Closes the session and its connection. Throws on an unknown/closed id. */
export function closeSession(sessionId: string): void {
  const record = sessions.get(sessionId)
  if (!record) {
    throw new SshError('SESSION_NOT_FOUND', `Unknown or closed session: ${sessionId}`)
  }
  sessions.delete(sessionId)
  record.client.end()
}

/** Closes every open session. Idempotent. */
export function closeAll(): void {
  for (const record of sessions.values()) {
    record.client.end()
  }
  sessions.clear()
}

/** Internal: connection lookup shared with the SFTP service. */
export function getSessionClient(sessionId: string): Client {
  return requireRecord(sessionId).client
}
