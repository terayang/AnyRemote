/**
 * Local WebSocket <-> TCP bridge for noVNC (stage 5).
 *
 * The bridge terminates the RFB security handshake in the main process: on
 * each WebSocket connection it opens a TCP connection to the VNC target,
 * authenticates (Apple DH / VNC auth / None), then replays a synthesized
 * handshake to the noVNC client presenting security type None:
 *
 *   bridge -> noVNC:  'RFB 003.008\n'
 *   noVNC  -> bridge: client version (validated, value ignored)
 *   bridge -> noVNC:  security types [1] = [None]
 *   noVNC  -> bridge: selected type (must be 1)
 *   bridge -> noVNC:  SecurityResult OK
 *   noVNC  -> bridge: ClientInit
 *   bridge -> noVNC:  the target's real ServerInit, verbatim
 *
 * Afterwards frames are relayed transparently in both directions — with one
 * exception: when `encodings` is given, the client->server direction goes
 * through an incremental RFB client-message parser that rewrites
 * SetEncodings messages to prefer the configured pixel encodings (CopyRect +
 * preference + Raw fallback, pseudo-encodings preserved). The parser is
 * fail-open: an unknown message type permanently disables rewriting for that
 * connection and the stream falls back to pure passthrough, never breaking
 * the session over a parse failure.
 *
 * Single-client semantics: a bridge instance serves ONE VNC session. A
 * second WebSocket client connecting while one is active is rejected with
 * close code 1013 and a 'busy' payload (no queueing). Failures before the
 * pipe phase close the socket with a structured VncBridgeError reason.
 */

import net from 'node:net'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import { ChunkReader, performRfbHandshake } from './rfb/handshake'
import { RfbAuthError, RfbProtocolError, RfbTimeoutError, SEC_TYPE_NONE } from './rfb/types'
import {
  VNC_BRIDGE_CLOSE_CODES,
  type VncBridgeError,
  type VncBridgeErrorKind,
  type VncCredentials
} from '../shared/vnc'

const DEFAULT_TIMEOUT_MS = 10_000

export interface VncBridgeOptions extends VncCredentials {
  host: string
  port: number
  /** TCP connect + RFB handshake deadline in ms (default 10000). */
  timeoutMs?: number
  /**
   * Pixel-encoding preference (RFB encoding numbers, e.g. [16] = ZRLE). When
   * set, client SetEncodings messages are rewritten to prefer these
   * encodings; undefined = passthrough without rewriting.
   */
  encodings?: number[]
}

export interface VncBridge {
  /** Loopback port the WebSocket server listens on (random). */
  wsPort: number
  /** Terminates clients, destroys TCP sockets and closes the server. */
  close(): Promise<void>
}

/** Starts a bridge on 127.0.0.1 with a random port; resolves once listening. */
export function startVncBridge(options: VncBridgeOptions): Promise<VncBridge> {
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    perMessageDeflate: false,
    // noVNC offers the 'binary' subprotocol; echo it back when requested.
    handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false)
  })
  const clients = new Set<WebSocket>()
  let activeClient: WebSocket | undefined

  wss.on('connection', (ws) => {
    if (activeClient) {
      closeWithError(ws, 'busy', new Error('bridge already serves another client'))
      return
    }
    activeClient = ws
    clients.add(ws)
    void serveClient(ws, options).finally(() => {
      clients.delete(ws)
      if (activeClient === ws) activeClient = undefined
    })
  })

  return new Promise((resolve, reject) => {
    wss.once('error', reject)
    wss.once('listening', () => {
      const address = wss.address()
      if (address && typeof address === 'object') {
        resolve({
          wsPort: address.port,
          close: () =>
            new Promise<void>((done) => {
              for (const client of clients) client.terminate()
              wss.close(() => done())
            })
        })
      } else {
        reject(new Error('bridge has no listening address'))
      }
    })
  })
}

/** Handles one WebSocket client from connect through auth to the pipe phase. */
async function serveClient(ws: WebSocket, options: VncBridgeOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const reader = new ChunkReader()
  const feed = (data: RawData) => reader.push(toBuffer(data))
  ws.on('message', feed)
  ws.once('close', () => reader.fail(new Error('client disconnected')))

  let socket: net.Socket | undefined
  try {
    const tcp = await connectTcp(options.host, options.port, timeoutMs)
    socket = tcp
    const serverInit = await performRfbHandshake(tcp, {
      username: options.username,
      password: options.password,
      timeoutMs
    })
    await presentServerSideHandshake(reader, ws, serverInit.raw)

    // Pipe phase. The client may have coalesced ClientInit with its first
    // protocol message; forward any such leftover before switching modes.
    // With an encoding preference configured, the client->server direction
    // runs through the SetEncodings rewriter from the leftover on.
    const rewriter =
      options.encodings === undefined ? null : new SetEncodingsRewriter(options.encodings)
    const forward = (chunk: Buffer): void => {
      if (rewriter === null) {
        tcp.write(chunk)
        return
      }
      for (const out of rewriter.push(chunk)) tcp.write(out)
    }
    const leftover = reader.drainBuffer()
    if (leftover.length > 0) forward(leftover)
    ws.off('message', feed)
    ws.on('message', (data: RawData) => forward(toBuffer(data)))
    tcp.on('data', (chunk: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk)
    })
    tcp.once('error', () => tcp.destroy())

    await new Promise<void>((resolve) => {
      ws.once('close', resolve)
      tcp.once('close', resolve)
    })
  } catch (err) {
    closeWithError(ws, classifyError(err), err)
  } finally {
    socket?.destroy()
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(1000)
    }
  }
}

