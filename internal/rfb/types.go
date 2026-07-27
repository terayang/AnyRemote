// Package rfb implements the client side of the RFB handshake (version
// exchange, security types None/VNC auth/Apple DH, ServerInit parsing).
// It is a Go port of src/main/rfb/ (handshake.ts, appleDh.ts, vncAuth.ts).
package rfb

import "time"

// RFB security types implemented by the handshake (rfb/Security.h).
const (
	SecTypeNone    = 1
	SecTypeVNCAuth = 2
	// SecTypeAppleDH is Apple's proprietary Diffie-Hellman authentication
	// ("DH" in TigerVNC), used by macOS Screen Sharing / Remote Desktop.
	SecTypeAppleDH = 30
)

// DefaultHandshakeTimeout is the overall handshake deadline (TS: 10000 ms).
const DefaultHandshakeTimeout = 10 * time.Second

// VncPixelFormat is the pixel format advertised by the server in ServerInit.
type VncPixelFormat struct {
	BitsPerPixel uint8
	Depth        uint8
	BigEndian    bool
	TrueColor    bool
	RedMax       uint16
	GreenMax     uint16
	BlueMax      uint16
	RedShift     uint8
	GreenShift   uint8
	BlueShift    uint8
}

// ServerInitInfo is the end product of a successful RFB handshake.
type ServerInitInfo struct {
	Width       uint16
	Height      uint16
	PixelFormat VncPixelFormat
	// Name is the desktop name (UTF-8).
	Name string
	// Raw holds the verbatim ServerInit bytes, replayed to a bridged client.
	Raw []byte
	// ServerVersion is the version the server advertised, e.g. "003.889".
	ServerVersion string
	// SecurityType is the security type that authenticated the session (1, 2 or 30).
	SecurityType int
}

// HandshakeOptions configures PerformHandshake.
type HandshakeOptions struct {
	Username string
	Password string
	// Timeout is the overall handshake deadline (default DefaultHandshakeTimeout).
	Timeout time.Duration
}
