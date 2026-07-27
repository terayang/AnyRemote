package scanner

import (
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// startFakeServer starts a throwaway server on an ephemeral loopback port.
// The handler runs per accepted connection; servers and connections are
// closed via t.Cleanup.
func startFakeServer(t *testing.T, handler func(conn net.Conn)) (net.Listener, int) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	var conns sync.Map // net.Conn -> struct{}, so cleanup can kill open conns
	done := make(chan struct{})
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				select {
				case <-done:
					return
				default:
					return
				}
			}
			conns.Store(conn, struct{}{})
			go func() {
				defer conns.Delete(conn)
				handler(conn)
			}()
		}
	}()
	t.Cleanup(func() {
		close(done)
		ln.Close()
		conns.Range(func(key, _ any) bool {
			key.(net.Conn).Close()
			return true
		})
	})
	return ln, ln.Addr().(*net.TCPAddr).Port
}

// writeAndClose writes the banner then closes, like the TS fake servers
// (s.write / s.end) do — the client fingerprint fires on the first chunk.
func writeAndClose(banner []byte) func(net.Conn) {
	return func(conn net.Conn) {
		conn.Write(banner)
		conn.Close()
	}
}

// TPKT + X.224 CC + RDP_NEG_RESP selecting PROTOCOL_HYBRID (CredSSP, 0x2).
var rdpNegResp = []byte{
	0x03, 0x00, 0x00, 0x13, // TPKT v3, total length 19
	0x0e, 0xd0, 0x00, 0x00, 0x12, 0x34, 0x00, // X.224 CC TPDU
	0x02, 0x00, 0x08, 0x00, // RDP_NEG_RESP, flags 0, length 8
	0x02, 0x00, 0x00, 0x00, // selectedProtocol: HYBRID
}

// scanOne scans a single protocol against a single fake-server port.
func scanOne(t *testing.T, protocolID string, port int, timeout time.Duration) ProtocolScanResult {
	t.Helper()
	report, err := ScanTarget("127.0.0.1",
		WithProtocols(protocolID),
		WithPortOverrides(map[string]int{protocolID: port}),
		WithTimeout(timeout),
	)
	if err != nil {
		t.Fatalf("ScanTarget: %v", err)
	}
	if len(report.Results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(report.Results))
	}
	return report.Results[0]
}

func TestDetectsSSHAndParsesBanner(t *testing.T) {
	_, port := startFakeServer(t, writeAndClose([]byte("SSH-2.0-OpenSSH_9.9\r\n")))
	r := scanOne(t, "ssh", port, time.Second)
	if r.Status != StatusOpen {
		t.Errorf("status = %q, want open", r.Status)
	}
	if !r.Detected {
		t.Error("detected = false, want true")
	}
	if r.Banner != "SSH-2.0-OpenSSH_9.9" {
		t.Errorf("banner = %q", r.Banner)
	}
	if r.Port != port {
		t.Errorf("port = %d, want %d", r.Port, port)
	}
	if r.LatencyMs < 0 {
		t.Errorf("latencyMs = %d, want >= 0", r.LatencyMs)
	}
}

func TestDetectsVNCAndParsesRFBVersion(t *testing.T) {
	_, port := startFakeServer(t, writeAndClose([]byte("RFB 003.889\n")))
	r := scanOne(t, "vnc", port, time.Second)
	if r.Status != StatusOpen || !r.Detected {
		t.Errorf("status=%q detected=%v, want open/true", r.Status, r.Detected)
	}
	if r.Banner != "RFB 003.889" {
		t.Errorf("banner = %q", r.Banner)
	}
}

func TestDetectsFTPFrom220Greeting(t *testing.T) {
	_, port := startFakeServer(t, writeAndClose([]byte("220 fakeftpd 1.0 ready\r\n")))
	r := scanOne(t, "ftp", port, time.Second)
	if r.Status != StatusOpen || !r.Detected {
		t.Errorf("status=%q detected=%v, want open/true", r.Status, r.Detected)
	}
	if r.Banner != "220 fakeftpd 1.0 ready" {
		t.Errorf("banner = %q", r.Banner)
	}
}

