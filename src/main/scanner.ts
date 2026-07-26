/**
 * Protocol scanner (stage 2): concurrently probes the well-known ports from
 * src/shared/protocols.ts on a target host and fingerprints whatever answers.
 *
 * Pure Node built-ins (node:net / node:tls) — no nmap binary, no dependencies.
 * Fingerprint strategy per protocol:
 * - ssh / vnc / ftp: server greeting banner sent on connect
 * - telnet: an open port counts; IAC (0xFF) negotiation bytes confirm it
 * - http: `HEAD / HTTP/1.0` -> `HTTP/` status line
 * - https: TLS handshake -> protocol version + peer certificate CN
 * - rdp: X.224 connection request with RDP_NEG_REQ -> RDP_NEG_RESP
 * - smb: SMB2 NEGOTIATE probe -> SMB2/SMB1 magic in the reply
 *
 * Every probe resolves — a single failing port never rejects the report.
 */

import net from 'node:net'
import tls from 'node:tls'
import { PROTOCOLS } from '../shared/protocols'
import type { ProtocolScanResult, ScanStatus, TargetScanReport } from '../shared/scan'

export interface ScanOptions {
  /** Per-port timeout in ms covering connect + fingerprint. Default 2000. */
  timeoutMs?: number
  /** Limit the scan to these protocol ids (default: all known protocols). */
  protocols?: string[]
  /** Probe non-default ports per protocol id (used by tests). */
  portOverrides?: Record<string, number>
}

const DEFAULT_TIMEOUT_MS = 2000

/** How much of the greeting to collect before evaluating the fingerprint. */
type ReadMode = 'firstChunk' | 'firstLine'

interface ExchangeOptions {
  /** Bytes to write right after the connection is up. */
  send?: Buffer
  /** Stop reading after the first data chunk or the first newline-terminated line. */
  read: ReadMode
  /** Upgrade to TLS and report handshake details instead of reading data. */
  useTls?: boolean
}

interface ExchangeOutcome {
  status: ScanStatus
  /** Bytes received (empty when none arrived before the timeout). */
  data: Buffer
  /** TLS protocol version and peer certificate CN (https probe only). */
  tlsInfo?: { version: string | null; certCN?: string }
  /** Error / timeout detail worth surfacing to the user. */
  detail?: string
  latencyMs: number
}

/**
 * Opens one TCP (optionally TLS) connection, optionally writes a probe,
 * collects the greeting, and resolves. Never rejects: every failure mode is
 * mapped onto a ScanStatus so one bad port cannot break the whole scan.
 */
function exchange(
  host: string,
  port: number,
  timeoutMs: number,
  opts: ExchangeOptions
): Promise<ExchangeOutcome> {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const chunks: Buffer[] = []
    let transportUp = false // TCP connect completed (for TLS: before the handshake)
    let connectLatencyMs: number | undefined
    let done = false

    let socket: net.Socket
    try {
      socket = opts.useTls
        ? tls.connect({
            host,
            port,
            // SNI must be a DNS name; Node rejects IP literals as servername.
            ...(net.isIP(host) === 0 ? { servername: host } : {}),
            rejectUnauthorized: false
          })
        : net.createConnection({ host, port })
    } catch (err) {
      resolve({
        status: 'error',
        data: Buffer.alloc(0),
        detail: err instanceof Error ? err.message : String(err),
        latencyMs: 0
      })
      return
    }
    socket.setNoDelay(true)

    const finish = (outcome: {
      status: ScanStatus
      detail?: string
      tlsInfo?: ExchangeOutcome['tlsInfo']
      latencyMs?: number
    }): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.removeAllListeners()
      socket.destroy()
      resolve({
        status: outcome.status,
        data: Buffer.concat(chunks),
        tlsInfo: outcome.tlsInfo,
        detail: outcome.detail,
        latencyMs: outcome.latencyMs ?? connectLatencyMs ?? Date.now() - startedAt
      })
    }

    const timer = setTimeout(() => {
      // A completed connect with a silent peer still means the port is open.
      finish(
        transportUp
          ? { status: 'open', detail: `no data within ${timeoutMs}ms` }
          : { status: 'timeout', detail: `no response within ${timeoutMs}ms` }
      )
    }, timeoutMs)

    socket.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED') {
        finish({ status: 'closed', detail: 'connection refused (ECONNREFUSED)' })
      } else if (err.code === 'ETIMEDOUT') {
        finish({ status: 'timeout', detail: err.message })
      } else if (transportUp) {
        // The port accepted the TCP connection; a later failure (TLS
        // mismatch, reset after connect) still means something listens there.
        finish({ status: 'open', detail: err.message })
      } else {
        finish({ status: 'error', detail: err.code ? `${err.code}: ${err.message}` : err.message })
      }
    })

    socket.once('connect', () => {
      transportUp = true
      connectLatencyMs = Date.now() - startedAt
      if (!opts.useTls && opts.send !== undefined) socket.write(opts.send)
      // Without a probe payload, wait passively for the server greeting.
    })

    socket.once('secureConnect', () => {
      const tlsSocket = socket as tls.TLSSocket
      const cert = tlsSocket.getPeerCertificate() as unknown as
        | { subject?: Record<string, unknown> }
        | undefined
      const cn = cert?.subject?.CN
      finish({
        status: 'open',
        latencyMs: Date.now() - startedAt,
        tlsInfo: {
          version: tlsSocket.getProtocol(),
          certCN: typeof cn === 'string' ? cn : undefined
        }
      })
    })

    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      if (opts.read === 'firstChunk' || Buffer.concat(chunks).includes(0x0a)) {
        finish({ status: 'open' })
      }
    })

    // Peer closed the connection: report whatever greeting we already got.
    socket.once('end', () => finish({ status: 'open' }))
  })
}

