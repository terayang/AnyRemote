// Package scanner concurrently probes the well-known protocol ports on a
// target host and fingerprints whatever answers. It is a Go port of the
// Electron-era src/main/scanner.ts and keeps the same result shapes (and
// JSON field names) so reports can be fed straight to the frontend.
//
// Fingerprint strategy per protocol:
//   - ssh / vnc / ftp: server greeting banner sent on connect
//   - telnet: an open port counts; IAC (0xFF) negotiation bytes confirm it
//   - http: "HEAD / HTTP/1.0" -> "HTTP/" status line
//   - https: TLS handshake -> protocol version + peer certificate CN
//   - rdp: X.224 connection request with RDP_NEG_REQ -> RDP_NEG_RESP
//   - smb: SMB2 NEGOTIATE probe -> SMB2/SMB1 magic in the reply
//
// Every probe resolves to a result — a single failing port never fails the
// whole scan.
package scanner

import (
	"bytes"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// ScanStatus is the outcome class of a single port probe.
type ScanStatus string

const (
	StatusOpen    ScanStatus = "open"
	StatusClosed  ScanStatus = "closed"
	StatusTimeout ScanStatus = "timeout"
	StatusError   ScanStatus = "error"
)

// ProtocolScanResult mirrors the TS ProtocolScanResult (src/shared/scan.ts);
// JSON tags match the TS field names so the frontend contract is unchanged.
type ProtocolScanResult struct {
	// ProtocolID is the protocol id from the built-in protocol table.
	ProtocolID string `json:"protocolId"`
	// Port is the port that was actually probed (default or overridden).
	Port   int        `json:"port"`
	Status ScanStatus `json:"status"`
	// Detected is true when the fingerprint confirms the expected protocol.
	Detected bool `json:"detected"`
	// Banner holds the server banner when one was read, e.g.
	// "SSH-2.0-OpenSSH_9.9" or "RFB 003.889".
	Banner string `json:"banner,omitempty"`
	// Detail carries extra info (TLS version, RDP security flags) or error
	// detail.
	Detail string `json:"detail,omitempty"`
	// LatencyMs is the TCP connect latency in milliseconds.
	LatencyMs int64 `json:"latencyMs"`
}

// TargetScanReport mirrors the TS TargetScanReport (src/shared/scan.ts).
type TargetScanReport struct {
	Host       string               `json:"host"`
	StartedAt  int64                `json:"startedAt"`
	DurationMs int64                `json:"durationMs"`
	Results    []ProtocolScanResult `json:"results"`
}

// protocolMeta is the built-in protocol table, matching src/shared/protocols.ts.
type protocolMeta struct {
	id          string
	defaultPort int
}

var protocols = []protocolMeta{
	{id: "ssh", defaultPort: 22},
	{id: "vnc", defaultPort: 5900},
	{id: "rdp", defaultPort: 3389},
	{id: "telnet", defaultPort: 23},
	{id: "ftp", defaultPort: 21},
	{id: "smb", defaultPort: 445},
	{id: "http", defaultPort: 80},
	{id: "https", defaultPort: 443},
}

const defaultTimeout = 2 * time.Second

type config struct {
	timeout       time.Duration
	protocols     map[string]bool // nil means all protocols
	portOverrides map[string]int
}

// Option customizes a ScanTarget run.
type Option func(*config)

// WithTimeout sets the per-port timeout covering connect + fingerprint.
// Defaults to 2s.
func WithTimeout(d time.Duration) Option {
	return func(c *config) {
		if d > 0 {
			c.timeout = d
		}
	}
}

// WithProtocols limits the scan to the given protocol ids (default: all
// known protocols). Unknown ids are ignored.
func WithProtocols(ids ...string) Option {
	return func(c *config) {
		c.protocols = make(map[string]bool, len(ids))
		for _, id := range ids {
			c.protocols[id] = true
		}
	}
}

// WithPortOverrides probes non-default ports per protocol id (used by
// tests).
func WithPortOverrides(overrides map[string]int) Option {
	return func(c *config) {
		c.portOverrides = overrides
	}
}

// readMode controls how much of the greeting to collect before evaluating
// the fingerprint.
type readMode int

const (
	readFirstChunk readMode = iota // stop after the first data chunk
	readFirstLine                  // stop after the first newline-terminated line
)

type exchangeOptions struct {
	// send holds bytes to write right after the connection is up.
	send []byte
	read readMode
	// useTLS upgrades to TLS and reports handshake details instead of
	// reading data.
	useTLS bool
}

type tlsInfo struct {
	version string
	certCN  string
}

type exchangeOutcome struct {
	status ScanStatus
	// data holds the bytes received (empty when none arrived before the
	// timeout).
	data      []byte
	tlsInfo   *tlsInfo // TLS protocol version and peer certificate CN (https only)
	detail    string   // error / timeout detail worth surfacing to the user
	latencyMs int64
}

// exchange opens one TCP (optionally TLS) connection, optionally writes a
// probe, collects the greeting, and returns. Every failure mode is mapped
// onto a ScanStatus so one bad port cannot break the whole scan.
func exchange(host string, port int, timeout time.Duration, opts exchangeOptions) exchangeOutcome {
	startedAt := time.Now()
	addr := net.JoinHostPort(host, strconv.Itoa(port))

	dialer := net.Dialer{Timeout: timeout}
	conn, err := dialer.Dial("tcp", addr)
	if err != nil {
		return mapDialError(err, startedAt)
	}
	defer conn.Close()
	if tc, ok := conn.(*net.TCPConn); ok {
		_ = tc.SetNoDelay(true)
	}
	// The whole exchange (write + read, or TLS handshake) shares the same
	// per-port deadline the TS version enforces with a single timer.
	_ = conn.SetDeadline(time.Now().Add(timeout))
	connectLatencyMs := time.Since(startedAt).Milliseconds()

	if opts.useTLS {
		tlsCfg := &tls.Config{InsecureSkipVerify: true} //nolint:gosec // fingerprinting only, like the TS probe
		// SNI must be a DNS name; TLS clients reject IP literals as
		// servername.
		if net.ParseIP(host) == nil {
			tlsCfg.ServerName = host
		}
		tlsConn := tls.Client(conn, tlsCfg)
		if err := tlsConn.Handshake(); err != nil {
			// The port accepted the TCP connection; a later failure (TLS
			// mismatch, reset after connect) still means something listens.
			return exchangeOutcome{
				status:    StatusOpen,
				detail:    err.Error(),
				latencyMs: connectLatencyMs,
			}
		}
		state := tlsConn.ConnectionState()
		info := &tlsInfo{version: tlsVersionName(state.Version)}
		if len(state.PeerCertificates) > 0 {
			info.certCN = state.PeerCertificates[0].Subject.CommonName
		}
		return exchangeOutcome{
			status:    StatusOpen,
			tlsInfo:   info,
			latencyMs: time.Since(startedAt).Milliseconds(),
		}
	}

	if opts.send != nil {
		if _, err := conn.Write(opts.send); err != nil {
			return exchangeOutcome{
				status:    StatusOpen,
				detail:    err.Error(),
				latencyMs: connectLatencyMs,
			}
		}
	}

	var buf bytes.Buffer
	chunk := make([]byte, 4096)
	for {
		n, err := conn.Read(chunk)
		if n > 0 {
			buf.Write(chunk[:n])
			if opts.read == readFirstChunk || bytes.IndexByte(buf.Bytes(), '\n') >= 0 {
				return exchangeOutcome{status: StatusOpen, data: buf.Bytes(), latencyMs: connectLatencyMs}
			}
		}
		if err != nil {
			var netErr net.Error
			if errors.As(err, &netErr) && netErr.Timeout() {
				// A completed connect with a silent peer still means the
				// port is open.
				return exchangeOutcome{
					status:    StatusOpen,
					data:      buf.Bytes(),
					detail:    fmt.Sprintf("no data within %dms", timeout.Milliseconds()),
					latencyMs: connectLatencyMs,
				}
			}
			if errors.Is(err, io.EOF) {
				// Peer closed the connection: report whatever greeting we
				// already got.
				return exchangeOutcome{status: StatusOpen, data: buf.Bytes(), latencyMs: connectLatencyMs}
			}
			// Reset (or any other failure) after connect: still open.
			return exchangeOutcome{
				status:    StatusOpen,
				data:      buf.Bytes(),
				detail:    err.Error(),
				latencyMs: connectLatencyMs,
			}
		}
	}
}

// mapDialError classifies a failed connect the same way the TS error handler
// does: ECONNREFUSED -> closed, timeout -> timeout, anything else -> error.
func mapDialError(err error, startedAt time.Time) exchangeOutcome {
	out := exchangeOutcome{latencyMs: time.Since(startedAt).Milliseconds()}
	switch {
	case isConnRefused(err):
		out.status = StatusClosed
		out.detail = "connection refused (ECONNREFUSED)"
	default:
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			out.status = StatusTimeout
			out.detail = err.Error()
		} else {
			out.status = StatusError
			out.detail = err.Error()
		}
	}
	return out
}