func TestDetectsHTTPFromStatusLine(t *testing.T) {
	_, port := startFakeServer(t, func(conn net.Conn) {
		defer conn.Close()
		buf := make([]byte, 1024)
		if _, err := conn.Read(buf); err != nil {
			return
		}
		conn.Write([]byte("HTTP/1.0 200 OK\r\nContent-Length: 0\r\n\r\n"))
	})
	r := scanOne(t, "http", port, time.Second)
	if r.Status != StatusOpen || !r.Detected {
		t.Errorf("status=%q detected=%v, want open/true", r.Status, r.Detected)
	}
	if r.Banner != "HTTP/1.0 200 OK" {
		t.Errorf("banner = %q", r.Banner)
	}
}

func TestDetectsTelnetFromIACBytes(t *testing.T) {
	_, port := startFakeServer(t, writeAndClose([]byte{0xff, 0xfb, 0x01, 'l', 'o', 'g', 'i', 'n', ':', ' '}))
	r := scanOne(t, "telnet", port, time.Second)
	if r.Status != StatusOpen || !r.Detected {
		t.Errorf("status=%q detected=%v, want open/true", r.Status, r.Detected)
	}
	if r.Banner != "login: " {
		t.Errorf("banner = %q", r.Banner)
	}
}

func TestDetectsRDPAndParsesSelectedSecurity(t *testing.T) {
	var mu sync.Mutex
	var lastRequest []byte
	_, port := startFakeServer(t, func(conn net.Conn) {
		defer conn.Close()
		req := make([]byte, 19)
		if _, err := io.ReadFull(conn, req); err != nil {
			return
		}
		mu.Lock()
		lastRequest = req
		mu.Unlock()
		conn.Write(rdpNegResp)
	})
	r := scanOne(t, "rdp", port, time.Second)
	if r.Status != StatusOpen || !r.Detected {
		t.Errorf("status=%q detected=%v, want open/true", r.Status, r.Detected)
	}
	if !strings.Contains(r.Detail, "0x2") || !strings.Contains(r.Detail, "HYBRID") {
		t.Errorf("detail = %q, want it to contain 0x2 and HYBRID", r.Detail)
	}
	// The probe must have sent a well-formed X.224 CR carrying RDP_NEG_REQ.
	mu.Lock()
	defer mu.Unlock()
	if len(lastRequest) != 19 {
		t.Fatalf("request length = %d, want 19", len(lastRequest))
	}
	if lastRequest[0] != 0x03 {
		t.Errorf("request[0] = %#x, want 0x03 (TPKT v3)", lastRequest[0])
	}
	if lastRequest[5] != 0xe0 {
		t.Errorf("request[5] = %#x, want 0xe0 (X.224 CR)", lastRequest[5])
	}
	if lastRequest[11] != 0x01 {
		t.Errorf("request[11] = %#x, want 0x01 (RDP_NEG_REQ)", lastRequest[11])
	}
}

func TestDetectsSMBFromMagic(t *testing.T) {
	// Minimal fake: NetBIOS header + SMB2 header echoing the 0xFE 'SMB' magic.
	_, port := startFakeServer(t, func(conn net.Conn) {
		defer conn.Close()
		buf := make([]byte, 256)
		if _, err := conn.Read(buf); err != nil {
			return
		}
		resp := make([]byte, 68)
		copy(resp[4:], smb2Magic)
		conn.Write(resp)
	})
	r := scanOne(t, "smb", port, time.Second)
	if r.Status != StatusOpen || !r.Detected {
		t.Errorf("status=%q detected=%v, want open/true", r.Status, r.Detected)
	}
	if !strings.Contains(r.Detail, "SMB2 magic") {
		t.Errorf("detail = %q, want SMB2 magic mention", r.Detail)
	}
}