function firstLine(data: Buffer): string | undefined {
  if (data.length === 0) return undefined
  const line = data.toString('utf8').split('\n', 1)[0].replace(/\r$/, '')
  return line === '' ? undefined : line
}

/** Renders the printable part of a telnet greeting, skipping IAC sequences. */
function telnetBanner(data: Buffer): string | undefined {
  const printable: number[] = []
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0xff) {
      i += 2 // skip IAC + verb + option
      continue
    }
    if (data[i] >= 0x20 && data[i] < 0x7f) printable.push(data[i])
  }
  const banner = Buffer.from(printable).toString('utf8')
  return banner === '' ? undefined : banner
}

function toResult(
  protocolId: string,
  port: number,
  r: ExchangeOutcome,
  detected: boolean,
  banner?: string,
  detail?: string
): ProtocolScanResult {
  const open = r.status === 'open'
  return {
    protocolId,
    port,
    status: r.status,
    detected: open && detected,
    banner: open ? banner : undefined,
    detail: detail ?? r.detail,
    latencyMs: r.latencyMs
  }
}

async function probeSsh(host: string, port: number, timeoutMs: number): Promise<ProtocolScanResult> {
  const r = await exchange(host, port, timeoutMs, { read: 'firstLine' })
  const banner = firstLine(r.data)
  return toResult('ssh', port, r, banner?.startsWith('SSH-') ?? false, banner)
}

async function probeVnc(host: string, port: number, timeoutMs: number): Promise<ProtocolScanResult> {
  const r = await exchange(host, port, timeoutMs, { read: 'firstLine' })
  const banner = firstLine(r.data)
  return toResult('vnc', port, r, banner !== undefined && /^RFB \d{3}\.\d{3}/.test(banner), banner)
}

async function probeFtp(host: string, port: number, timeoutMs: number): Promise<ProtocolScanResult> {
  const r = await exchange(host, port, timeoutMs, { read: 'firstLine' })
  const banner = firstLine(r.data)
  return toResult('ftp', port, r, banner?.startsWith('220') ?? false, banner)
}

async function probeTelnet(
  host: string,
  port: number,
  timeoutMs: number
): Promise<ProtocolScanResult> {
  const r = await exchange(host, port, timeoutMs, { read: 'firstChunk' })
  const detected = r.data.length > 0 && r.data[0] === 0xff // IAC
  return toResult('telnet', port, r, detected, telnetBanner(r.data))
}

async function probeHttp(
  host: string,
  port: number,
  timeoutMs: number
): Promise<ProtocolScanResult> {
  const r = await exchange(host, port, timeoutMs, {
    read: 'firstLine',
    send: Buffer.from('HEAD / HTTP/1.0\r\n\r\n')
  })
  const statusLine = firstLine(r.data)
  return toResult('http', port, r, statusLine?.startsWith('HTTP/') ?? false, statusLine)
}

async function probeHttps(
  host: string,
  port: number,
  timeoutMs: number
): Promise<ProtocolScanResult> {
  const r = await exchange(host, port, timeoutMs, { read: 'firstChunk', useTls: true })
  const detail = r.tlsInfo
    ? `TLS ${r.tlsInfo.version ?? 'unknown'}${r.tlsInfo.certCN ? `, CN=${r.tlsInfo.certCN}` : ''}`
    : undefined
  return toResult('https', port, r, r.tlsInfo !== undefined, undefined, detail)
}

/**
 * X.224 TPKT connection request carrying RDP_NEG_REQ (MS-RDPBCGR 2.2.1.1),
 * offering PROTOCOL_SSL | PROTOCOL_HYBRID. Standard 19-byte sequence.
 */
const RDP_NEG_REQUEST = Buffer.from([
  0x03, 0x00, 0x00, 0x13, // TPKT v3, total length 19
  0x0e, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, // X.224 CR TPDU
  0x01, 0x00, 0x08, 0x00, // RDP_NEG_REQ, flags 0, length 8
  0x03, 0x00, 0x00, 0x00 // requestedProtocols: SSL | HYBRID
])

