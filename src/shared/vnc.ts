/**
 * Shared types for the VNC path: the RFB handshake result produced by
 * src/main/rfb/ and the error contract of the local WebSocket bridge
 * (src/main/vncBridge.ts) consumed by the renderer's noVNC client.
 */

/** Pixel format advertised by the server in the RFB ServerInit message. */
export interface VncPixelFormat {
  bitsPerPixel: number
  depth: number
  bigEndian: boolean
  trueColor: boolean
  redMax: number
  greenMax: number
  blueMax: number
  redShift: number
  greenShift: number
  blueShift: number
}

/** Parsed ServerInit message, the end product of a successful RFB handshake. */
export interface ServerInitInfo {
  /** Framebuffer width in pixels. */
  width: number
  /** Framebuffer height in pixels. */
  height: number
  pixelFormat: VncPixelFormat
  /** Desktop name (UTF-8). */
  name: string
  /** Raw ServerInit bytes, replayed verbatim to the bridged noVNC client. */
  raw: Uint8Array
}

/** Credentials for RFB security types that need them (2 = VNC auth, 30 = Apple DH). */
export interface VncCredentials {
  username?: string
  password?: string
}

/** Failure categories surfaced over the bridge WebSocket close handshake. */
export type VncBridgeErrorKind = 'auth' | 'connection' | 'protocol' | 'timeout' | 'busy'

/** Structured payload sent as the WebSocket close reason when the bridge fails. */
export interface VncBridgeError {
  kind: VncBridgeErrorKind
  message: string
}

/**
 * WebSocket close codes used by the bridge (4000-4999 is the private-use
 * range). The renderer maps these onto user-facing messages.
 */
export const VNC_BRIDGE_CLOSE_CODES: Record<VncBridgeErrorKind, number> = {
  auth: 4001,
  connection: 4002,
  protocol: 4003,
  timeout: 4008,
  busy: 1013 // RFC 6455 "Try Again Later": a second client while one is active
}
