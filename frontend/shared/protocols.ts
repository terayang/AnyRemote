/**
 * Protocol metadata shared between the main process (scanner) and the
 * renderer (protocol cards). This table is the single data source for
 * which ports to probe and how to present each protocol to the user.
 */

export type ProtocolId =
  | 'ssh'
  | 'vnc'
  | 'rdp'
  | 'telnet'
  | 'ftp'
  | 'smb'
  | 'http'
  | 'https'

export interface ProtocolMeta {
  /** Stable machine identifier. */
  id: ProtocolId
  /** Display name (protocols are proper nouns, not translated). */
  name: string
  /** Well-known default port used by the scanner. */
  defaultPort: number
  /** i18n key (under src/renderer/i18n) holding the plain-language description. */
  descriptionKey: string
  /** Whether the MVP can actually open a session for this protocol. */
  mvpSupported: boolean
}

export const PROTOCOLS: readonly ProtocolMeta[] = [
  {
    id: 'ssh',
    name: 'SSH',
    defaultPort: 22,
    descriptionKey: 'protocols.desc.ssh',
    mvpSupported: true
  },
  {
    id: 'vnc',
    name: 'VNC',
    defaultPort: 5900,
    descriptionKey: 'protocols.desc.vnc',
    mvpSupported: true
  },
  {
    id: 'rdp',
    name: 'RDP',
    defaultPort: 3389,
    descriptionKey: 'protocols.desc.rdp',
    mvpSupported: false
  },
  {
    id: 'telnet',
    name: 'Telnet',
    defaultPort: 23,
    descriptionKey: 'protocols.desc.telnet',
    mvpSupported: false
  },
  {
    id: 'ftp',
    name: 'FTP',
    defaultPort: 21,
    descriptionKey: 'protocols.desc.ftp',
    mvpSupported: false
  },
  {
    id: 'smb',
    name: 'SMB',
    defaultPort: 445,
    descriptionKey: 'protocols.desc.smb',
    mvpSupported: false
  },
  {
    id: 'http',
    name: 'HTTP',
    defaultPort: 80,
    descriptionKey: 'protocols.desc.http',
    mvpSupported: false
  },
  {
    id: 'https',
    name: 'HTTPS',
    defaultPort: 443,
    descriptionKey: 'protocols.desc.https',
    mvpSupported: false
  }
]

export const PROTOCOL_BY_ID: Readonly<Record<ProtocolId, ProtocolMeta>> = Object.fromEntries(
  PROTOCOLS.map((p) => [p.id, p])
) as Record<ProtocolId, ProtocolMeta>
