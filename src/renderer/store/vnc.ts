/**
 * Renderer-side VNC session controller (stage 5b): owns the noVNC client
 * lifecycle for the desktop panel and exposes its status as a zustand store.
 *
 * Connection path: attachVnc() asks the main process for a VNC bridge
 * (window.anyremote.vnc.startBridge — the bridge terminates the RFB security
 * handshake, including Apple DH, so the renderer sees an auth-free loopback
 * endpoint), then points a noVNC RFB client at the bridge's WebSocket.
 *
 * Error classification: target-side failures reach the renderer as private
 * WebSocket close codes (VNC_BRIDGE_CLOSE_CODES, src/shared/vnc.ts), which
 * noVNC does not surface through its events. attachVnc() therefore hands RFB
 * a WebSocket it constructed itself and records the close event directly;
 * IPC-level startBridge failures are classified from the IpcInvokeError code.
 * Both paths collapse into the same VncErrorKind set for the UI.
 *
 * Single-live-connection guard: one module-level session slot. React 18
 * StrictMode double-mounts and tab close/reopen both remount the panel;
 * every attach/detach disposes the previous session, and async continuations
 * plus event handlers verify they still own the slot before touching state.
 */

import { create } from 'zustand'
import { ipcErrorCode } from '../../shared/ipc'
import type { VncBridgeHandle, VncStartBridgeParams } from '../../shared/ipc'
import { VNC_BRIDGE_CLOSE_CODES } from '../../shared/vnc'

/**
 * @novnc/novnc ships no TypeScript declarations, so the constructor is
 * imported untyped and bound to the small surface AnyRemote uses. Note: the
 * package's exports map exposes only the root entry ('@novnc/novnc' ->
 * core/rfb.js); the legacy '@novnc/novnc/lib/rfb.js' subpath no longer
 * exists in 1.7.x.
 */
// @ts-expect-error — @novnc/novnc has no bundled type declarations.
import RFBUntyped from '@novnc/novnc'

/** The noVNC RFB instance: an EventTarget whose events are CustomEvents. */
type RfbInstance = EventTarget & {
  /** Scales the remote framebuffer to fit the local viewport. */
  scaleViewport: boolean
  /** Drops keyboard/mouse input instead of forwarding it when true. */
  viewOnly: boolean
  /** Starts a clean disconnection; a 'disconnect' event follows. */
  disconnect(): void
}

interface RfbConstructor {
  new (
    target: HTMLElement,
    urlOrChannel: string | WebSocket,
    options?: {
      shared?: boolean
      credentials?: { username?: string; password?: string; target?: string }
      wsProtocols?: string[]
    }
  ): RfbInstance
}

const RFB = RFBUntyped as unknown as RfbConstructor

/** Zoom modes of the desktop viewport. */
export type VncScaleMode = 'fit' | 'actual'

/** Failure categories shared by the IPC path and the WS close-code path. */
export type VncErrorKind = 'auth' | 'connection' | 'protocol' | 'timeout' | 'unknown'

export type VncStatus = 'idle' | 'connecting' | 'connected' | 'error'

/** One live VNC session; the module-level slot below guarantees a single one. */
interface LiveSession {
  rfb: RfbInstance | null
  bridgeId: string | null
  /** Torn down already: events and late async steps must no-op. */
  disposed: boolean
  /** WebSocket close code observed by our own listener (null while open). */
  closeCode: number | null
}

let live: LiveSession | null = null

/** Last attach arguments, kept so the error/idle overlays can reconnect. */
let lastAttach: { container: HTMLElement; params: VncStartBridgeParams } | null = null

/** Maps an IPC invoke failure (startBridge) onto a VncErrorKind. */
function classifyIpcError(err: unknown): VncErrorKind {
  switch (ipcErrorCode(err)) {
    case 'AUTH_FAILED':
      return 'auth'
    case 'UNREACHABLE':
      return 'connection'
    case 'PROTOCOL_ERROR':
      return 'protocol'
    case 'TIMEOUT':
      return 'timeout'
    default:
      return 'unknown'
  }
}

/** Maps a bridge WebSocket close code (src/shared/vnc.ts) onto a VncErrorKind. */
function classifyCloseCode(code: number | null): VncErrorKind {
  switch (code) {
    case VNC_BRIDGE_CLOSE_CODES.auth:
      return 'auth'
    case VNC_BRIDGE_CLOSE_CODES.connection:
      return 'connection'
    case VNC_BRIDGE_CLOSE_CODES.protocol:
      return 'protocol'
    case VNC_BRIDGE_CLOSE_CODES.timeout:
      return 'timeout'
    default:
      return 'unknown'
  }
}

/**
 * Tears down a session's resources exactly once: detaches noVNC (removing
 * its canvas and DOM listeners) and releases the main-process bridge. Local
 * teardowns call rfb.disconnect(); after a server-side disconnect the RFB
 * client has already torn itself down, so only the bridge needs releasing.
 */
