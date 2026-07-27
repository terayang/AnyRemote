// RFB security type 2 (VNC authentication): the server sends a 16-byte
// challenge, the client replies with the challenge DES-ECB-encrypted under
// the bit-reversed, 8-byte-truncated password. Go port of
// src/main/rfb/vncAuth.ts + des.ts; unlike the TS version (which ships a
// pure-JS DES fallback), Go's crypto/des is always available.
package rfb

import (
	"crypto/des"
	"errors"
)

// VncPasswordKey builds the DES key for VNC authentication: the password is
// truncated or zero-padded to 8 bytes and every byte's bits are reversed
// (VNC convention, inherited from the original X VNC implementation).
func VncPasswordKey(password string) []byte {
	passwordBytes := []byte(password)
	key := make([]byte, 8)
	for i := 0; i < 8; i++ {
		var b byte
		if i < len(passwordBytes) {
			b = passwordBytes[i]
		}
		var reversed byte
		for bit := 0; bit < 8; bit++ {
			reversed = (reversed << 1) | ((b >> uint(bit)) & 1)
		}
		key[i] = reversed
	}
	return key
}

// EncryptVncChallenge encrypts the 16-byte server challenge with the VNC
// password (DES-ECB, two blocks, no padding).
func EncryptVncChallenge(challenge []byte, password string) ([]byte, error) {
	if len(challenge) != 16 {
		return nil, errors.New("VNC challenge must be 16 bytes")
	}
	cipher, err := des.NewCipher(VncPasswordKey(password))
	if err != nil {
		return nil, err
	}
	out := make([]byte, 16)
	cipher.Encrypt(out[0:8], challenge[0:8])
	cipher.Encrypt(out[8:16], challenge[8:16])
	return out, nil
}
