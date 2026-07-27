// Client-side RFB handshake up to and including ServerInit parsing.
//
// Flow (RFB 3.8): version exchange -> security type list -> select and run
// one of type 1 (None) / 2 (VNC auth) / 30 (Apple DH) -> SecurityResult ->
// ClientInit -> ServerInit. RFB 3.3 servers (single U32 security type, no
// SecurityResult for None) are handled too; versions above 3.8 — including
// Apple's 3.889 — are clamped to 3.8 exactly like TigerVNC's CConnection.
//
// Go port of src/main/rfb/handshake.ts. Unlike the event-driven TS version,
// reads are plain blocking io.ReadFull calls gated by a single conn deadline.
package rfb

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var serverBannerRe = regexp.MustCompile(`^RFB (\d{3})\.(\d{3})\n$`)

// wire performs exact-size reads and writes on the handshake socket,
// classifying transport failures into the RFB error taxonomy.
type wire struct {
	conn    net.Conn
	timeout time.Duration
}

func (w wire) read(n int) ([]byte, error) {
	buf := make([]byte, n)
	if _, err := io.ReadFull(w.conn, buf); err != nil {
		return nil, w.classify(err)
	}
	return buf, nil
}

func (w wire) write(data []byte) error {
	if _, err := w.conn.Write(data); err != nil {
		return w.classify(err)
	}
	return nil
}

func (w wire) classify(err error) error {
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return &RfbTimeoutError{
			Message: fmt.Sprintf("RFB handshake timed out after %d ms", w.timeout.Milliseconds()),
		}
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return &RfbConnectionError{Message: "connection closed during handshake"}
	}
	return &RfbConnectionError{Message: fmt.Sprintf("socket error during handshake: %v", err)}
}

// PerformHandshake runs the full client handshake on an already-connected
// socket and returns the parsed ServerInit once the server is ready for
// normal RFB traffic. The socket stays open on success (deadline cleared);
// on a timeout it is closed, mirroring the TS socket.destroy().
func PerformHandshake(conn net.Conn, opts HandshakeOptions) (ServerInitInfo, error) {
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = DefaultHandshakeTimeout
	}
	if err := conn.SetDeadline(time.Now().Add(timeout)); err != nil {
		return ServerInitInfo{}, &RfbConnectionError{
			Message: fmt.Sprintf("failed to set handshake deadline: %v", err),
		}
	}
	w := wire{conn: conn, timeout: timeout}
	info, err := performHandshake(w, opts)
	if err != nil {
		var timeoutErr *RfbTimeoutError
		if errors.As(err, &timeoutErr) {
			conn.Close()
		}
		return ServerInitInfo{}, err
	}
	_ = conn.SetDeadline(time.Time{})
	return info, nil
}

// ProbeSecurityTypes performs the version exchange and security type list
// read only — used by diagnostics to inspect a server without committing to
// auth. The socket is left open (deadline cleared); the caller must close it.
func ProbeSecurityTypes(conn net.Conn, timeout time.Duration) (serverVersion string, types []byte, err error) {
	if timeout <= 0 {
		timeout = DefaultHandshakeTimeout
	}
	if err := conn.SetDeadline(time.Now().Add(timeout)); err != nil {
		return "", nil, &RfbConnectionError{
			Message: fmt.Sprintf("failed to set handshake deadline: %v", err),
		}
	}
	defer func() { _ = conn.SetDeadline(time.Time{}) }()
	w := wire{conn: conn, timeout: timeout}
	version, minor, err := negotiateVersion(w)
	if err != nil {
		return "", nil, err
	}
	offered, err := readSecurityTypes(w, minor)
	if err != nil {
		return "", nil, err
	}
	return version, offered, nil
}

func performHandshake(w wire, opts HandshakeOptions) (ServerInitInfo, error) {
	serverVersion, minor, err := negotiateVersion(w)
	if err != nil {
		return ServerInitInfo{}, err
	}
	offered, err := readSecurityTypes(w, minor)
	if err != nil {
		return ServerInitInfo{}, err
	}
	var secType int
	if minor == 3 {
		secType, err = validateV33Type(offered[0])
	} else {
		secType, err = selectSecurityType(offered, opts.Password != "")
	}
	if err != nil {
		return ServerInitInfo{}, err
	}
	if minor != 3 {
		// 3.3: the server dictates the type; there is no selection message.
		if err := w.write([]byte{byte(secType)}); err != nil {
			return ServerInitInfo{}, err
		}
	}
	if err := performAuth(w, secType, opts, minor); err != nil {
		return ServerInitInfo{}, err
	}
	if err := w.write([]byte{1}); err != nil { // ClientInit: shared session
		return ServerInitInfo{}, err
	}
	info, err := readServerInit(w)
	if err != nil {
		return ServerInitInfo{}, err
	}
	info.ServerVersion = serverVersion
	info.SecurityType = secType
	return info, nil
}

// negotiateVersion reads the server banner, clamps to 3.3/3.7/3.8 like
// TigerVNC, and replies with the selected version.
func negotiateVersion(w wire) (serverVersion string, minor int, err error) {
	bannerBytes, err := w.read(12)
	if err != nil {
		return "", 0, err
	}
	banner := string(bannerBytes)
	match := serverBannerRe.FindStringSubmatch(banner)
	if match == nil {
		return "", 0, &RfbProtocolError{
			Message: fmt.Sprintf("not an RFB server (banner: %q)", banner),
		}
	}
	major, _ := strconv.Atoi(match[1])
	serverMinor, _ := strconv.Atoi(match[2])
	if major != 3 || serverMinor < 3 {
		return "", 0, &RfbProtocolError{
			Message: fmt.Sprintf("unsupported RFB version %s.%s", match[1], match[2]),
		}
	}
	// 3.3..3.6 downgrade to 3.3; anything above 3.8 (e.g. Apple's 3.889) -> 3.8.
	minor = serverMinor
	if minor < 7 {
		minor = 3
	} else if minor > 8 {
		minor = 8
	}
	if err := w.write([]byte(fmt.Sprintf("RFB 003.00%d\n", minor))); err != nil {
		return "", 0, err
	}
	return match[1] + "." + match[2], minor, nil
}