func TestScanAllProtocolsConcurrently(t *testing.T) {
	_, sshPort := startFakeServer(t, writeAndClose([]byte("SSH-2.0-OpenSSH_9.9\r\n")))
	_, vncPort := startFakeServer(t, writeAndClose([]byte("RFB 003.889\n")))
	_, ftpPort := startFakeServer(t, writeAndClose([]byte("220 fakeftpd 1.0 ready\r\n")))
	_, httpPort := startFakeServer(t, func(conn net.Conn) {
		defer conn.Close()
		buf := make([]byte, 1024)
		if _, err := conn.Read(buf); err != nil {
			return
		}
		conn.Write([]byte("HTTP/1.0 200 OK\r\nContent-Length: 0\r\n\r\n"))
	})
	_, telnetPort := startFakeServer(t, writeAndClose([]byte{0xff, 0xfb, 0x01, 'l', 'o', 'g', 'i', 'n', ':', ' '}))
	_, rdpPort := startFakeServer(t, func(conn net.Conn) {
		defer conn.Close()
		req := make([]byte, 19)
		if _, err := io.ReadFull(conn, req); err != nil {
			return
		}
		conn.Write(rdpNegResp)
	})

	// Grab a guaranteed-closed port: listen once, then close the listener.
	tmpLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	closedPort := tmpLn.Addr().(*net.TCPAddr).Port
	tmpLn.Close()

	report, err := ScanTarget("127.0.0.1",
		WithTimeout(time.Second),
		WithPortOverrides(map[string]int{
			"ssh":    sshPort,
			"vnc":    vncPort,
			"ftp":    ftpPort,
			"http":   httpPort,
			"telnet": telnetPort,
			"rdp":    rdpPort,
			"smb":    closedPort,
			"https":  closedPort,
		}),
	)
	if err != nil {
		t.Fatalf("ScanTarget: %v", err)
	}
	if report.Host != "127.0.0.1" {
		t.Errorf("host = %q", report.Host)
	}
	if report.StartedAt <= 0 {
		t.Errorf("startedAt = %d, want > 0", report.StartedAt)
	}
	if report.DurationMs < 0 {
		t.Errorf("durationMs = %d, want >= 0", report.DurationMs)
	}
	if len(report.Results) != 8 {
		t.Fatalf("results length = %d, want 8", len(report.Results))
	}
	byID := make(map[string]ProtocolScanResult, len(report.Results))
	for _, r := range report.Results {
		byID[r.ProtocolID] = r
	}
	for _, id := range []string{"ssh", "vnc", "ftp", "http", "telnet", "rdp"} {
		r, ok := byID[id]
		if !ok {
			t.Fatalf("missing result for %s", id)
		}
		if r.Status != StatusOpen || !r.Detected {
			t.Errorf("%s: status=%q detected=%v, want open/true", id, r.Status, r.Detected)
		}
	}
	if r := byID["smb"]; r.Status != StatusClosed || r.Detected {
		t.Errorf("smb: status=%q detected=%v, want closed/false", r.Status, r.Detected)
	}
	if r := byID["https"]; r.Status != StatusClosed || r.Detected {
		t.Errorf("https: status=%q detected=%v, want closed/false", r.Status, r.Detected)
	}
}

// closedPort returns a port that is guaranteed closed by opening and
// immediately closing a listener.
func closedPort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	return port
}

func TestErrorMappingConnRefusedIsClosed(t *testing.T) {
	port := closedPort(t)
	r := scanOne(t, "ssh", port, time.Second)
	if r.Status != StatusClosed {
		t.Errorf("status = %q, want closed", r.Status)
	}
	if r.Detected {
		t.Error("detected = true, want false")
	}
	if r.Banner != "" {
		t.Errorf("banner = %q, want empty", r.Banner)
	}
}