function teardown(session: LiveSession, opts: { disconnectRfb: boolean }): void {
  if (session.disposed) return
  session.disposed = true
  if (opts.disconnectRfb && session.rfb !== null) {
    try {
      session.rfb.disconnect()
    } catch {
      // RFB already tore itself down (e.g. after a handshake failure).
    }
  }
  if (session.bridgeId !== null) {
    const bridgeId = session.bridgeId
    session.bridgeId = null
    void window.anyremote.vnc.stopBridge(bridgeId).catch(() => {
      // Bridge already gone (e.g. app quitting); nothing to do.
    })
  }
}

interface VncState {
  status: VncStatus
  /** Classified failure while status === 'error'; null otherwise. */
  errorKind: VncErrorKind | null
  /** Server-reported desktop name (RFB ServerInit); empty until known. */
  desktopName: string
  scaleMode: VncScaleMode
  setScaleMode: (mode: VncScaleMode) => void
}

export const useVncStore = create<VncState>((set) => ({
  status: 'idle',
  errorKind: null,
  desktopName: '',
  scaleMode: 'fit',
  setScaleMode: (mode) => {
    set({ scaleMode: mode })
    // Apply live when a session is up; attachVnc reads the store at creation.
    if (live?.rfb) live.rfb.scaleViewport = mode === 'fit'
  }
}))

/**
 * Starts a VNC session into `container`: bridge -> WebSocket -> noVNC RFB.
 * Any previous live session is torn down first, so a remounted panel never
 * stacks connections. Resolves once the attempt is underway; outcomes
 * (connect/error) arrive through the store status.
 */
export async function attachVnc(
  container: HTMLElement,
  params: VncStartBridgeParams
): Promise<void> {
  if (live !== null) {
    teardown(live, { disconnectRfb: true })
    live = null
  }
  const session: LiveSession = { rfb: null, bridgeId: null, disposed: false, closeCode: null }
  live = session
  lastAttach = { container, params }
  useVncStore.setState({ status: 'connecting', errorKind: null, desktopName: '' })

  const ownsSlot = (): boolean => live === session && !session.disposed

  let handle: VncBridgeHandle
  try {
    handle = await window.anyremote.vnc.startBridge(params)
  } catch (err) {
    if (ownsSlot()) {
      useVncStore.setState({ status: 'error', errorKind: classifyIpcError(err) })
      teardown(session, { disconnectRfb: false })
    }
    return
  }
  if (!ownsSlot()) {
    // Unmounted while the bridge was starting: release it immediately.
    void window.anyremote.vnc.stopBridge(handle.bridgeId).catch(() => {})
    return
  }
  session.bridgeId = handle.bridgeId

  // Construct the WebSocket ourselves so the bridge's private close codes
  // (4001 auth / 4002 unreachable / 4003 protocol / 4008 timeout) get
  // recorded; noVNC's events do not carry them. RFB accepts a ready-made
  // channel in place of a URL and adopts it.
  const ws = new WebSocket(`ws://127.0.0.1:${handle.wsPort}`, 'binary')
  ws.addEventListener('close', (event) => {
    session.closeCode = event.code
  })

  const rfb = new RFB(container, ws)
  session.rfb = rfb
  rfb.scaleViewport = useVncStore.getState().scaleMode === 'fit'

  rfb.addEventListener('connect', () => {
    if (ownsSlot()) useVncStore.setState({ status: 'connected' })
  })
  rfb.addEventListener('desktopname', (event) => {
    if (ownsSlot()) {
      useVncStore.setState({
        desktopName: (event as CustomEvent<{ name: string }>).detail.name
      })
    }
  })
  rfb.addEventListener('disconnect', (event) => {
    if (!ownsSlot()) return
    // Only non-intentional disconnects reach here: every local teardown goes
    // through teardown() first, which flips `disposed` and detaches us.
    const { clean } = (event as CustomEvent<{ clean: boolean }>).detail
    const kind = clean ? 'unknown' : classifyCloseCode(session.closeCode)
    teardown(session, { disconnectRfb: false })
    useVncStore.setState({ status: 'error', errorKind: kind })
  })
}

/** Unmount cleanup: tears down the live session and forgets retry context. */
export function detachVnc(): void {
  const session = live
  live = null
  lastAttach = null
  if (session !== null) teardown(session, { disconnectRfb: true })
  useVncStore.setState({ status: 'idle', errorKind: null, desktopName: '' })
}

/** 断开 button: drops the session on purpose and returns the panel to idle. */
export function userDisconnectVnc(): void {
  const session = live
  if (session !== null) teardown(session, { disconnectRfb: true })
  useVncStore.setState({ status: 'idle', errorKind: null })
}

/** Reconnects with the last attach arguments (the 重试/重新连接 buttons). */
export async function retryVnc(): Promise<void> {
  if (lastAttach === null) return
  await attachVnc(lastAttach.container, lastAttach.params)
}