// isConnRefused reports whether err is a connection-refused dial failure.
// Windows reports WSAECONNREFUSED (10061), which errors.Is does not map to
// syscall.ECONNREFUSED, so the numeric errno is matched as a fallback.
func isConnRefused(err error) bool {
	if errors.Is(err, syscall.ECONNREFUSED) {
		return true
	}
	const wsaEConnRefused = syscall.Errno(10061)
	var errno syscall.Errno
	if errors.As(err, &errno) {
		return errno == wsaEConnRefused
	}
	return false
}

// tlsVersionName renders a TLS version the way Node's getProtocol() does
// (e.g. "TLSv1.3"), keeping the detail string shape identical to the TS
// scanner.
func tlsVersionName(v uint16) string {
	switch v {
	case tls.VersionTLS10:
		return "TLSv1"
	case tls.VersionTLS11:
		return "TLSv1.1"
	case tls.VersionTLS12:
		return "TLSv1.2"
	case tls.VersionTLS13:
		return "TLSv1.3"
	default:
		return fmt.Sprintf("0x%04x", v)
	}
}

// firstLine returns the first newline-terminated line of data, without the
// trailing CR, or "" when there is none.
func firstLine(data []byte) string {
	if len(data) == 0 {
		return ""
	}
	line := string(data)
	if i := strings.IndexByte(line, '\n'); i >= 0 {
		line = line[:i]
	}
	return strings.TrimSuffix(line, "\r")
}

