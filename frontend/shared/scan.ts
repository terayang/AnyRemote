/**
 * Types for the protocol scanner (main process) and its consumers (renderer
 * protocol cards). A scan probes every known protocol port on a target host
 * concurrently and reports one fingerprint result per protocol.
 */

export type ScanStatus = 'open' | 'closed' | 'timeout' | 'error'

export interface ProtocolScanResult {
  /** Protocol id from src/shared/protocols.ts. */
  protocolId: string
  /** Port that was actually probed (default or overridden). */
  port: number
  status: ScanStatus
  /** True when the fingerprint confirms the expected protocol. */
  detected: boolean
  /** Server banner when one was read, e.g. 'SSH-2.0-OpenSSH_9.9' or 'RFB 003.889'. */
  banner?: string
  /** Extra info (TLS version, RDP security flags) or error detail. */
  detail?: string
  latencyMs: number
}

export interface TargetScanReport {
  host: string
  startedAt: number
  durationMs: number
  results: ProtocolScanResult[]
}
