// Error taxonomy for the RFB client handshake, mirroring src/main/rfb/types.ts.
// The concrete types are distinguishable via errors.As:
//   - RfbAuthError:       the server rejected the credentials (SecurityResult != 0)
//   - RfbProtocolError:   the peer does not speak RFB or violates it
//   - RfbTimeoutError:    no progress within the configured deadline
//   - RfbConnectionError: the socket errored or closed mid-handshake
package rfb

// RfbAuthError indicates the server rejected the credentials.
type RfbAuthError struct{ Message string }

func (e *RfbAuthError) Error() string { return e.Message }

// RfbProtocolError indicates the peer does not speak RFB or violates it.
type RfbProtocolError struct{ Message string }

func (e *RfbProtocolError) Error() string { return e.Message }

// RfbTimeoutError indicates no progress within the configured deadline.
type RfbTimeoutError struct{ Message string }

func (e *RfbTimeoutError) Error() string { return e.Message }

// RfbConnectionError indicates the socket errored or closed mid-handshake.
type RfbConnectionError struct{ Message string }

func (e *RfbConnectionError) Error() string { return e.Message }