func TestResetAfterAcceptIsOpenNotDetected(t *testing.T) {
	_, port := startFakeServer(t, func(conn net.Conn) {
		// Force a RST by closing with unread data pending? Simpler and close
		// to the TS fake (s.destroy()): just close immediately — the client
		// sees EOF/reset after a successful connect.
		conn.Close()
	})
	r := scanOne(t, "ssh", port, time.Second)
	if r.Status != StatusOpen {
		t.Errorf("status = %q (detail %q), want open", r.Status, r.Detail)
	}
	if r.Detected {
		t.Error("detected = true, want false")
	}
}

func TestSilentPortIsOpenNotDetected(t *testing.T) {
	// Accepts but never sends anything.
	_, port := startFakeServer(t, func(conn net.Conn) {
		buf := make([]byte, 64)
		conn.Read(buf) // block until the client goes away
	})
	r := scanOne(t, "telnet", port, 500*time.Millisecond)
	if r.Status != StatusOpen {
		t.Errorf("status = %q (detail %q), want open", r.Status, r.Detail)
	}
	if r.Detected {
		t.Error("detected = true, want false")
	}
	if r.Banner != "" {
		t.Errorf("banner = %q, want empty", r.Banner)
	}
}

// canConnectLoopback reports whether a TCP connect to 127.0.0.1:port succeeds
// within a second.
func canConnectLoopback(port int) bool {
	conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), time.Second)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

// Integration tests probe real services on the dev machine (see AGENTS.md);
// they self-skip where those services are absent (e.g. CI runners).

func TestIntegrationRealSSHD(t *testing.T) {
	if !canConnectLoopback(22) {
		t.Skip("no sshd listening on 127.0.0.1:22")
	}
	report, err := ScanTarget("127.0.0.1", WithProtocols("ssh"))
	if err != nil {
		t.Fatalf("ScanTarget: %v", err)
	}
	r := report.Results[0]
	if r.Status != StatusOpen || !r.Detected {
		t.Errorf("status=%q detected=%v, want open/true", r.Status, r.Detected)
	}
	if !strings.HasPrefix(r.Banner, "SSH-2.0-") {
		t.Errorf("banner = %q, want SSH-2.0- prefix", r.Banner)
	}
}

func TestIntegrationRealScreenSharing(t *testing.T) {
	if !canConnectLoopback(5900) {
		t.Skip("no Screen Sharing listening on 127.0.0.1:5900")
	}
	report, err := ScanTarget("127.0.0.1", WithProtocols("vnc"))
	if err != nil {
		t.Fatalf("ScanTarget: %v", err)
	}
	r := report.Results[0]
	if r.Status != StatusOpen || !r.Detected {
		t.Errorf("status=%q detected=%v, want open/true", r.Status, r.Detected)
	}
	if !strings.HasPrefix(r.Banner, "RFB 003.") {
		t.Errorf("banner = %q, want RFB 003. prefix", r.Banner)
	}
}

// Sanity: the concurrent scan is actually parallel — 8 protocols against
// silent ports must finish in roughly one timeout, not eight.
func TestConcurrentScanIsParallel(t *testing.T) {
	_, port := startFakeServer(t, func(conn net.Conn) {
		buf := make([]byte, 64)
		conn.Read(buf)
	})
	overrides := map[string]int{}
	for _, p := range protocols {
		overrides[p.id] = port
	}
	start := time.Now()
	report, err := ScanTarget("127.0.0.1", WithTimeout(400*time.Millisecond), WithPortOverrides(overrides))
	if err != nil {
		t.Fatalf("ScanTarget: %v", err)
	}
	elapsed := time.Since(start)
	if elapsed > 2*time.Second {
		t.Errorf("8 silent-port probes took %v; want roughly one timeout, probes likely serialized", elapsed)
	}
	if len(report.Results) != 8 {
		t.Fatalf("results length = %d, want 8", len(report.Results))
	}
	for _, r := range report.Results {
		if r.Status != StatusOpen {
			t.Errorf("%s: status=%q, want open (silent but accepting)", r.ProtocolID, r.Status)
		}
	}
}
