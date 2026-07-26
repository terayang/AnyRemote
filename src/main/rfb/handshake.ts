/**
 * Client-side RFB handshake up to and including ServerInit parsing.
 *
 * Flow (RFB 3.8): version exchange -> security type list -> select and run
 * one of type 1 (None) / 2 (VNC auth) / 30 (Apple DH) -> SecurityResult ->
 * ClientInit -> ServerInit. RFB 3.3 servers (single U32 security type, no
 * SecurityResult for None) are handled too; versions above 3.8 — including
 * Apple's 3.889 — are clamped to 3.8 exactly like TigerVNC's CConnection.
 *
 * Everything here is Electron-free so vitest can exercise it directly.
 */

import type net from 'node:net'
import { performAppleDhAuth } from './appleDh'
import { encryptVncChallenge } from './vncAuth'
import {
  RfbAuthError,
  RfbConnectionError,
  RfbProtocolError,
  RfbTimeoutError,
  SEC_TYPE_APPLE_DH,
  SEC_TYPE_NONE,
  SEC_TYPE_VNC_AUTH
} from './types'
import type { ServerInitInfo, VncCredentials, VncPixelFormat } from '../../shared/vnc'

const DEFAULT_TIMEOUT_MS = 10_000

export interface RfbHandshakeOptions extends VncCredentials {
  /** Overall handshake deadline in ms (default 10000). */
  timeoutMs?: number
}

export interface RfbHandshakeResult extends ServerInitInfo {
  /** Version the server advertised, e.g. '003.889'. */
  serverVersion: string
  /** Security type that authenticated the session (1, 2 or 30). */
  securityType: number
}

export interface RfbSecurityProbe {
  serverVersion: string
  /** Security types offered by the server (e.g. [30, 33, 35, 36] on macOS). */
  securityTypes: number[]
}

/**
 * Ordered byte buffer over a stream of chunks. Data is pushed in from the
 * transport and consumed with exact-size async reads. Transport-agnostic —
 * used for the TCP socket and (by vncBridge) for WebSocket messages.
 */
export class ChunkReader {
  private chunks: Buffer[] = []
  private buffered = 0
  private pending: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void }[] = []
  private failure: Error | undefined

  push(chunk: Buffer): void {
    if (this.failure || chunk.length === 0) return
    this.chunks.push(chunk)
    this.buffered += chunk.length
    this.drain()
  }

  /** Rejects all current and future reads (socket error / close). */
  fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    for (const waiter of this.pending.splice(0)) waiter.reject(error)
  }

  read(n: number): Promise<Buffer> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.buffered >= n) return Promise.resolve(this.take(n))
    return new Promise((resolve, reject) => this.pending.push({ n, resolve, reject }))
  }

  /** Returns and clears buffered-but-unread bytes (post-handshake flush). */
  drainBuffer(): Buffer {
    const rest = Buffer.concat(this.chunks)
    this.chunks = []
    this.buffered = 0
    return rest
  }

  private drain(): void {
    while (this.pending.length > 0 && this.buffered >= this.pending[0].n) {
      const waiter = this.pending.shift() as (typeof this.pending)[number]
      waiter.resolve(this.take(waiter.n))
    }
  }

  private take(n: number): Buffer {
    const out = Buffer.allocUnsafe(n)
    let offset = 0
    while (offset < n) {
      const head = this.chunks[0]
      const needed = n - offset
      if (head.length <= needed) {
        head.copy(out, offset)
        offset += head.length
        this.chunks.shift()
        this.buffered -= head.length
      } else {
        head.copy(out, offset, 0, needed)
        this.chunks[0] = head.subarray(needed)
        this.buffered -= needed
        offset = n
      }
    }
    return out
  }
}

/**
 * Performs the full client handshake on an already-connected socket.
 * Resolves with the parsed ServerInit once the server is ready for normal
 * RFB traffic; rejects with RfbAuthError / RfbProtocolError / RfbTimeoutError
 * / RfbConnectionError. The socket stays open on success.
 */
