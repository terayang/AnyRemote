/**
 * Tests for the RFB client handshake (src/main/rfb/).
 *
 * The Apple DH fixture is a true interop check: the mock server implements
 * the server side of the TigerVNC CSecurityDH wire format with Node's own
 * DH/AES crypto (independent of the client's BigInt modpow path) and decrypts
 * the credential block — the test only passes if the server recovers the
 * exact plaintext username/password.
 */

import { afterAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import net, { type AddressInfo } from 'node:net'
import { performAppleDhAuth, bigIntToBytes, modPow } from '../src/main/rfb/appleDh'
import { desEncryptBlock, desEncryptEcb, vncPasswordKey } from '../src/main/rfb/des'
import { ChunkReader, performRfbHandshake } from '../src/main/rfb/handshake'
import { encryptVncChallenge } from '../src/main/rfb/vncAuth'
import { RfbAuthError, RfbProtocolError, RfbTimeoutError } from '../src/main/rfb/types'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const activeServers: net.Server[] = []
const activeSockets = new Set<net.Socket>()

type ServerScript = (socket: net.Socket, reader: ChunkReader) => Promise<void>

/** Starts a mock RFB server on an ephemeral loopback port. */
function startMockServer(script: ServerScript): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      activeSockets.add(socket)
      socket.on('close', () => activeSockets.delete(socket))
      socket.on('error', () => {}) // clients go away mid-script on error paths
      const reader = new ChunkReader()
      socket.on('data', (chunk: Buffer) => reader.push(chunk))
      socket.on('close', () => reader.fail(new Error('client disconnected')))
      script(socket, reader).catch(() => socket.destroy())
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      activeServers.push(server)
      resolve({ port: (server.address() as AddressInfo).port })
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

afterAll(async () => {
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

/** Builds a ServerInit message with a 32-bit true-color pixel format. */
function buildServerInit(width: number, height: number, name: string): Buffer {
  const nameBytes = Buffer.from(name, 'utf8')
  const buf = Buffer.alloc(24 + nameBytes.length)
  buf.writeUInt16BE(width, 0)
  buf.writeUInt16BE(height, 2)
  buf[4] = 32 // bits-per-pixel
  buf[5] = 24 // depth
  buf[6] = 0 // little-endian flag
  buf[7] = 1 // true-color flag
  buf.writeUInt16BE(255, 8)
  buf.writeUInt16BE(255, 10)
  buf.writeUInt16BE(255, 12)
  buf[14] = 16 // red-shift
  buf[15] = 8 // green-shift
  buf[16] = 0 // blue-shift
  buf.writeUInt32BE(nameBytes.length, 20)
  nameBytes.copy(buf, 24)
  return buf
}

function securityResultOk(): Buffer {
  return Buffer.from([0, 0, 0, 0])
}

function securityResultFail(reason: string): Buffer {
  const reasonBytes = Buffer.from(reason, 'utf8')
  const buf = Buffer.alloc(8 + reasonBytes.length)
  buf.writeUInt32BE(1, 0)
  buf.writeUInt32BE(reasonBytes.length, 4)
  reasonBytes.copy(buf, 8)
  return buf
}

// ---------------------------------------------------------------------------
// Crypto primitives
// ---------------------------------------------------------------------------

describe('pure-JS DES', () => {
  it('matches the canonical FIPS 46-3 test vector', () => {
    const key = new Uint8Array(Buffer.from('0123456789abcdef', 'hex'))
    const plain = new Uint8Array(Buffer.from('4e6f772069732074', 'hex')) // 'Now is t'
    expect(Buffer.from(desEncryptBlock(plain, key)).toString('hex')).toBe('3fa40e8a984d4815')
  })

  it('encrypts multiple blocks identically to per-block encryption', () => {
    const key = new Uint8Array(Buffer.from('0123456789abcdef', 'hex'))
    const block = Buffer.from('4e6f772069732074', 'hex')
    const two = desEncryptEcb(new Uint8Array(Buffer.concat([block, block])), key)
    expect(Buffer.from(two).toString('hex')).toBe('3fa40e8a984d48153fa40e8a984d4815')
  })

  it('builds the VNC key by truncating and bit-reversing the password', () => {
    expect(Buffer.from(vncPasswordKey('password')).toString('hex')).toBe('0e86ceceeef64e26')
    // >8 chars are truncated, short passwords are zero-padded
    expect(Buffer.from(vncPasswordKey('passwordEXTRA')).toString('hex')).toBe('0e86ceceeef64e26')
    expect(Buffer.from(vncPasswordKey('')).toString('hex')).toBe('0000000000000000')
  })

  it('produces the same challenge response on the openssl and JS paths', () => {
    const challenge = crypto.randomBytes(16)
    const expected = Buffer.from(desEncryptEcb(challenge, vncPasswordKey('hunter2')))
    expect(encryptVncChallenge(challenge, 'hunter2')).toEqual(expected)
  })
})

describe('modPow', () => {
  it('reproduces the classic small-number DH example', () => {
    // Wikipedia DHKE: p=23, g=5, a=6 -> A=8, b=15 -> B=19, shared secret 2
    expect(modPow(5n, 6n, 23n)).toBe(8n)
    expect(modPow(5n, 15n, 23n)).toBe(19n)
    expect(modPow(19n, 6n, 23n)).toBe(2n)
    expect(modPow(8n, 15n, 23n)).toBe(2n)
  })

  it('serializes with bigIntToBytes zero-padding', () => {
    expect(bigIntToBytes(2n, 4).toString('hex')).toBe('00000002')
    expect(bigIntToBytes(0n, 2).toString('hex')).toBe('0000')
  })
})

// ---------------------------------------------------------------------------
// Handshake against mock servers
// ---------------------------------------------------------------------------

describe('performRfbHandshake', () => {
  it('completes against a None server and parses ServerInit', async () => {
    const seen: { selection?: number; clientInit?: number } = {}
    const serverInit = buildServerInit(1024, 768, 'test-desktop')
    const { port } = await startMockServer(async (socket, reader) => {
      socket.write('RFB 003.008\n')
      await reader.read(12)
      socket.write(Buffer.from([2, 2, 1])) // offers VNC auth + None
      seen.selection = (await reader.read(1))[0]
      socket.write(securityResultOk())
      seen.clientInit = (await reader.read(1))[0]
      socket.write(serverInit)
    })

    const socket = await connectClient(port)
    const result = await performRfbHandshake(socket)
    socket.destroy()

    expect(result.serverVersion).toBe('003.008')
    expect(result.securityType).toBe(1)
    expect(result.width).toBe(1024)
    expect(result.height).toBe(768)
    expect(result.name).toBe('test-desktop')
    expect(result.pixelFormat).toEqual({
      bitsPerPixel: 32,
      depth: 24,
      bigEndian: false,
      trueColor: true,
      redMax: 255,
      greenMax: 255,
      blueMax: 255,
      redShift: 16,
      greenShift: 8,
      blueShift: 0
    })
    expect(Buffer.from(result.raw).equals(serverInit)).toBe(true)
    expect(seen.selection).toBe(1)
    expect(seen.clientInit).toBe(1) // shared flag
  })

  it('handles an RFB 3.3 None server (no selection, no SecurityResult)', async () => {
    const serverInit = buildServerInit(800, 600, 'legacy')
    const { port } = await startMockServer(async (socket, reader) => {
      socket.write('RFB 003.003\n')
      const version = (await reader.read(12)).toString('latin1')
      expect(version).toBe('RFB 003.003\n')
      const type = Buffer.alloc(4)
      type.writeUInt32BE(1, 0) // server dictates None
      socket.write(type)
      await reader.read(1) // ClientInit comes straight away in 3.3
      socket.write(serverInit)
    })

    const socket = await connectClient(port)
    const result = await performRfbHandshake(socket)
    socket.destroy()
    expect(result.securityType).toBe(1)
    expect(result.width).toBe(800)
    expect(result.name).toBe('legacy')
  })

  it('authenticates against a VNC auth server with the correct password', async () => {
    const { port } = await startMockServer(async (socket, reader) => {
      socket.write('RFB 003.008\n')
      await reader.read(12)
      socket.write(Buffer.from([1, 2]))
      await reader.read(1) // selection
      const challenge = crypto.randomBytes(16)
      socket.write(challenge)
      const response = await reader.read(16)
      if (response.equals(encryptVncChallenge(challenge, 's3cret'))) {
        socket.write(securityResultOk())
        await reader.read(1)
        socket.write(buildServerInit(640, 480, 'vnc'))
      } else {
        socket.write(securityResultFail('bad password'))
      }
    })

    const socket = await connectClient(port)
    const result = await performRfbHandshake(socket, { password: 's3cret' })
    socket.destroy()
    expect(result.securityType).toBe(2)
    expect(result.name).toBe('vnc')
  })

  it('rejects a wrong VNC password with RfbAuthError carrying the reason', async () => {
    const { port } = await startMockServer(async (socket, reader) => {
      socket.write('RFB 003.008\n')
      await reader.read(12)
      socket.write(Buffer.from([1, 2]))
      await reader.read(1)
      const challenge = crypto.randomBytes(16)
      socket.write(challenge)
      const response = await reader.read(16)
      if (response.equals(encryptVncChallenge(challenge, 's3cret'))) {
        socket.write(securityResultOk())
      } else {
        socket.write(securityResultFail('VNC authentication failed'))
      }
    })

    const socket = await connectClient(port)
    const failure = await performRfbHandshake(socket, { password: 'wrong' }).catch((e) => e)
    socket.destroy()
    expect(failure).toBeInstanceOf(RfbAuthError)
    expect(failure.message).toContain('VNC authentication failed')
  })

  it('prefers VNC auth over None when a password is available', async () => {
    const seen: { selection?: number } = {}
    const { port } = await startMockServer(async (socket, reader) => {
      socket.write('RFB 003.008\n')
      await reader.read(12)
      socket.write(Buffer.from([2, 1, 2])) // None first, VNC auth second
      seen.selection = (await reader.read(1))[0]
      const challenge = crypto.randomBytes(16)
      socket.write(challenge)
      await reader.read(16)
      socket.write(securityResultOk())
      await reader.read(1)
      socket.write(buildServerInit(640, 480, 'vnc'))
    })

    const socket = await connectClient(port)
    const result = await performRfbHandshake(socket, { password: 's3cret' })
    socket.destroy()
    expect(result.securityType).toBe(2)
    expect(seen.selection).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Apple DH (security type 30)
// ---------------------------------------------------------------------------

/** RFC 2409 group 2 prime (1024-bit), 128 bytes — a realistic DH modulus. */
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

function leftPad(buf: Buffer, length: number): Buffer {
  return buf.length >= length ? buf : Buffer.concat([Buffer.alloc(length - buf.length), buf])
}

function readCString(field: Buffer): string {
  const end = field.indexOf(0)
  return field.toString('utf8', 0, end === -1 ? field.length : end)
}

interface AppleDhSeen {
  clientVersion?: string
  selectedType?: number
  username?: string
  password?: string
}

/**
 * Mock macOS Screen Sharing server. Implements the server side of the
 * CSecurityDH exchange with Node's OpenSSL DH and decrypts the credentials:
 * the recovered username/password are the interop ground truth.
 */
function appleDhServer(
  expected: { username: string; password: string },
  seen: AppleDhSeen
): ServerScript {
  return async (socket, reader) => {
    socket.write('RFB 003.889\n')
    seen.clientVersion = (await reader.read(12)).toString('latin1')
    socket.write(Buffer.from([1, 30])) // only Apple DH offered
    seen.selectedType = (await reader.read(1))[0]

    const dh = crypto.createDiffieHellman(DH_PRIME, 2)
    dh.generateKeys()
    const header = Buffer.alloc(4)
    header.writeUInt16BE(2, 0) // generator g = 2
    header.writeUInt16BE(DH_KEY_LENGTH, 2)
    socket.write(
      Buffer.concat([header, DH_PRIME, leftPad(dh.getPublicKey(), DH_KEY_LENGTH)])
    )

    const encryptedCredentials = await reader.read(128)
    const clientPublic = await reader.read(DH_KEY_LENGTH)
    const sharedSecret = leftPad(dh.computeSecret(clientPublic), DH_KEY_LENGTH)
    const key = crypto.createHash('md5').update(sharedSecret).digest()
    const decipher = crypto.createDecipheriv('aes-128-ecb', key, null)
    decipher.setAutoPadding(false)
    const plain = Buffer.concat([decipher.update(encryptedCredentials), decipher.final()])
    seen.username = readCString(plain.subarray(0, 64))
    seen.password = readCString(plain.subarray(64, 128))

    if (seen.username === expected.username && seen.password === expected.password) {
      socket.write(securityResultOk())
      await reader.read(1)
      socket.write(buildServerInit(1920, 1080, 'mac'))
    } else {
      socket.write(securityResultFail('Authentication failed'))
    }
  }
}

describe('Apple DH authentication (security type 30)', () => {
  it('completes with correct credentials; the server recovers them verbatim', async () => {
    const seen: AppleDhSeen = {}
    const { port } = await startMockServer(
      appleDhServer({ username: 'silica', password: 'p@ss w0rd' }, seen)
    )

    const socket = await connectClient(port)
    const result = await performRfbHandshake(socket, {
      username: 'silica',
      password: 'p@ss w0rd'
    })
    socket.destroy()

    expect(result.securityType).toBe(30)
    expect(result.serverVersion).toBe('003.889')
    expect(result.width).toBe(1920)
    expect(result.name).toBe('mac')
    // The client clamps Apple's 3.889 to 3.8, exactly like TigerVNC.
    expect(seen.clientVersion).toBe('RFB 003.008\n')
    expect(seen.selectedType).toBe(30)
    // True interop check: the mock server decrypted these independently.
    expect(seen.username).toBe('silica')
    expect(seen.password).toBe('p@ss w0rd')
  })

  it('rejects wrong credentials with a clean RfbAuthError', async () => {
    const seen: AppleDhSeen = {}
    const { port } = await startMockServer(
      appleDhServer({ username: 'silica', password: 'right' }, seen)
    )

    const socket = await connectClient(port)
    const failure = await performRfbHandshake(socket, {
      username: 'silica',
      password: 'wrong'
    }).catch((e) => e)
    socket.destroy()

    expect(failure).toBeInstanceOf(RfbAuthError)
    expect(failure).not.toBeInstanceOf(RfbProtocolError)
    expect(failure).not.toBeInstanceOf(RfbTimeoutError)
    expect(failure.message).toContain('Authentication failed')
    // The wire format still worked — the server decrypted a coherent block.
    expect(seen.username).toBe('silica')
    expect(seen.password).toBe('wrong')
  })

  it('fails fast when the server requires auth but no password was given', async () => {
    const { port } = await startMockServer(async (socket, reader) => {
      socket.write('RFB 003.889\n')
      await reader.read(12)
      socket.write(Buffer.from([1, 30]))
      await reader.read(1)
    })

    const socket = await connectClient(port)
    const failure = await performRfbHandshake(socket).catch((e) => e)
    socket.destroy()
    expect(failure).toBeInstanceOf(RfbAuthError)
    expect(failure.message).toContain('no password')
  })

  it('rejects usernames longer than 63 bytes', async () => {
    const { port } = await startMockServer(async (socket, reader) => {
      socket.write('RFB 003.889\n')
      await reader.read(12)
      socket.write(Buffer.from([1, 30]))
      await reader.read(1)
      const dhParams = Buffer.alloc(4)
      dhParams.writeUInt16BE(2, 0)
      dhParams.writeUInt16BE(DH_KEY_LENGTH, 2)
      // Valid-but-arbitrary server public key; the client must reject the
      // over-long username before it ever sends credentials.
      socket.write(Buffer.concat([dhParams, DH_PRIME, bigIntToBytes(12345n, DH_KEY_LENGTH)]))
    })

    const socket = await connectClient(port)
    const failure = await performRfbHandshake(socket, {
      username: 'x'.repeat(64),
      password: 'pw'
    }).catch((e) => e)
    socket.destroy()
    expect(failure).toBeInstanceOf(RfbAuthError)
    expect(failure.message).toContain('username too long')
  })
})

// ---------------------------------------------------------------------------
// Protocol error paths
// ---------------------------------------------------------------------------

describe('protocol errors and timeout', () => {
  it('rejects a non-RFB banner with RfbProtocolError', async () => {
    const { port } = await startMockServer(async (socket) => {
      socket.write('HELLO WORLD\n')
    })

    const socket = await connectClient(port)
    const failure = await performRfbHandshake(socket).catch((e) => e)
    socket.destroy()
    expect(failure).toBeInstanceOf(RfbProtocolError)
    expect(failure.message).toContain('not an RFB server')
  })

  it('rejects when no supported security type is offered', async () => {
    const { port } = await startMockServer(async (socket, reader) => {
      socket.write('RFB 003.008\n')
      await reader.read(12)
      socket.write(Buffer.from([2, 16, 18])) // Tight / TLS — unsupported
    })

    const socket = await connectClient(port)
    const failure = await performRfbHandshake(socket).catch((e) => e)
    socket.destroy()
    expect(failure).toBeInstanceOf(RfbProtocolError)
    expect(failure.message).toContain('no supported security type')
  })

  it('surfaces the server refusal reason when the type list is empty', async () => {
    const { port } = await startMockServer(async (socket, reader) => {
      socket.write('RFB 003.008\n')
      await reader.read(12)
      socket.write(Buffer.from([0])) // count = 0 -> failure + reason
      const reason = Buffer.from('Too many connections', 'utf8')
      const head = Buffer.alloc(4)
      head.writeUInt32BE(reason.length, 0)
      socket.write(Buffer.concat([head, reason]))
    })

    const socket = await connectClient(port)
    const failure = await performRfbHandshake(socket).catch((e) => e)
    socket.destroy()
    expect(failure).toBeInstanceOf(RfbProtocolError)
    expect(failure.message).toContain('Too many connections')
  })

  it('times out with RfbTimeoutError against a silent server', async () => {
    const { port } = await startMockServer(async () => {
      await new Promise(() => {}) // never sends anything
    })

    const socket = await connectClient(port)
    const failure = await performRfbHandshake(socket, { timeoutMs: 300 }).catch((e) => e)
    expect(failure).toBeInstanceOf(RfbTimeoutError)
    expect(socket.destroyed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// performAppleDhAuth unit-level edge cases
// ---------------------------------------------------------------------------

describe('performAppleDhAuth parameter validation', () => {
  it('rejects out-of-range key lengths', async () => {
    const reader = new ChunkReader()
    const header = Buffer.alloc(4)
    header.writeUInt16BE(2, 0)
    header.writeUInt16BE(64, 2) // below the 128-byte minimum
    reader.push(header)
    const writes: Buffer[] = []
    const failure = await performAppleDhAuth(
      reader,
      { write: (b: Buffer) => writes.push(b) },
      { username: 'u', password: 'p' }
    ).catch((e) => e)
    expect(failure).toBeInstanceOf(RfbProtocolError)
    expect(failure.message).toContain('key length')
    expect(writes).toHaveLength(0)
  })
})
