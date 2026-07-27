/**
 * Tests for the SetEncodings rewriter in the VNC bridge (src/main/vncBridge.ts).
 *
 * A mock RFB server speaks the None handshake, then captures the raw client
 * byte stream; a minimal WebSocket client drives the bridge through its
 * synthesized handshake and then sends crafted RFB client messages.
 */

import { afterAll, describe, expect, it } from 'vitest'
import net, { type AddressInfo } from 'node:net'
import { WebSocket, type RawData } from 'ws'
import { ChunkReader } from '../src/main/rfb/handshake'
import { startVncBridge, type VncBridge } from '../src/main/vncBridge'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const activeServers: net.Server[] = []
const activeSockets = new Set<net.Socket>()
const activeBridges: VncBridge[] = []

afterAll(async () => {
  await Promise.all(activeBridges.map((bridge) => bridge.close()))
  for (const socket of activeSockets) socket.destroy()
  await Promise.all(
    activeServers.map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve()
            return
          }
          server.close(() => resolve())
        })
    )
  )
})

function buildServerInit(width: number, height: number, name: string): Buffer {
  const nameBytes = Buffer.from(name, 'utf8')
  const buf = Buffer.alloc(24 + nameBytes.length)
  buf.writeUInt16BE(width, 0)
  buf.writeUInt16BE(height, 2)
  buf[4] = 32
  buf[5] = 24
  buf[6] = 0
  buf[7] = 1
  buf.writeUInt16BE(255, 8)
  buf.writeUInt16BE(255, 10)
  buf.writeUInt16BE(255, 12)
  buf[14] = 16
  buf[15] = 8
  buf[16] = 0
  buf.writeUInt32BE(nameBytes.length, 20)
  nameBytes.copy(buf, 24)
  return buf
}

/** Accumulates bytes arriving at the mock server after the handshake. */
class ByteCapture {
  private chunks: Buffer[] = []
  private waiters: Array<{ n: number; resolve: (b: Buffer) => void }> = []

  push(chunk: Buffer): void {
    this.chunks.push(chunk)
    this.flush()
  }

  /** Resolves with the first n received bytes (keeps the rest buffered). */
  take(n: number): Promise<Buffer> {
    return new Promise((resolve) => {
      this.waiters.push({ n, resolve })
      this.flush()
    })
  }

  private flush(): void {
    const total = this.chunks.reduce((sum, c) => sum + c.length, 0)
    if (this.waiters.length === 0) return
    const { n, resolve } = this.waiters[0]
    if (total < n) return
    this.waiters.shift()
    const all = Buffer.concat(this.chunks)
    this.chunks = [all.subarray(n)]
    resolve(all.subarray(0, n))
  }
}

/** Starts a mock RFB server (None security) that captures post-handshake bytes. */
function startMockServer(
  serverInit: Buffer
): Promise<{ port: number; capture: ByteCapture }> {
  const capture = new ByteCapture()
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      activeSockets.add(socket)
      socket.on('close', () => activeSockets.delete(socket))
      socket.on('error', () => {})
      const reader = new ChunkReader()
      const onData = (chunk: Buffer) => reader.push(chunk)
      socket.on('data', onData)
      ;(async () => {
        socket.write('RFB 003.008\n')
        await reader.read(12) // client version
        socket.write(Buffer.from([1, 1])) // one security type: None
        await reader.read(1) // selection
        socket.write(Buffer.from([0, 0, 0, 0])) // SecurityResult OK
        await reader.read(1) // ClientInit
        socket.write(serverInit)
        socket.off('data', onData)
        socket.on('data', (chunk: Buffer) => capture.push(chunk))
      })().catch(() => socket.destroy())
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      activeServers.push(server)
      resolve({ port: (server.address() as AddressInfo).port, capture })
    })
  })
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

/** Minimal client: completes the bridge's synthesized handshake, then pipes. */
async function handshakeOverWs(ws: WebSocket, reader: ChunkReader): Promise<void> {
  await reader.read(12) // RFB 003.008
  ws.send(Buffer.from('RFB 003.008\n', 'latin1'))
  await reader.read(2) // [1, None]
  ws.send(Buffer.from([1]))
  await reader.read(4) // SecurityResult OK
  ws.send(Buffer.from([1])) // ClientInit
  const head = await reader.read(24)
  await reader.read(head.readUInt32BE(20)) // desktop name
}