function describeRdpSecurity(flags: number): string {
  const names: string[] = []
  if (flags & 0x1) names.push('SSL')
  if (flags & 0x2) names.push('HYBRID')
  if (flags & 0x4) names.push('RDSTLS')
  if (flags & 0x8) names.push('HYBRID_EX')
  return names.length === 0 ? 'NONE' : names.join('|')
}

async function probeRdp(host: string, port: number, timeoutMs: number): Promise<ProtocolScanResult> {
  const r = await exchange(host, port, timeoutMs, { read: 'firstChunk', send: RDP_NEG_REQUEST })
  const b = r.data
  let detected = false
  let detail: string | undefined
  // TPKT (0x03) + X.224 CC (0xd0) + RDP negotiation response at offset 11.
  if (b.length >= 19 && b[0] === 0x03 && b[5] === 0xd0) {
    if (b[11] === 0x02) {
      const selected = b.readUInt32LE(15)
      detected = true
      detail = `negotiated security: 0x${selected.toString(16)} (${describeRdpSecurity(selected)})`
    } else if (b[11] === 0x03) {
      detail = `negotiation failure: 0x${b.readUInt32LE(15).toString(16)}`
    }
  }
  return toResult('rdp', port, r, detected, undefined, detail)
}

const SMB2_MAGIC = Buffer.from([0xfe, 0x53, 0x4d, 0x42]) // 0xFE 'SMB'
const SMB1_MAGIC = Buffer.from([0xff, 0x53, 0x4d, 0x42]) // 0xFF 'SMB'

/** NetBIOS session header + SMB2 NEGOTIATE offering dialects 2.0.2 and 2.1. */
function buildSmb2NegotiateProbe(): Buffer {
  const header = Buffer.alloc(64)
  SMB2_MAGIC.copy(header, 0)
  header.writeUInt16LE(64, 4) // StructureSize
  // Command NEGOTIATE (0x0000); everything else stays zero.

  const body = Buffer.alloc(36)
  body.writeUInt16LE(36, 0) // StructureSize
  body.writeUInt16LE(2, 2) // DialectCount
  body.writeUInt16LE(1, 4) // SecurityMode: signing enabled

  const dialects = Buffer.from([0x02, 0x02, 0x10, 0x02]) // SMB 2.0.2, SMB 2.1
  const payload = Buffer.concat([header, body, dialects])
  const netbios = Buffer.alloc(4)
  netbios.writeUInt32BE(payload.length, 0) // byte 0 = session message, 3-byte length
  return Buffer.concat([netbios, payload])
}

async function probeSmb(host: string, port: number, timeoutMs: number): Promise<ProtocolScanResult> {
  const r = await exchange(host, port, timeoutMs, {
    read: 'firstChunk',
    send: buildSmb2NegotiateProbe()
  })
  const smb2 = r.data.includes(SMB2_MAGIC)
  const smb1 = r.data.includes(SMB1_MAGIC)
  const detail = smb2
    ? 'SMB2 magic in negotiate response'
    : smb1
      ? 'SMB1 magic in negotiate response'
      : undefined
  return toResult('smb', port, r, smb2 || smb1, undefined, detail)
}

type ProbeFn = (host: string, port: number, timeoutMs: number) => Promise<ProtocolScanResult>

function probeFor(protocolId: string): ProbeFn {
  switch (protocolId) {
    case 'ssh':
      return probeSsh
    case 'vnc':
      return probeVnc
    case 'rdp':
      return probeRdp
    case 'telnet':
      return probeTelnet
    case 'ftp':
      return probeFtp
    case 'smb':
      return probeSmb
    case 'http':
      return probeHttp
    case 'https':
      return probeHttps
    default:
      throw new Error(`no probe implemented for protocol "${protocolId}"`)
  }
}

/**
 * Probes all known protocols on `host` concurrently (one TCP connection per
 * protocol port) and aggregates the per-protocol fingerprint results.
 */
export async function scanTarget(host: string, opts: ScanOptions = {}): Promise<TargetScanReport> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const wanted = opts.protocols === undefined ? null : new Set(opts.protocols)
  const targets = PROTOCOLS.filter((p) => wanted === null || wanted.has(p.id))
  const startedAt = Date.now()
  const results = await Promise.all(
    targets.map(async (meta): Promise<ProtocolScanResult> => {
      const port = opts.portOverrides?.[meta.id] ?? meta.defaultPort
      try {
        return await probeFor(meta.id)(host, port, timeoutMs)
      } catch (err) {
        // Defensive: probes are designed not to throw; never let one port
        // failure reject the whole report.
        return {
          protocolId: meta.id,
          port,
          status: 'error',
          detected: false,
          detail: err instanceof Error ? err.message : String(err),
          latencyMs: 0
        }
      }
    })
  )
  return { host, startedAt, durationMs: Date.now() - startedAt, results }
}