// telnetBanner renders the printable part of a telnet greeting, skipping
// IAC sequences.
func telnetBanner(data []byte) string {
	printable := make([]byte, 0, len(data))
	for i := 0; i < len(data); i++ {
		if data[i] == 0xff {
			i += 2 // skip IAC + verb + option
			continue
		}
		if data[i] >= 0x20 && data[i] < 0x7f {
			printable = append(printable, data[i])
		}
	}
	return string(printable)
}

// toResult folds an exchange outcome into a scan result, matching the TS
// toResult: banner is only surfaced on open ports, detected requires open.
func toResult(protocolID string, port int, r exchangeOutcome, detected bool, banner, detail string) ProtocolScanResult {
	open := r.status == StatusOpen
	if detail == "" {
		detail = r.detail
	}
	res := ProtocolScanResult{
		ProtocolID: protocolID,
		Port:       port,
		Status:     r.status,
		Detected:   open && detected,
		Detail:     detail,
		LatencyMs:  r.latencyMs,
	}
	if open {
		res.Banner = banner
	}
	return res
}

func probeSSH(host string, port int, timeout time.Duration) ProtocolScanResult {
	r := exchange(host, port, timeout, exchangeOptions{read: readFirstLine})
	banner := firstLine(r.data)
	return toResult("ssh", port, r, strings.HasPrefix(banner, "SSH-"), banner, "")
}

var vncBannerDigits = []byte("RFB 000.000")

func probeVNC(host string, port int, timeout time.Duration) ProtocolScanResult {
	r := exchange(host, port, timeout, exchangeOptions{read: readFirstLine})
	banner := firstLine(r.data)
	return toResult("vnc", port, r, matchVncBanner(banner), banner, "")
}