function connectWsClient(port: number): { ws: WebSocket; reader: ChunkReader } {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, ['binary'])
  const reader = new ChunkReader()
  ws.on('message', (data: RawData) => reader.push(toBuffer(data)))
  ws.on('close', () => reader.fail(new Error('ws closed')))
  return { ws, reader }
}

/** SetEncodings: [Raw, ZRLE, cursor pseudo-encoding]. */
const CLIENT_SET_ENCODINGS = Buffer.concat([
  Buffer.from([2, 0, 0, 3]),
  Buffer.from([0, 0, 0, 0]), // 0 Raw
  Buffer.from([0, 0, 0, 16]), // 16 ZRLE
  Buffer.from([0xff, 0xff, 0xff, 0x11]) // -239 cursor pseudo-encoding
])

/** With preference [16]: [CopyRect, ZRLE, Raw] + pseudo-encodings preserved. */
const EXPECTED_REWRITTEN = Buffer.concat([
  Buffer.from([2, 0, 0, 4]),
  Buffer.from([0, 0, 0, 1]), // 1 CopyRect
  Buffer.from([0, 0, 0, 16]), // 16 ZRLE
  Buffer.from([0, 0, 0, 0]), // 0 Raw fallback
  Buffer.from([0xff, 0xff, 0xff, 0x11]) // -239 preserved
])

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SetEncodings rewriter', () => {
  it('passes SetEncodings through unchanged when no preference is set', async () => {
    const { port, capture } = await startMockServer(buildServerInit(800, 600, 'enc-auto'))
    const bridge = await startVncBridge({ host: '127.0.0.1', port })
    activeBridges.push(bridge)

    const { ws, reader } = connectWsClient(bridge.wsPort)
    await handshakeOverWs(ws, reader)
    ws.send(CLIENT_SET_ENCODINGS)

    expect(await capture.take(CLIENT_SET_ENCODINGS.length)).toEqual(CLIENT_SET_ENCODINGS)
    ws.close()
  })

  it('rewrites SetEncodings to preference + Raw fallback, preserving pseudo-encodings', async () => {
    const { port, capture } = await startMockServer(buildServerInit(800, 600, 'enc-zrle'))
    const bridge = await startVncBridge({ host: '127.0.0.1', port, encodings: [16] })
    activeBridges.push(bridge)

    const { ws, reader } = connectWsClient(bridge.wsPort)
    await handshakeOverWs(ws, reader)
    ws.send(CLIENT_SET_ENCODINGS)

    expect(await capture.take(EXPECTED_REWRITTEN.length)).toEqual(EXPECTED_REWRITTEN)
    ws.close()
  })

  it('rewrites correctly when SetEncodings is split across WS frames', async () => {
    const { port, capture } = await startMockServer(buildServerInit(800, 600, 'enc-split'))
    const bridge = await startVncBridge({ host: '127.0.0.1', port, encodings: [16] })
    activeBridges.push(bridge)

    const { ws, reader } = connectWsClient(bridge.wsPort)
    await handshakeOverWs(ws, reader)
    ws.send(CLIENT_SET_ENCODINGS.subarray(0, 5))
    await new Promise((resolve) => setTimeout(resolve, 50))
    ws.send(CLIENT_SET_ENCODINGS.subarray(5))

    expect(await capture.take(EXPECTED_REWRITTEN.length)).toEqual(EXPECTED_REWRITTEN)
    ws.close()
  })

  it('fails open on an unknown message type: everything passes verbatim afterwards', async () => {
    const { port, capture } = await startMockServer(buildServerInit(800, 600, 'enc-failopen'))
    const bridge = await startVncBridge({ host: '127.0.0.1', port, encodings: [16] })
    activeBridges.push(bridge)

    const { ws, reader } = connectWsClient(bridge.wsPort)
    await handshakeOverWs(ws, reader)

    const unknownMessage = Buffer.from([0x77, 0x01, 0x02, 0x03, 0x04])
    ws.send(unknownMessage)
    ws.send(CLIENT_SET_ENCODINGS) // must NOT be rewritten after fail-open

    const expected = Buffer.concat([unknownMessage, CLIENT_SET_ENCODINGS])
    expect(await capture.take(expected.length)).toEqual(expected)

    // The session itself stays alive: more bytes still flow through.
    const more = Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]) // FBURequest
    ws.send(more)
    expect(await capture.take(more.length)).toEqual(more)
    ws.close()
  })
})