export function performRfbHandshake(
  socket: net.Socket,
  options: RfbHandshakeOptions = {}
): Promise<RfbHandshakeResult> {
  return runWithTimeout(socket, options.timeoutMs, async (reader) => {
    const { serverVersion, minor } = await negotiateVersion(reader, socket)
    const offered = await readSecurityTypes(reader, minor)
    const hasPassword = typeof options.password === 'string' && options.password.length > 0
    const type =
      minor === 3 ? validateV33Type(offered[0]) : selectSecurityType(offered, hasPassword)
    if (minor !== 3) socket.write(Buffer.from([type])) // 3.3: server dictates, no selection
    await performAuth(reader, socket, type, options, minor)
    socket.write(Buffer.from([1])) // ClientInit: shared session
    const serverInit = await readServerInit(reader)
    return { ...serverInit, serverVersion, securityType: type }
  })
}

/**
 * Version exchange + security type list only — used by diagnostics and the
 * integration test to inspect a server without committing to auth. The
 * socket is left open; the caller should destroy it.
 */
export function probeRfbSecurityTypes(
  socket: net.Socket,
  timeoutMs?: number
): Promise<RfbSecurityProbe> {
  return runWithTimeout(socket, timeoutMs, async (reader) => {
    const { serverVersion, minor } = await negotiateVersion(reader, socket)
    return { serverVersion, securityTypes: await readSecurityTypes(reader, minor) }
  })
}

/** Attaches a ChunkReader to the socket and races the phase against a deadline. */
async function runWithTimeout<T>(
  socket: net.Socket,
  timeoutMs: number | undefined,
  phase: (reader: ChunkReader) => Promise<T>
): Promise<T> {
  const reader = new ChunkReader()
  const onData = (chunk: Buffer) => reader.push(chunk)
  const onError = (err: Error) =>
    reader.fail(new RfbConnectionError(`socket error during handshake: ${err.message}`))
  const onClose = () => reader.fail(new RfbConnectionError('connection closed during handshake'))
  socket.on('data', onData)
  socket.once('error', onError)
  socket.once('close', onClose)

  const limit = timeoutMs ?? DEFAULT_TIMEOUT_MS
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      socket.destroy()
      reject(new RfbTimeoutError(`RFB handshake timed out after ${limit} ms`))
    }, limit)
  })
  try {
    return await Promise.race([phase(reader), timeout])
  } finally {
    if (timer) clearTimeout(timer)
    socket.off('data', onData)
    socket.off('error', onError)
    socket.off('close', onClose)
  }
}

/** Reads the server banner, clamps to 3.3/3.7/3.8 like TigerVNC, replies. */
async function negotiateVersion(
  reader: ChunkReader,
  socket: net.Socket
): Promise<{ serverVersion: string; minor: number }> {
  const banner = (await reader.read(12)).toString('latin1')
  const match = /^RFB (\d{3})\.(\d{3})\n$/.exec(banner)
  if (!match) {
    throw new RfbProtocolError(`not an RFB server (banner: ${JSON.stringify(banner)})`)
  }
  const major = Number(match[1])
  const serverMinor = Number(match[2])
  if (major !== 3 || serverMinor < 3) {
    throw new RfbProtocolError(`unsupported RFB version ${match[1]}.${match[2]}`)
  }
  // 3.3..3.6 downgrade to 3.3; anything above 3.8 (e.g. Apple's 3.889) -> 3.8.
  const minor = serverMinor < 7 ? 3 : serverMinor > 8 ? 8 : serverMinor
  socket.write(`RFB 003.00${minor}\n`)
  return { serverVersion: `${match[1]}.${match[2]}`, minor }
}