// matchVncBanner implements the TS regex ^RFB \d{3}\.\d{3}.
func matchVncBanner(banner string) bool {
	if len(banner) < len(vncBannerDigits) {
		return false
	}
	for i, c := range vncBannerDigits {
		b := banner[i]
		switch c {
		case '0':
			if b < '0' || b > '9' {
				return false
			}
		default:
			if b != c {
				return false
			}
		}
	}
	return true
}

func probeFTP(host string, port int, timeout time.Duration) ProtocolScanResult {
	r := exchange(host, port, timeout, exchangeOptions{read: readFirstLine})
	banner := firstLine(r.data)
	return toResult("ftp", port, r, strings.HasPrefix(banner, "220"), banner, "")
}

func probeTelnet(host string, port int, timeout time.Duration) ProtocolScanResult {
	r := exchange(host, port, timeout, exchangeOptions{read: readFirstChunk})
	detected := len(r.data) > 0 && r.data[0] == 0xff // IAC
	return toResult("telnet", port, r, detected, telnetBanner(r.data), "")
}

func probeHTTP(host string, port int, timeout time.Duration) ProtocolScanResult {
	r := exchange(host, port, timeout, exchangeOptions{
		read: readFirstLine,
		send: []byte("HEAD / HTTP/1.0\r\n\r\n"),
	})
	statusLine := firstLine(r.data)
	return toResult("http", port, r, strings.HasPrefix(statusLine, "HTTP/"), statusLine, "")
}

func probeHTTPS(host string, port int, timeout time.Duration) ProtocolScanResult {
	r := exchange(host, port, timeout, exchangeOptions{read: readFirstChunk, useTLS: true})
	detail := ""
	if r.tlsInfo != nil {
		version := r.tlsInfo.version
		if version == "" {
			version = "unknown"
		}
		detail = "TLS " + version
		if r.tlsInfo.certCN != "" {
			detail += ", CN=" + r.tlsInfo.certCN
		}
	}
	return toResult("https", port, r, r.tlsInfo != nil, "", detail)
}

// rdpNegRequest is an X.224 TPKT connection request carrying RDP_NEG_REQ
// (MS-RDPBCGR 2.2.1.1), offering PROTOCOL_SSL | PROTOCOL_HYBRID. Standard
// 19-byte sequence.
var rdpNegRequest = []byte{
	0x03, 0x00, 0x00, 0x13, // TPKT v3, total length 19
	0x0e, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, // X.224 CR TPDU
	0x01, 0x00, 0x08, 0x00, // RDP_NEG_REQ, flags 0, length 8
	0x03, 0x00, 0x00, 0x00, // requestedProtocols: SSL | HYBRID
}

func describeRdpSecurity(flags uint32) string {
	names := make([]string, 0, 4)
	if flags&0x1 != 0 {
		names = append(names, "SSL")
	}
	if flags&0x2 != 0 {
		names = append(names, "HYBRID")
	}
	if flags&0x4 != 0 {
		names = append(names, "RDSTLS")
	}
	if flags&0x8 != 0 {
		names = append(names, "HYBRID_EX")
	}
	if len(names) == 0 {
		return "NONE"
	}
	return strings.Join(names, "|")
}

func probeRDP(host string, port int, timeout time.Duration) ProtocolScanResult {
	r := exchange(host, port, timeout, exchangeOptions{read: readFirstChunk, send: rdpNegRequest})
	b := r.data
	detected := false
	detail := ""
	// TPKT (0x03) + X.224 CC (0xd0) + RDP negotiation response at offset 11.
	if len(b) >= 19 && b[0] == 0x03 && b[5] == 0xd0 {
		switch b[11] {
		case 0x02:
			selected := binary.LittleEndian.Uint32(b[15:19])
			detected = true
			detail = fmt.Sprintf("negotiated security: 0x%x (%s)", selected, describeRdpSecurity(selected))
		case 0x03:
			detail = fmt.Sprintf("negotiation failure: 0x%x", binary.LittleEndian.Uint32(b[15:19]))
		}
	}
	return toResult("rdp", port, r, detected, "", detail)
}

