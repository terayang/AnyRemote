/**
 * Tests for the WebSocket VNC bridge (src/main/vncBridge.ts).
 *
 * A fake noVNC client speaks the minimal RFB handshake over WebSocket and
 * checks the synthesized None-security replay plus byte-exact passthrough.
 * The integration block at the bottom self-skips unless macOS Screen
 * Sharing is reachable on 127.0.0.1:5900 (dev machine, see AGENTS.md).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import net, { type AddressInfo } from 'node:net'
import { WebSocket, type RawData } from 'ws'
import { ChunkReader, performRfbHandshake, probeRfbSecurityTypes } from '../src/main/rfb/handshake'
import { RfbAuthError, RfbProtocolError, RfbTimeoutError } from '../src/main/rfb/types'
import { startVncBridge, type VncBridge } from '../src/main/vncBridge'
import { VNC_BRIDGE_CLOSE_CODES, type VncBridgeError } from '../src/shared/vnc'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const activeServers: net.Server[] = []
const activeSockets = new Set<net.Socket>()
const activeBridges: VncBridge[] = []

type ServerScript = (socket: net.Socket, reader: ChunkReader) => Promise<void>

function startMockServer(script: ServerScript): Promise<{ port: number; server: net.Server }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      activeSockets.add(socket)
      socket.on('close', () => activeSockets.delete(socket))
      socket.on('error', () => {})
      const reader = new ChunkReader()
      socket.on('data', (chunk: Buffer) => reader.push(chunk))
      socket.on('close', () => reader.fail(new Error('client disconnected')))
      script(socket, reader).catch(() => socket.destroy())
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      activeServers.push(server)
      resolve({ port: (server.address() as AddressInfo).port, server })
    })
  })
}

async function startBridge(options: Parameters<typeof startVncBridge>[0]): Promise<VncBridge> {
  const bridge = await startVncBridge(options)
  activeBridges.push(bridge)
  return bridge
}

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

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

/** Minimal noVNC stand-in: speaks the client side of the replayed handshake. */
class NoVncClient {
  readonly ws: WebSocket
  readonly reader = new ChunkReader()
  readonly closed: Promise<{ code: number; reason: string }>

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`, ['binary'])
    this.ws.on('message', (data: RawData) => this.reader.push(toBuffer(data)))
    this.ws.on('close', () => this.reader.fail(new Error('ws closed')))
    this.closed = new Promise((resolve) => {
      this.ws.once('close', (code: number, reason: Buffer) => {
        resolve({ code, reason: reason.toString('utf8') })
      })
    })
  }

  /** Runs the client side of the synthesized handshake; asserts every step. */
  async expectHandshake(expectedServerInit: Buffer): Promise<void> {
    const version = await this.reader.read(12)
    expect(version.toString('latin1')).toBe('RFB 003.008\n')
    this.ws.send(Buffer.from('RFB 003.008\n', 'latin1'))
    const types = await this.reader.read(2)
    expect([...types]).toEqual([1, 1]) // exactly one type offered: None
    this.ws.send(Buffer.from([1]))
    expect((await this.reader.read(4)).readUInt32BE(0)).toBe(0) // SecurityResult OK
    this.ws.send(Buffer.from([1])) // ClientInit
    const head = await this.reader.read(24)
    const name = await this.reader.read(head.readUInt32BE(20))
    expect(Buffer.concat([head, name]).equals(expectedServerInit)).toBe(true)
  }
}

// ---------------------------------------------------------------------------
// Bridge behavior
// ---------------------------------------------------------------------------

describe('startVncBridge', () => {
  it('bridges a None server and passes bytes through verbatim', async () => {
    const serverInit = buildServerInit(1440, 900, 'bridge-none')
    let fixtureSocket: net.Socket | undefined
    let onFirstClientData: ((chunk: Buffer) => void) | undefined
    const firstClientData = new Promise<Buffer>((resolve) => {
      onFirstClientData = resolve
    })
    const { port } = await startMockServer(async (socket, reader) => {
      fixtureSocket = socket
      socket.write('RFB 003.008\n')
      await reader.read(12)
      socket.write(Buffer.from([1, 1]))
      await reader.read(1)
      socket.write(Buffer.from([0, 0, 0, 0]))
      await reader.read(1)
      socket.write(serverInit)
      socket.on('data', (chunk: Buffer) => onFirstClientData?.(chunk))
    })
    const bridge = await startBridge({ host: '127.0.0.1', port })

    const client = new NoVncClient(bridge.wsPort)
    await client.expectHandshake(serverInit)
    expect(client.ws.protocol).toBe('binary') // subprotocol is echoed back

    // TCP -> WS direction: server bytes arrive at the client untouched.
    const downlink = crypto.randomBytes(64)
    fixtureSocket!.write(downlink)
    expect(await client.reader.read(downlink.length)).toEqual(downlink)

    // WS -> TCP direction: client frames arrive at the server untouched.
    const uplink = crypto.randomBytes(48)
    client.ws.send(uplink)
    expect(await firstClientData).toEqual(uplink)

    client.ws.close()
    await client.closed
  })

  it('authenticates Apple DH upstream and replays None to the client', async () => {
    const serverInit = buildServerInit(2560, 1440, 'mac-studio')
    const seen: { username?: string; password?: string } = {}
    let fixtureSocket: net.Socket | undefined
    const { port } = await startMockServer(async (socket, reader) => {
      fixtureSocket = socket
      await appleDhScript({ username: 'u', password: 'p' }, seen, serverInit)(socket, reader)
    })
    const bridge = await startBridge({ host: '127.0.0.1', port, username: 'u', password: 'p' })

    const client = new NoVncClient(bridge.wsPort)
    await client.expectHandshake(serverInit)
    expect(seen.username).toBe('u')
    expect(seen.password).toBe('p')

    // Passthrough works after an authenticated upstream handshake too.
    const downlink = crypto.randomBytes(32)
    fixtureSocket!.write(downlink)
    expect(await client.reader.read(downlink.length)).toEqual(downlink)

    client.ws.close()
    await client.closed
  })

  it('closes the WebSocket with a structured auth error on bad credentials', async () => {
    const serverInit = buildServerInit(640, 480, 'unused')
    const { port } = await startMockServer(
      appleDhScript({ username: 'u', password: 'right' }, {}, serverInit)
    )
    const bridge = await startBridge({ host: '127.0.0.1', port, username: 'u', password: 'wrong' })

    const client = new NoVncClient(bridge.wsPort)
    const { code, reason } = await client.closed
    expect(code).toBe(VNC_BRIDGE_CLOSE_CODES.auth)
    const payload = JSON.parse(reason) as VncBridgeError
    expect(payload.kind).toBe('auth')
    expect(payload.message).toContain('Authentication failed')
  })

  it('rejects a second concurrent client as busy', async () => {
    const serverInit = buildServerInit(800, 600, 'busy-target')
    const { port } = await startMockServer(async (socket, reader) => {
      socket.write('RFB 003.008\n')
      await reader.read(12)
      socket.write(Buffer.from([1, 1]))
      await reader.read(1)
      socket.write(Buffer.from([0, 0, 0, 0]))
      await reader.read(1)
      socket.write(serverInit)
    })
    const bridge = await startBridge({ host: '127.0.0.1', port })

    const first = new NoVncClient(bridge.wsPort)
    await first.expectHandshake(serverInit)

    const second = new NoVncClient(bridge.wsPort)
    const { code, reason } = await second.closed
    expect(code).toBe(VNC_BRIDGE_CLOSE_CODES.busy)
    expect((JSON.parse(reason) as VncBridgeError).kind).toBe('busy')

    first.ws.close()
    await first.closed
  })

  it('reports a connection error when the target is unreachable', async () => {
    // Grab a guaranteed-closed port: listen once, then close the server.
    const tmp = await startMockServer(async () => {})
    await new Promise<void>((resolve) => {
      tmp.server.close(() => resolve())
    })
    const bridge = await startBridge({ host: '127.0.0.1', port: tmp.port })

    const client = new NoVncClient(bridge.wsPort)
    const { code, reason } = await client.closed
    expect(code).toBe(VNC_BRIDGE_CLOSE_CODES.connection)
    expect((JSON.parse(reason) as VncBridgeError).kind).toBe('connection')
  })
})

// ---------------------------------------------------------------------------
// Apple DH mock (server side of the CSecurityDH wire format)
// ---------------------------------------------------------------------------

const DH_PRIME = Buffer.from(
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1' +
    '29024E088A67CC74020BBEA63B139B22514A08798E3404DD' +
    'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245' +
    'E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED' +
    'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE65381' +
    'FFFFFFFFFFFFFFFF',
  'hex'
)
const DH_KEY_LENGTH = 128

function appleDhScript(
  expected: { username: string; password: string },
  seen: { username?: string; password?: string },
  serverInit: Buffer
): ServerScript {
  return async (socket, reader) => {
    socket.write('RFB 003.889\n')
    await reader.read(12)
    socket.write(Buffer.from([1, 30]))
    await reader.read(1)

    const dh = crypto.createDiffieHellman(DH_PRIME, 2)
    dh.generateKeys()
    const header = Buffer.alloc(4)
    header.writeUInt16BE(2, 0)
    header.writeUInt16BE(DH_KEY_LENGTH, 2)
    const publicKey = dh.getPublicKey()
    const paddedPublic =
      publicKey.length >= DH_KEY_LENGTH
        ? publicKey
        : Buffer.concat([Buffer.alloc(DH_KEY_LENGTH - publicKey.length), publicKey])
    socket.write(Buffer.concat([header, DH_PRIME, paddedPublic]))

    const encryptedCredentials = await reader.read(128)
    const clientPublic = await reader.read(DH_KEY_LENGTH)
    let secret = dh.computeSecret(clientPublic)
    if (secret.length < DH_KEY_LENGTH) {
      secret = Buffer.concat([Buffer.alloc(DH_KEY_LENGTH - secret.length), secret])
    }
    const key = crypto.createHash('md5').update(secret).digest()
    const decipher = crypto.createDecipheriv('aes-128-ecb', key, null)
    decipher.setAutoPadding(false)
    const plain = Buffer.concat([decipher.update(encryptedCredentials), decipher.final()])
    const userEnd = plain.indexOf(0, 0)
    const passEnd = plain.indexOf(0, 64)
    seen.username = plain.toString('utf8', 0, userEnd === -1 || userEnd >= 64 ? 64 : userEnd)
    seen.password = plain.toString('utf8', 64, passEnd === -1 ? 128 : passEnd)

    if (seen.username === expected.username && seen.password === expected.password) {
      socket.write(Buffer.from([0, 0, 0, 0]))
      await reader.read(1)
      socket.write(serverInit)
    } else {
      const reason = Buffer.from('Authentication failed', 'utf8')
      const head = Buffer.alloc(8)
      head.writeUInt32BE(1, 0)
      head.writeUInt32BE(reason.length, 4)
      socket.write(Buffer.concat([head, reason]))
    }
  }
}

// ---------------------------------------------------------------------------
// Integration against the real macOS Screen Sharing server (self-skipping)
// ---------------------------------------------------------------------------

async function canConnectLoopback(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
    socket.setTimeout(1000, () => {
      socket.destroy()
      resolve(false)
    })
  })
}

function connectClient(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    activeSockets.add(socket)
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

const hasScreenSharing = await canConnectLoopback(5900)

describe('integration against real Screen Sharing on 127.0.0.1:5900', () => {
  const itVnc = hasScreenSharing ? it : it.skip

  // macOS Screen Sharing stalls new handshakes while it verifies credentials
  // for another connection (~1s for a failed auth). scanner.test.ts probes
  // the same port concurrently in its own worker, so give it a head start
  // before we attempt authentication here.
  beforeAll(async () => {
    if (hasScreenSharing) await new Promise((resolve) => setTimeout(resolve, 1500))
  })

  itVnc('offers the Apple DH security type 30', async () => {
    const socket = await connectClient(5900)
    try {
      const probe = await probeRfbSecurityTypes(socket, 5000)
      expect(probe.serverVersion).toMatch(/^003\./)
      expect(probe.securityTypes).toContain(30)
    } finally {
      socket.destroy()
    }
  })

  itVnc('wrong credentials yield a clean RFB auth failure, not a protocol error', async () => {
    const socket = await connectClient(5900)
    const failure = await performRfbHandshake(socket, {
      username: 'anyremote-probe',
      password: 'definitely-wrong-password',
      timeoutMs: 5000
    }).catch((e) => e)
    socket.destroy()
    expect(failure).toBeInstanceOf(RfbAuthError)
    expect(failure).not.toBeInstanceOf(RfbProtocolError)
    expect(failure).not.toBeInstanceOf(RfbTimeoutError)
    expect(failure.message.length).toBeGreaterThan(0)
  })
})