/** Reads the offered security types (single U32 in 3.3, count+list in 3.7+). */
async function readSecurityTypes(reader: ChunkReader, minor: number): Promise<number[]> {
  if (minor === 3) {
    const type = (await reader.read(4)).readUInt32BE(0)
    if (type === 0) {
      throw new RfbProtocolError(`server refused connection: ${await readReason(reader)}`)
    }
    return [type]
  }
  const count = (await reader.read(1))[0]
  if (count === 0) {
    throw new RfbProtocolError(`server refused connection: ${await readReason(reader)}`)
  }
  return [...(await reader.read(count))]
}

/** Reads a U32-length-prefixed reason string (3.8 failure messages). */
async function readReason(reader: ChunkReader): Promise<string> {
  const length = (await reader.read(4)).readUInt32BE(0)
  if (length === 0) return '(no reason given)'
  return (await reader.read(length)).toString('utf8')
}

/** Picks the best offered type: authenticated types win when we have a password. */
function selectSecurityType(offered: number[], hasPassword: boolean): number {
  if (hasPassword && offered.includes(SEC_TYPE_APPLE_DH)) return SEC_TYPE_APPLE_DH
  if (hasPassword && offered.includes(SEC_TYPE_VNC_AUTH)) return SEC_TYPE_VNC_AUTH
  if (offered.includes(SEC_TYPE_NONE)) return SEC_TYPE_NONE
  if (offered.includes(SEC_TYPE_APPLE_DH) || offered.includes(SEC_TYPE_VNC_AUTH)) {
    throw new RfbAuthError('server requires authentication but no password was provided')
  }
  throw new RfbProtocolError(`no supported security type in server list [${offered.join(', ')}]`)
}

function validateV33Type(type: number): number {
  if (type === SEC_TYPE_NONE || type === SEC_TYPE_VNC_AUTH) return type
  throw new RfbProtocolError(`RFB 3.3 server demanded unsupported security type ${type}`)
}

/** Runs the selected security exchange and evaluates the SecurityResult. */
async function performAuth(
  reader: ChunkReader,
  socket: net.Socket,
  type: number,
  credentials: VncCredentials,
  minor: number
): Promise<void> {
  switch (type) {
    case SEC_TYPE_NONE:
      break
    case SEC_TYPE_VNC_AUTH: {
      const challenge = await reader.read(16)
      socket.write(encryptVncChallenge(challenge, credentials.password ?? ''))
      break
    }
    case SEC_TYPE_APPLE_DH:
      await performAppleDhAuth(reader, socket, credentials)
      break
    /* istanbul ignore next -- unreachable: callers validate the type */
    default:
      throw new RfbProtocolError(`unsupported security type ${type}`)
  }
  if (minor === 3 && type === SEC_TYPE_NONE) return // RFB 3.3 + None: no SecurityResult
  const result = (await reader.read(4)).readUInt32BE(0)
  if (result !== 0) {
    const reason = minor >= 8 ? await readReason(reader) : 'authentication failed'
    throw new RfbAuthError(reason)
  }
}

/** Parses the ServerInit message following ClientInit. */
async function readServerInit(reader: ChunkReader): Promise<ServerInitInfo> {
  const head = await reader.read(24)
  const nameBytes = await reader.read(head.readUInt32BE(20))
  const pf = head.subarray(4, 20)
  const pixelFormat: VncPixelFormat = {
    bitsPerPixel: pf[0],
    depth: pf[1],
    bigEndian: pf[2] !== 0,
    trueColor: pf[3] !== 0,
    redMax: pf.readUInt16BE(4),
    greenMax: pf.readUInt16BE(6),
    blueMax: pf.readUInt16BE(8),
    redShift: pf[10],
    greenShift: pf[11],
    blueShift: pf[12]
  }
  return {
    width: head.readUInt16BE(0),
    height: head.readUInt16BE(2),
    pixelFormat,
    name: nameBytes.toString('utf8'),
    raw: Buffer.concat([head, nameBytes])
  }
}