// readSecurityTypes reads the offered security types (single U32 in 3.3,
// count+list in 3.7+).
func readSecurityTypes(w wire, minor int) ([]byte, error) {
	if minor == 3 {
		raw, err := w.read(4)
		if err != nil {
			return nil, err
		}
		secType := binary.BigEndian.Uint32(raw)
		if secType == 0 {
			reason, err := readReason(w)
			if err != nil {
				return nil, err
			}
			return nil, &RfbProtocolError{Message: "server refused connection: " + reason}
		}
		return []byte{byte(secType)}, nil
	}
	countRaw, err := w.read(1)
	if err != nil {
		return nil, err
	}
	count := int(countRaw[0])
	if count == 0 {
		reason, err := readReason(w)
		if err != nil {
			return nil, err
		}
		return nil, &RfbProtocolError{Message: "server refused connection: " + reason}
	}
	return w.read(count)
}

// readReason reads a U32-length-prefixed reason string (3.8 failure messages).
func readReason(w wire) (string, error) {
	lengthRaw, err := w.read(4)
	if err != nil {
		return "", err
	}
	length := binary.BigEndian.Uint32(lengthRaw)
	if length == 0 {
		return "(no reason given)", nil
	}
	reason, err := w.read(int(length))
	if err != nil {
		return "", err
	}
	return string(reason), nil
}

// selectSecurityType picks the best offered type: authenticated types win
// when we have a password.
func selectSecurityType(offered []byte, hasPassword bool) (int, error) {
	if hasPassword && containsType(offered, SecTypeAppleDH) {
		return SecTypeAppleDH, nil
	}
	if hasPassword && containsType(offered, SecTypeVNCAuth) {
		return SecTypeVNCAuth, nil
	}
	if containsType(offered, SecTypeNone) {
		return SecTypeNone, nil
	}
	if containsType(offered, SecTypeAppleDH) || containsType(offered, SecTypeVNCAuth) {
		return 0, &RfbAuthError{
			Message: "server requires authentication but no password was provided",
		}
	}
	list := make([]string, len(offered))
	for i, t := range offered {
		list[i] = strconv.Itoa(int(t))
	}
	return 0, &RfbProtocolError{
		Message: fmt.Sprintf("no supported security type in server list [%s]", strings.Join(list, ", ")),
	}
}

func containsType(offered []byte, secType int) bool {
	for _, t := range offered {
		if t == byte(secType) {
			return true
		}
	}
	return false
}

func validateV33Type(secType byte) (int, error) {
	if secType == SecTypeNone || secType == SecTypeVNCAuth {
		return int(secType), nil
	}
	return 0, &RfbProtocolError{
		Message: fmt.Sprintf("RFB 3.3 server demanded unsupported security type %d", secType),
	}
}

// performAuth runs the selected security exchange and evaluates the
// SecurityResult.
func performAuth(w wire, secType int, opts HandshakeOptions, minor int) error {
	switch secType {
	case SecTypeNone:
	case SecTypeVNCAuth:
		challenge, err := w.read(16)
		if err != nil {
			return err
		}
		response, err := EncryptVncChallenge(challenge, opts.Password)
		if err != nil {
			return err
		}
		if err := w.write(response); err != nil {
			return err
		}
	case SecTypeAppleDH:
		if err := performAppleDHAuth(w, opts.Username, opts.Password); err != nil {
			return err
		}
	default:
		return &RfbProtocolError{Message: fmt.Sprintf("unsupported security type %d", secType)}
	}
	if minor == 3 && secType == SecTypeNone {
		return nil // RFB 3.3 + None: no SecurityResult
	}
	resultRaw, err := w.read(4)
	if err != nil {
		return err
	}
	if binary.BigEndian.Uint32(resultRaw) != 0 {
		reason := "authentication failed"
		if minor >= 8 {
			if reason, err = readReason(w); err != nil {
				return err
			}
		}
		return &RfbAuthError{Message: reason}
	}
	return nil
}

// readServerInit parses the ServerInit message following ClientInit.
func readServerInit(w wire) (ServerInitInfo, error) {
	head, err := w.read(24)
	if err != nil {
		return ServerInitInfo{}, err
	}
	nameBytes, err := w.read(int(binary.BigEndian.Uint32(head[20:24])))
	if err != nil {
		return ServerInitInfo{}, err
	}
	pf := head[4:20]
	raw := make([]byte, 0, len(head)+len(nameBytes))
	raw = append(raw, head...)
	raw = append(raw, nameBytes...)
	return ServerInitInfo{
		Width:  binary.BigEndian.Uint16(head[0:2]),
		Height: binary.BigEndian.Uint16(head[2:4]),
		PixelFormat: VncPixelFormat{
			BitsPerPixel: pf[0],
			Depth:        pf[1],
			BigEndian:    pf[2] != 0,
			TrueColor:    pf[3] != 0,
			RedMax:       binary.BigEndian.Uint16(pf[4:6]),
			GreenMax:     binary.BigEndian.Uint16(pf[6:8]),
			BlueMax:      binary.BigEndian.Uint16(pf[8:10]),
			RedShift:     pf[10],
			GreenShift:   pf[11],
			BlueShift:    pf[12],
		},
		Name: string(nameBytes),
		Raw:  raw,
	}, nil
}
