// RFB security type 30: Apple's proprietary Diffie-Hellman authentication,
// used by macOS Screen Sharing / Remote Desktop. Ported from TigerVNC's
// CSecurityDH (_ref/tigervnc/common/rfb/CSecurityDH.cxx) via the TS port in
// src/main/rfb/appleDh.ts.
//
// Wire format after the client selects type 30 (all integers big-endian,
// bignum fields zero-padded to exactly keyLength bytes):
//
//	server -> client:  gen:U16, keyLength:U16, p[keyLength], A[keyLength]
//	                   (g = gen, p = prime, A = g^a mod p server public key;
//	                   keyLength is in BYTES, valid range 128..1024)
//	client -> server:  encryptedCredentials[128], B[keyLength]
//	                   (B = g^b mod p client public key, b random)
//
// Key derivation and credential block:
//
//	k            = A^b mod p (shared secret), serialized to keyLength bytes
//	key          = MD5(k)
//	plain[128]   = random fill; username (UTF-8, NUL-terminated, max 63
//	               bytes) at offset 0, password (same layout) at offset 64
//	credentials  = AES-128-ECB encrypt of the whole 128-byte block (8 blocks,
//	               no padding, no IV)
//
// The exchange is followed by the common RFB SecurityResult (handled by the
// caller). DH math uses math/big modpow to guarantee the zero-padded
// keyLength-byte serialization the protocol requires (OpenSSL-style DH APIs
// strip leading zeros). Go has no AES-ECB mode, so ECB is a manual loop of
// single-block encryptions.
package rfb

import (
	"crypto/aes"
	"crypto/md5"
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"math/big"
)

const (
	minDHKeyLength      = 128
	maxDHKeyLength      = 1024
	credentialBlockSize = 128
	credentialFieldSize = 64
)

// ModPow returns base^exp mod mod, all positive. Exported for tests.
func ModPow(base, exp, mod *big.Int) *big.Int {
	return new(big.Int).Exp(base, exp, mod)
}

// BigIntToBytes serializes a non-negative integer big-endian, zero-padded to
// exactly length bytes. Exported for tests.
func BigIntToBytes(value *big.Int, length int) []byte {
	b := value.Bytes()
	if len(b) >= length {
		return b
	}
	out := make([]byte, length)
	copy(out[length-len(b):], b)
	return out
}

// performAppleDHAuth runs the client side of the Apple DH exchange: reads the
// server's DH parameters and public key, then sends the encrypted credentials
// and the client's public key.
func performAppleDHAuth(w wire, username, password string) error {
	header, err := w.read(4)
	if err != nil {
		return err
	}
	generator := binary.BigEndian.Uint16(header[0:2])
	keyLength := int(binary.BigEndian.Uint16(header[2:4]))
	if keyLength < minDHKeyLength || keyLength > maxDHKeyLength {
		return &RfbProtocolError{
			Message: fmt.Sprintf("Apple DH key length %d out of range", keyLength),
		}
	}
	pBytes, err := w.read(keyLength)
	if err != nil {
		return err
	}
	aBytes, err := w.read(keyLength)
	if err != nil {
		return err
	}
	p := new(big.Int).SetBytes(pBytes)
	serverPublic := new(big.Int).SetBytes(aBytes)
	if generator < 2 || p.Sign() <= 0 || serverPublic.Cmp(big.NewInt(1)) <= 0 || serverPublic.Cmp(p) >= 0 {
		return &RfbProtocolError{Message: "Apple DH server sent invalid parameters"}
	}

	privateBytes := make([]byte, keyLength)
	if _, err := rand.Read(privateBytes); err != nil {
		return &RfbConnectionError{Message: fmt.Sprintf("failed to generate DH private key: %v", err)}
	}
	clientPrivate := new(big.Int).SetBytes(privateBytes)
	g := new(big.Int).SetUint64(uint64(generator))
	sharedSecret := BigIntToBytes(ModPow(serverPublic, clientPrivate, p), keyLength)
	clientPublic := BigIntToBytes(ModPow(g, clientPrivate, p), keyLength)

	key := md5.Sum(sharedSecret)
	plain := make([]byte, credentialBlockSize)
	if _, err := rand.Read(plain); err != nil {
		return &RfbConnectionError{Message: fmt.Sprintf("failed to generate credential block: %v", err)}
	}
	if err := writeCredentialField(plain, 0, username, "username"); err != nil {
		return err
	}
	if err := writeCredentialField(plain, credentialFieldSize, password, "password"); err != nil {
		return err
	}

	block, err := aes.NewCipher(key[:])
	if err != nil {
		return &RfbProtocolError{Message: fmt.Sprintf("failed to init AES-128: %v", err)}
	}
	encrypted := make([]byte, credentialBlockSize)
	for offset := 0; offset < credentialBlockSize; offset += aes.BlockSize {
		block.Encrypt(encrypted[offset:offset+aes.BlockSize], plain[offset:offset+aes.BlockSize])
	}
	return w.write(append(encrypted, clientPublic...))
}

// writeCredentialField copies a NUL-terminated UTF-8 credential into the
// 64-byte field at offset; the rest of the field stays random.
func writeCredentialField(block []byte, offset int, value, label string) error {
	b := []byte(value)
	if len(b) >= credentialFieldSize {
		return &RfbAuthError{
			Message: fmt.Sprintf("%s too long for Apple DH (max 63 bytes)", label),
		}
	}
	copy(block[offset:], b)
	block[offset+len(b)] = 0
	return nil
}
