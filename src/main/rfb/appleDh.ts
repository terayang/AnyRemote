/**
 * RFB security type 30: Apple's proprietary Diffie-Hellman authentication,
 * used by macOS Screen Sharing / Remote Desktop. Ported from TigerVNC's
 * CSecurityDH (_ref/tigervnc/common/rfb/CSecurityDH.cxx).
 *
 * Wire format after the client selects type 30 (all integers big-endian,
 * bignum fields zero-padded to exactly keyLength bytes):
 *
 *   server -> client:  gen:U16, keyLength:U16, p[keyLength], A[keyLength]
 *                      (g = gen, p = prime, A = g^a mod p server public key;
 *                      keyLength is in BYTES, valid range 128..1024)
 *   client -> server:  encryptedCredentials[128], B[keyLength]
 *                      (B = g^b mod p client public key, b random)
 *
 * Key derivation and credential block:
 *   k            = A^b mod p (shared secret), serialized to keyLength bytes
 *   key          = MD5(k)
 *   plain[128]   = random fill; username (UTF-8, NUL-terminated, max 63
 *                  bytes) at offset 0, password (same layout) at offset 64
 *   credentials  = AES-128-ECB encrypt of the whole 128-byte block (8 blocks,
 *                  no padding, no IV)
 *
 * The exchange is followed by the common RFB SecurityResult (handled by the
 * caller). DH math is done with BigInt modpow instead of crypto's DH object
 * to guarantee the zero-padded keyLength-byte serialization the protocol
 * requires (OpenSSL strips leading zeros).
 */

import crypto from 'node:crypto'
import { RfbAuthError, RfbProtocolError } from './types'

const MIN_KEY_LENGTH = 128
const MAX_KEY_LENGTH = 1024
const CREDENTIAL_BLOCK_SIZE = 128
const CREDENTIAL_FIELD_SIZE = 64

/** Minimal async byte source (implemented by handshake's ChunkReader). */
export interface ByteReader {
  read(n: number): Promise<Buffer>
}

/** Minimal byte sink (a net.Socket satisfies this). */
export interface ByteWriter {
  write(data: Buffer): unknown
}

/** base^exp mod mod, all positive BigInts. */
export function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n
  base %= mod
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod
    base = (base * base) % mod
    exp >>= 1n
  }
  return result
}

export function bytesToBigInt(bytes: Uint8Array): bigint {
  if (bytes.length === 0) return 0n
  return BigInt('0x' + Buffer.from(bytes).toString('hex'))
}

/** Serializes a non-negative BigInt big-endian, zero-padded to exactly length. */
export function bigIntToBytes(value: bigint, length: number): Buffer {
  return Buffer.from(value.toString(16).padStart(length * 2, '0'), 'hex')
}

/**
 * Runs the client side of the Apple DH exchange: reads the server's DH
 * parameters and public key, then sends the encrypted credentials and the
 * client's public key. Throws RfbProtocolError on malformed parameters and
 * RfbAuthError when credentials cannot be encoded (too long).
 */
export async function performAppleDhAuth(
  reader: ByteReader,
  writer: ByteWriter,
  credentials: { username?: string; password?: string }
): Promise<void> {
  const header = await reader.read(4)
  const generator = header.readUInt16BE(0)
  const keyLength = header.readUInt16BE(2)
  if (keyLength < MIN_KEY_LENGTH || keyLength > MAX_KEY_LENGTH) {
    throw new RfbProtocolError(`Apple DH key length ${keyLength} out of range`)
  }
  const p = bytesToBigInt(await reader.read(keyLength))
  const serverPublic = bytesToBigInt(await reader.read(keyLength))
  if (generator < 2 || p <= 0n || serverPublic <= 1n || serverPublic >= p) {
    throw new RfbProtocolError('Apple DH server sent invalid parameters')
  }

  const clientPrivate = bytesToBigInt(crypto.randomBytes(keyLength))
  const sharedSecret = bigIntToBytes(modPow(serverPublic, clientPrivate, p), keyLength)
  const clientPublic = bigIntToBytes(modPow(BigInt(generator), clientPrivate, p), keyLength)

  const key = crypto.createHash('md5').update(sharedSecret).digest()
  const plain = crypto.randomBytes(CREDENTIAL_BLOCK_SIZE)
  writeCredentialField(plain, 0, credentials.username ?? '', 'username')
  writeCredentialField(plain, CREDENTIAL_FIELD_SIZE, credentials.password ?? '', 'password')

  const cipher = crypto.createCipheriv('aes-128-ecb', key, null)
  cipher.setAutoPadding(false)
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
  writer.write(Buffer.concat([encrypted, clientPublic]))
}

/** Copies a NUL-terminated UTF-8 credential into the 64-byte field at offset. */
function writeCredentialField(
  block: Buffer,
  offset: number,
  value: string,
  label: string
): void {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length >= CREDENTIAL_FIELD_SIZE) {
    throw new RfbAuthError(`${label} too long for Apple DH (max 63 bytes)`)
  }
  bytes.copy(block, offset)
  block[offset + bytes.length] = 0 // NUL terminator; the rest stays random
}
