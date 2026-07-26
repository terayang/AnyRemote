import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net, { type AddressInfo } from 'node:net'
import { scanTarget } from '../src/main/scanner'
import type { ProtocolScanResult } from '../src/shared/scan'

interface FakeServer {
  server: net.Server
  port: number
}

const activeServers: net.Server[] = []
const activeSockets = new Set<net.Socket>()

/** Starts a throwaway server on an ephemeral loopback port. */
function startFakeServer(handler: (socket: net.Socket) => void): Promise<FakeServer> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      activeSockets.add(socket)
      socket.on('close', () => activeSockets.delete(socket))
      socket.on('error', () => {}) // clients disconnect right after fingerprinting
      handler(socket)
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      activeServers.push(server)
      resolve({ server, port: (server.address() as AddressInfo).port })
    })
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

// TPKT + X.224 CC + RDP_NEG_RESP selecting PROTOCOL_HYBRID (CredSSP, 0x2).
const RDP_NEG_RESP = Buffer.from([
  0x03, 0x00, 0x00, 0x13, // TPKT v3, total length 19
  0x0e, 0xd0, 0x00, 0x00, 0x12, 0x34, 0x00, // X.224 CC TPDU
  0x02, 0x00, 0x08, 0x00, // RDP_NEG_RESP, flags 0, length 8
  0x02, 0x00, 0x00, 0x00 // selectedProtocol: HYBRID
])

let ssh: FakeServer
let vnc: FakeServer
let ftp: FakeServer
let http: FakeServer
let telnet: FakeServer
let rdp: FakeServer
let silent: FakeServer
let resetting: FakeServer
let lastRdpRequest: Buffer | undefined

beforeAll(async () => {
  ;[ssh, vnc, ftp, http, telnet, rdp, silent, resetting] = await Promise.all([
    startFakeServer((s) => s.write('SSH-2.0-OpenSSH_9.9\r\n')),
    startFakeServer((s) => s.write('RFB 003.889\n')),
    startFakeServer((s) => s.write('220 fakeftpd 1.0 ready\r\n')),
    startFakeServer((s) =>
      s.once('data', () => s.end('HTTP/1.0 200 OK\r\nContent-Length: 0\r\n\r\n'))
    ),
    startFakeServer((s) =>
      s.write(Buffer.concat([Buffer.from([0xff, 0xfb, 0x01]), Buffer.from('login: ')]))
    ),
    startFakeServer((s) =>
      s.once('data', (req: Buffer) => {
        lastRdpRequest = req
        s.end(RDP_NEG_RESP)
      })
    ),
    startFakeServer(() => {}), // accepts but never sends anything
    startFakeServer((s) => s.destroy()) // resets right after accept
  ])
})

/** Scans a single protocol against a single fake-server port. */
async function scanOne(
  protocolId: string,
  port: number,
  timeoutMs = 1000
): Promise<ProtocolScanResult> {
  const report = await scanTarget('127.0.0.1', {
    protocols: [protocolId],
    portOverrides: { [protocolId]: port },
    timeoutMs
  })
  expect(report.results).toHaveLength(1)
  return report.results[0]
}

