/**
 * RFB security type 2 (VNC authentication): the server sends a 16-byte
 * challenge, the client replies with the challenge DES-ECB-encrypted under
 * the bit-reversed, 8-byte-truncated password (see des.ts).
 *
 * OpenSSL 3 usually hides DES in the legacy provider, so `des-ecb` is probed
 * at startup and the pure-JS implementation from des.ts is used as fallback.
 * Both paths take the same key bytes and are interchangeable.
 */

import crypto from 'node:crypto'
import { desEncryptEcb, vncPasswordKey } from './des'

const hasOpenSslDes = crypto.getCiphers().includes('des-ecb')

/** Which DES backend encryptVncChallenge is using (exposed for tests). */
export const vncAuthBackend: 'openssl' | 'js' = hasOpenSslDes ? 'openssl' : 'js'

/** Encrypts the 16-byte server challenge with the VNC password. */
export function encryptVncChallenge(challenge: Uint8Array, password: string): Buffer {
  if (challenge.length !== 16) throw new Error('VNC challenge must be 16 bytes')
  const key = Buffer.from(vncPasswordKey(password))
  if (hasOpenSslDes) {
    const cipher = crypto.createCipheriv('des-ecb', key, null)
    cipher.setAutoPadding(false)
    return Buffer.concat([cipher.update(challenge), cipher.final()])
  }
  return Buffer.from(desEncryptEcb(challenge, key))
}