/** Replays the synthesized None-security handshake towards the noVNC client. */
async function presentServerSideHandshake(
  reader: ChunkReader,
  ws: WebSocket,
  serverInitRaw: Uint8Array
): Promise<void> {
  ws.send(Buffer.from('RFB 003.008\n', 'latin1'))
  const banner = (await reader.read(12)).toString('latin1')
  if (!/^RFB \d{3}\.\d{3}\n$/.test(banner)) {
    throw new RfbProtocolError(`bridge client sent invalid RFB version ${JSON.stringify(banner)}`)
  }
  ws.send(Buffer.from([1, SEC_TYPE_NONE])) // exactly one offered type: None
  const selection = (await reader.read(1))[0]
  if (selection !== SEC_TYPE_NONE) {
    throw new RfbProtocolError(`bridge client selected unsupported security type ${selection}`)
  }
  ws.send(Buffer.from([0, 0, 0, 0])) // SecurityResult: OK
  await reader.read(1) // ClientInit (shared flag, value ignored)
  ws.send(Buffer.from(serverInitRaw))
}

function connectTcp(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new RfbTimeoutError(`connect to ${host}:${port} timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

function classifyError(err: unknown): VncBridgeErrorKind {
  if (err instanceof RfbAuthError) return 'auth'
  if (err instanceof RfbTimeoutError) return 'timeout'
  if (err instanceof RfbProtocolError) return 'protocol'
  return 'connection' // RfbConnectionError, ECONNREFUSED and other socket errors
}

/** Closes the WebSocket with the mapped code and a JSON VncBridgeError reason. */
function closeWithError(ws: WebSocket, kind: VncBridgeErrorKind, err: unknown): void {
  if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) return
  const payload: VncBridgeError = {
    kind,
    // WS close reasons are limited to 123 UTF-8 bytes; keep the message short.
    message: (err instanceof Error ? err.message : String(err)).slice(0, 80)
  }
  ws.close(VNC_BRIDGE_CLOSE_CODES[kind], JSON.stringify(payload))
}

// ---------------------------------------------------------------------------
// SetEncodings rewriter (client -> server, pipe phase)
// ---------------------------------------------------------------------------

/** Fixed lengths of the RFB client messages the parser understands. */
const CLIENT_MESSAGE_LENGTH: Readonly<Record<number, number>> = {
  0: 20, // SetPixelFormat: type + pad(3) + pixel-format(16)
  3: 10, // FramebufferUpdateRequest
  4: 8, // KeyEvent
  5: 6 // PointerEvent
}

const ENCODING_COPYRECT = 1
const ENCODING_RAW = 0

/**
 * Incremental RFB client-message parser that rewrites SetEncodings messages
 * to prefer a configured pixel-encoding list. Only message boundaries are
 * tracked; all other messages pass through untouched.
 *
 * Fail-open: an unknown message type permanently disables rewriting for the
 * connection — buffered bytes are forwarded verbatim and the stream degrades
 * to pure passthrough, never breaking the session over a parse failure.
 */
class SetEncodingsRewriter {
  private readonly preference: number[]
  private buffer: Buffer = Buffer.alloc(0)
  private disabled = false

  constructor(preference: number[]) {
    this.preference = preference
  }

  /** Feeds bytes; returns the chunks to forward (rewrite applied). */
  push(chunk: Buffer): Buffer[] {
    if (this.disabled) return [chunk]
    this.buffer = Buffer.concat([this.buffer, chunk])
    const out: Buffer[] = []
    for (;;) {
      const message = this.takeMessage()
      if (message === null) break
      out.push(message)
    }
    return out
  }

  /** Extracts one complete message from the buffer, or null when incomplete. */
  private takeMessage(): Buffer | null {
    const buf = this.buffer
    if (buf.length === 0) return null
    const type = buf[0]

    if (type === 2) {
      // SetEncodings: type + pad + count(2) + count*4
      if (buf.length < 4) return null
      const length = 4 + buf.readUInt16BE(2) * 4
      if (buf.length < length) return null
      const rewritten = this.rewriteSetEncodings(buf.subarray(0, length))
      this.buffer = buf.subarray(length)
      return rewritten
    }

    let length: number
    if (type === 6) {
      // ClientCutText: type + pad(3) + length(4) + text
      if (buf.length < 8) return null
      length = 8 + buf.readUInt32BE(4)
    } else {
      length = CLIENT_MESSAGE_LENGTH[type] ?? -1
    }

    if (length === -1) {
      this.disabled = true
      const rest = this.buffer
      this.buffer = Buffer.alloc(0)
      return rest.length > 0 ? rest : null
    }
    if (buf.length < length) return null
    this.buffer = buf.subarray(length)
    return buf.subarray(0, length)
  }

  /**
   * Rebuilds a SetEncodings message: CopyRect + preference + Raw fallback,
   * with the client's pseudo-encodings (negative / >255 values) preserved in
   * their original order.
   */
  private rewriteSetEncodings(message: Buffer): Buffer {
    const count = message.readUInt16BE(2)
    const pseudo: number[] = []
    for (let i = 0; i < count; i++) {
      const enc = message.readInt32BE(4 + i * 4)
      if (enc < 0 || enc > 255) pseudo.push(enc)
    }
    const pixel = [ENCODING_COPYRECT, ...this.preference]
    if (!this.preference.includes(ENCODING_RAW)) pixel.push(ENCODING_RAW)
    const all = [...pixel, ...pseudo]
    const out = Buffer.alloc(4 + all.length * 4)
    out[0] = 2
    out.writeUInt16BE(all.length, 2)
    all.forEach((enc, i) => out.writeInt32BE(enc, 4 + i * 4))
    return out
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}