describe('scanTarget against in-process fake servers', () => {
  it('detects SSH and parses its banner', async () => {
    const r = await scanOne('ssh', ssh.port)
    expect(r.status).toBe('open')
    expect(r.detected).toBe(true)
    expect(r.banner).toBe('SSH-2.0-OpenSSH_9.9')
    expect(r.port).toBe(ssh.port)
    expect(r.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('detects VNC and parses the RFB version banner', async () => {
    const r = await scanOne('vnc', vnc.port)
    expect(r.status).toBe('open')
    expect(r.detected).toBe(true)
    expect(r.banner).toBe('RFB 003.889')
  })

  it('detects FTP from the 220 greeting', async () => {
    const r = await scanOne('ftp', ftp.port)
    expect(r.status).toBe('open')
    expect(r.detected).toBe(true)
    expect(r.banner).toBe('220 fakeftpd 1.0 ready')
  })

  it('detects HTTP from the status line of a HEAD response', async () => {
    const r = await scanOne('http', http.port)
    expect(r.status).toBe('open')
    expect(r.detected).toBe(true)
    expect(r.banner).toBe('HTTP/1.0 200 OK')
  })

  it('detects Telnet from IAC negotiation bytes', async () => {
    const r = await scanOne('telnet', telnet.port)
    expect(r.status).toBe('open')
    expect(r.detected).toBe(true)
    expect(r.banner).toBe('login: ')
  })

  it('detects RDP via RDP_NEG_RESP and parses the selected security', async () => {
    const r = await scanOne('rdp', rdp.port)
    expect(r.status).toBe('open')
    expect(r.detected).toBe(true)
    expect(r.detail).toContain('0x2')
    expect(r.detail).toContain('HYBRID')
    // The probe must have sent a well-formed X.224 CR carrying RDP_NEG_REQ.
    expect(lastRdpRequest).toBeDefined()
    expect(lastRdpRequest!.length).toBe(19)
    expect(lastRdpRequest![0]).toBe(0x03) // TPKT v3
    expect(lastRdpRequest![5]).toBe(0xe0) // X.224 CR
    expect(lastRdpRequest![11]).toBe(0x01) // RDP_NEG_REQ
  })

  it('scans all protocols concurrently; a failing port does not affect others', async () => {
    // Grab a guaranteed-closed port: listen once, then close the server.
    const tmp = await startFakeServer(() => {})
    const closedPort = tmp.port
    await new Promise<void>((resolve) => {
      tmp.server.close(() => resolve())
    })

    const report = await scanTarget('127.0.0.1', {
      timeoutMs: 1000,
      portOverrides: {
        ssh: ssh.port,
        vnc: vnc.port,
        ftp: ftp.port,
        http: http.port,
        telnet: telnet.port,
        rdp: rdp.port,
        smb: closedPort,
        https: closedPort
      }
    })
    expect(report.host).toBe('127.0.0.1')
    expect(report.startedAt).toBeGreaterThan(0)
    expect(report.durationMs).toBeGreaterThanOrEqual(0)
    expect(report.results).toHaveLength(8)
    const byId = new Map(report.results.map((r) => [r.protocolId, r]))
    for (const id of ['ssh', 'vnc', 'ftp', 'http', 'telnet', 'rdp']) {
      expect(byId.get(id)?.status, id).toBe('open')
      expect(byId.get(id)?.detected, id).toBe(true)
    }
    expect(byId.get('smb')?.status).toBe('closed')
    expect(byId.get('smb')?.detected).toBe(false)
    expect(byId.get('https')?.status).toBe('closed')
    expect(byId.get('https')?.detected).toBe(false)
  })
})

describe('error mapping', () => {
  it('maps ECONNREFUSED to closed', async () => {
    const tmp = await startFakeServer(() => {})
    const port = tmp.port
    await new Promise<void>((resolve) => {
      tmp.server.close(() => resolve())
    })
    const r = await scanOne('ssh', port)
    expect(r.status).toBe('closed')
    expect(r.detected).toBe(false)
    expect(r.banner).toBeUndefined()
  })

  it('reports a port that resets right after accept as open, not detected', async () => {
    const r = await scanOne('ssh', resetting.port)
    expect(r.status).toBe('open')
    expect(r.detected).toBe(false)
  })

  it('reports a silent open port as open, not detected (telnet without banner)', async () => {
    const r = await scanOne('telnet', silent.port, 500)
    expect(r.status).toBe('open')
    expect(r.detected).toBe(false)
    expect(r.banner).toBeUndefined()
  })
})

// Integration tests probe real services on the dev machine (see AGENTS.md);
// they self-skip where those services are absent (e.g. CI runners).
async function canConnectLoopback(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false) })
  })
}
const hasSshd = await canConnectLoopback(22)
const hasScreenSharing = await canConnectLoopback(5900)

describe('integration against real services on this machine', () => {
  const itSshd = hasSshd ? it : it.skip
  const itVnc = hasScreenSharing ? it : it.skip

  itSshd('detects real sshd on 127.0.0.1:22', async () => {
    const report = await scanTarget('127.0.0.1', { protocols: ['ssh'] })
    const r = report.results[0]
    expect(r.status).toBe('open')
    expect(r.detected).toBe(true)
    expect(r.banner).toMatch(/^SSH-2\.0-/)
  })

  itVnc('detects real Screen Sharing on 127.0.0.1:5900', async () => {
    const report = await scanTarget('127.0.0.1', { protocols: ['vnc'] })
    const r = report.results[0]
    expect(r.status).toBe('open')
    expect(r.detected).toBe(true)
    expect(r.banner).toMatch(/^RFB 003\./)
  })
})
