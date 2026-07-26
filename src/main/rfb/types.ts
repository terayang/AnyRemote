/**
 * Shared constants and error classes for the RFB client handshake.
 *
 * Error taxonomy (distinguishable via `instanceof`):
 * - RfbAuthError: the server rejected the credentials (SecurityResult != 0)
 * - RfbProtocolError: the peer does not speak RFB or violates it
 * - RfbTimeoutError: no progress within the configured deadline
 * - RfbConnectionError: the socket errored or closed mid-handshake
 */

export class RfbError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

export class RfbAuthError extends RfbError {}
export class RfbProtocolError extends RfbError {}
export class RfbTimeoutError extends RfbError {}
export class RfbConnectionError extends RfbError {}

/** RFB security types implemented by the handshake (rfb/Security.h). */
export const SEC_TYPE_NONE = 1
export const SEC_TYPE_VNC_AUTH = 2
/** Apple proprietary Diffie-Hellman authentication ("DH" in TigerVNC). */
export const SEC_TYPE_APPLE_DH = 30
