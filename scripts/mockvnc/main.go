// Mock VNC server + production vncbridge, for local reproduction of the
// noVNC scaling behavior without touching the real macOS Screen Sharing.
// Serves a static 1024x640 raw screen (color bands) with security type None.
package main

import (
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"os"

	"anyremote/internal/vncbridge"
)

const (
	width  = 1024
	height = 640
)

func main() {
	ln, err := net.Listen("tcp", "127.0.0.1:5901")
	if err != nil {
		panic(err)
	}
	bridge, err := vncbridge.Start(vncbridge.Options{Host: "127.0.0.1", Port: 5901})
	if err != nil {
		panic(err)
	}
	fmt.Printf("MOCKVNC bridge wsPort=%d\n", bridge.WSPort)

	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		go serve(conn)
	}
}

func serve(conn net.Conn) {
	defer conn.Close()
	fail := func(err error) {
		if err != nil {
			fmt.Fprintln(os.Stderr, "mockvnc:", err)
		}
	}

	fail(write(conn, []byte("RFB 003.008\n")))
	if err := readN(conn, 12); err != nil {
		fail(err)
		return
	}
	fail(write(conn, []byte{1, 1})) // one security type: None
	if err := readN(conn, 1); err != nil {
		fail(err)
		return
	}
	fail(write(conn, []byte{0, 0, 0, 0})) // SecurityResult OK
	if err := readN(conn, 1); err != nil { // ClientInit
		fail(err)
		return
	}
	fail(write(conn, serverInit()))

	pixels := bandedPixels()
	for {
		header := make([]byte, 4)
		if _, err := io.ReadFull(conn, header[:1]); err != nil {
			return
		}
		switch header[0] {
		case 0: // SetPixelFormat
			if err := readN(conn, 19); err != nil {
				return
			}
		case 2: // SetEncodings
			rest := make([]byte, 3)
			if _, err := io.ReadFull(conn, rest); err != nil {
				return
			}
			n := int(binary.BigEndian.Uint16(rest[1:3]))
			if err := readN(conn, n*4); err != nil {
				return
			}
		case 3: // FramebufferUpdateRequest
			if err := readN(conn, 9); err != nil {
				return
			}
			if err := write(conn, fbu(pixels)); err != nil {
				return
			}
		case 4: // KeyEvent
			if err := readN(conn, 7); err != nil {
				return
			}
		case 5: // PointerEvent
			if err := readN(conn, 5); err != nil {
				return
			}
		default:
			return
		}
	}
}

func serverInit() []byte {
	name := []byte("mockvnc")
	buf := make([]byte, 24+len(name))
	binary.BigEndian.PutUint16(buf[0:2], width)
	binary.BigEndian.PutUint16(buf[2:4], height)
	buf[4] = 32 // bits per pixel
	buf[5] = 24 // depth
	buf[6] = 0  // little endian
	buf[7] = 1  // true color
	binary.BigEndian.PutUint16(buf[8:10], 255)
	binary.BigEndian.PutUint16(buf[10:12], 255)
	binary.BigEndian.PutUint16(buf[12:14], 255)
	buf[14], buf[15], buf[16] = 16, 8, 0 // shifts
	binary.BigEndian.PutUint32(buf[20:24], uint32(len(name)))
	copy(buf[24:], name)
	return buf
}

func bandedPixels() []byte {
	px := make([]byte, width*height*4)
	bands := [][3]uint8{{0x4c, 0x8d, 0xff}, {0x2c, 0x2c, 0x2c}, {0xe3, 0xb3, 0x41}, {0x14, 0x14, 0x14}}
	for y := 0; y < height; y++ {
		c := bands[(y/(height/len(bands)))%len(bands)]
		for x := 0; x < width; x++ {
			i := (y*width + x) * 4
			px[i], px[i+1], px[i+2], px[i+3] = c[0], c[1], c[2], 0
		}
	}
	return px
}

func fbu(pixels []byte) []byte {
	head := make([]byte, 12)             // type(1) pad(1) nRects(2) x(2) y(2) w(2) h(2)
	binary.BigEndian.PutUint16(head[2:4], 1)
	binary.BigEndian.PutUint16(head[8:10], width)
	binary.BigEndian.PutUint16(head[10:12], height)
	enc := []byte{0, 0, 0, 0} // raw
	return append(append(head, enc...), pixels...)
}

func write(conn net.Conn, b []byte) error {
	_, err := conn.Write(b)
	return err
}

func readN(conn net.Conn, n int) error {
	_, err := io.ReadFull(conn, make([]byte, n))
	return err
}
