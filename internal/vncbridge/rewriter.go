// SetEncodings rewriter (client -> server, pipe phase). Go port of the
// SetEncodingsRewriter in src/main/vncBridge.ts.
package vncbridge

import "encoding/binary"

// clientMessageLength holds the fixed lengths of the RFB client messages the
// parser understands.
var clientMessageLength = map[byte]int{
	0: 20, // SetPixelFormat: type + pad(3) + pixel-format(16)
	3: 10, // FramebufferUpdateRequest
	4: 8,  // KeyEvent
	5: 6,  // PointerEvent
}

const (
	encodingCopyRect = 1
	encodingRaw      = 0
)

// SetEncodingsRewriter is an incremental RFB client-message parser that
// rewrites SetEncodings messages to prefer a configured pixel-encoding list.
// Only message boundaries are tracked; all other messages pass through
// untouched.
//
// Fail-open: an unknown message type permanently disables rewriting for the
// connection — buffered bytes are forwarded verbatim and the stream degrades
// to pure passthrough, never breaking the session over a parse failure.
type SetEncodingsRewriter struct {
	preference []int32
	buffer     []byte
	disabled   bool
}

// NewSetEncodingsRewriter creates a rewriter preferring the given encodings.
func NewSetEncodingsRewriter(preference []int32) *SetEncodingsRewriter {
	return &SetEncodingsRewriter{preference: preference}
}

// Push feeds bytes; it returns the chunks to forward (rewrite applied).
func (r *SetEncodingsRewriter) Push(chunk []byte) [][]byte {
	if r.disabled {
		return [][]byte{chunk}
	}
	r.buffer = append(r.buffer, chunk...)
	var out [][]byte
	for {
		message := r.takeMessage()
		if message == nil {
			break
		}
		out = append(out, message)
	}
	return out
}

// takeMessage extracts one complete message from the buffer, or nil when
// incomplete.
func (r *SetEncodingsRewriter) takeMessage() []byte {
	buf := r.buffer
	if len(buf) == 0 {
		return nil
	}
	msgType := buf[0]

	if msgType == 2 {
		// SetEncodings: type + pad + count(2) + count*4
		if len(buf) < 4 {
			return nil
		}
		length := 4 + int(binary.BigEndian.Uint16(buf[2:4]))*4
		if len(buf) < length {
			return nil
		}
		rewritten := r.rewriteSetEncodings(buf[:length])
		r.buffer = buf[length:]
		return rewritten
	}

	length := -1
	if msgType == 6 {
		// ClientCutText: type + pad(3) + length(4) + text
		if len(buf) < 8 {
			return nil
		}
		length = 8 + int(binary.BigEndian.Uint32(buf[4:8]))
	} else if fixed, ok := clientMessageLength[msgType]; ok {
		length = fixed
	}

	if length == -1 {
		r.disabled = true
		rest := r.buffer
		r.buffer = nil
		if len(rest) > 0 {
			return rest
		}
		return nil
	}
	if len(buf) < length {
		return nil
	}
	r.buffer = buf[length:]
	return buf[:length]
}

// rewriteSetEncodings rebuilds a SetEncodings message: CopyRect + preference
// + Raw fallback, with the client's pseudo-encodings (negative / >255 values)
// preserved in their original order.
func (r *SetEncodingsRewriter) rewriteSetEncodings(message []byte) []byte {
	count := int(binary.BigEndian.Uint16(message[2:4]))
	var pseudo []int32
	for i := 0; i < count; i++ {
		enc := int32(binary.BigEndian.Uint32(message[4+i*4 : 8+i*4]))
		if enc < 0 || enc > 255 {
			pseudo = append(pseudo, enc)
		}
	}
	pixel := []int32{encodingCopyRect}
	pixel = append(pixel, r.preference...)
	if !containsEncoding(r.preference, encodingRaw) {
		pixel = append(pixel, encodingRaw)
	}
	all := append(pixel, pseudo...)
	out := make([]byte, 4+len(all)*4)
	out[0] = 2
	binary.BigEndian.PutUint16(out[2:4], uint16(len(all)))
	for i, enc := range all {
		binary.BigEndian.PutUint32(out[4+i*4:8+i*4], uint32(enc))
	}
	return out
}

func containsEncoding(list []int32, enc int32) bool {
	for _, e := range list {
		if e == enc {
			return true
		}
	}
	return false
}