var (
	smb2Magic = []byte{0xfe, 'S', 'M', 'B'} // 0xFE 'SMB'
	smb1Magic = []byte{0xff, 'S', 'M', 'B'} // 0xFF 'SMB'
)

// buildSmb2NegotiateProbe builds a NetBIOS session header + SMB2 NEGOTIATE
// offering dialects 2.0.2 and 2.1.
func buildSmb2NegotiateProbe() []byte {
	header := make([]byte, 64)
	copy(header, smb2Magic)
	binary.LittleEndian.PutUint16(header[4:], 64) // StructureSize
	// Command NEGOTIATE (0x0000); everything else stays zero.

	body := make([]byte, 36)
	binary.LittleEndian.PutUint16(body[0:], 36) // StructureSize
	binary.LittleEndian.PutUint16(body[2:], 2)  // DialectCount
	binary.LittleEndian.PutUint16(body[4:], 1)  // SecurityMode: signing enabled

	dialects := []byte{0x02, 0x02, 0x10, 0x02} // SMB 2.0.2, SMB 2.1
	payload := append(append(header, body...), dialects...)

	netbios := make([]byte, 4)
	binary.BigEndian.PutUint32(netbios, uint32(len(payload))) // byte 0 = session message, 3-byte length
	return append(netbios, payload...)
}

func probeSMB(host string, port int, timeout time.Duration) ProtocolScanResult {
	r := exchange(host, port, timeout, exchangeOptions{read: readFirstChunk, send: buildSmb2NegotiateProbe()})
	smb2 := bytes.Contains(r.data, smb2Magic)
	smb1 := bytes.Contains(r.data, smb1Magic)
	detail := ""
	switch {
	case smb2:
		detail = "SMB2 magic in negotiate response"
	case smb1:
		detail = "SMB1 magic in negotiate response"
	}
	return toResult("smb", port, r, smb2 || smb1, "", detail)
}

type probeFn func(host string, port int, timeout time.Duration) ProtocolScanResult

func probeFor(protocolID string) probeFn {
	switch protocolID {
	case "ssh":
		return probeSSH
	case "vnc":
		return probeVNC
	case "rdp":
		return probeRDP
	case "telnet":
		return probeTelnet
	case "ftp":
		return probeFTP
	case "smb":
		return probeSMB
	case "http":
		return probeHTTP
	case "https":
		return probeHTTPS
	default:
		return nil
	}
}

// ScanTarget probes all known protocols on host concurrently (one TCP
// connection per protocol port) and aggregates the per-protocol fingerprint
// results. Individual probe failures never fail the report; the returned
// error is always nil and kept only for future-proofing.
func ScanTarget(host string, opts ...Option) (TargetScanReport, error) {
	cfg := config{timeout: defaultTimeout}
	for _, opt := range opts {
		opt(&cfg)
	}

	targets := make([]protocolMeta, 0, len(protocols))
	for _, p := range protocols {
		if cfg.protocols == nil || cfg.protocols[p.id] {
			targets = append(targets, p)
		}
	}

	startedAt := time.Now()
	results := make([]ProtocolScanResult, len(targets))
	var wg sync.WaitGroup
	for i, meta := range targets {
		port := meta.defaultPort
		if override, ok := cfg.portOverrides[meta.id]; ok {
			port = override
		}
		probe := probeFor(meta.id)
		wg.Add(1)
		go func(i int, id string, port int, probe probeFn) {
			defer wg.Done()
			defer func() {
				// Defensive: probes are designed not to panic; never let one
				// port failure break the whole report.
				if rec := recover(); rec != nil {
					results[i] = ProtocolScanResult{
						ProtocolID: id,
						Port:       port,
						Status:     StatusError,
						Detected:   false,
						Detail:     fmt.Sprintf("%v", rec),
						LatencyMs:  0,
					}
				}
			}()
			results[i] = probe(host, port, cfg.timeout)
		}(i, meta.id, port, probe)
	}
	wg.Wait()

	return TargetScanReport{
		Host:       host,
		StartedAt:  startedAt.UnixMilli(),
		DurationMs: time.Since(startedAt).Milliseconds(),
		Results:    results,
	}, nil
}
