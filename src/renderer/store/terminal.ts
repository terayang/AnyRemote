import { create } from 'zustand'
import { ipcErrorCode, ipcErrorMessage } from '../../shared/ipc'

/** Lifecycle of the terminal panel's SSH shell session. */
export type TerminalStatus =
  /** No session context yet; the panel shows a placeholder. */
  | 'idle'
  /** ssh.connect / openShell in flight. */
  | 'connecting'
  /** Shell open; xterm is live and interactive. */
  | 'connected'
  /** Connect or openShell failed; overlay shows the classified error + retry. */
  | 'error'
  /** The remote side closed the shell; overlay offers reconnect. */
  | 'closed'

/** Connect failure keeping the IPC error code for the UI-side text mapping. */
export interface TerminalError {
  /** SshErrorCode carried over IPC ('AUTH_FAILED' | 'TIMEOUT' | ...), when known. */
  code?: string
  message: string
}

/**
 * The contextBridge structured clone drops custom Error fields, so an
 * IpcInvokeError reaches the panel as a plain Error carrying only its
 * message. When `code` is unavailable, recover the SshErrorCode from the
 * stable message prefixes produced by sshService.mapConnectError
 * (src/main/ssh/sshService.ts); a genuine `code` always wins.
 */
const MESSAGE_CODE_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['Authentication failed:', 'AUTH_FAILED'],
  ['Connection timed out:', 'TIMEOUT'],
  ['Host unreachable:', 'UNREACHABLE'],
  ['Connection failed:', 'UNREACHABLE'],
  ['Connection closed before the session was ready', 'UNREACHABLE']
]

/** Reduces any thrown value to a TerminalError, code recovered via the embedded prefix. */
export function toTerminalError(err: unknown): TerminalError {
  const code = ipcErrorCode(err)
  const message = ipcErrorMessage(err)
  if (code !== undefined) return { code, message }
  const hit = MESSAGE_CODE_PREFIXES.find(([prefix]) => message.startsWith(prefix))
  return hit ? { code: hit[1], message } : { message }
}

interface TerminalState {
  status: TerminalStatus
  /** Present only while status === 'error'. */
  error: TerminalError | null
  /** Connect-attempt counter; bumping it re-runs the panel's connect effect. */
  attempt: number
  markConnecting: () => void
  markConnected: () => void
  markError: (error: TerminalError) => void
  markClosed: () => void
  /** Re-runs the connect flow from scratch (error retry / closed reconnect). */
  retry: () => void
  reset: () => void
}

export const useTerminalStore = create<TerminalState>((set) => ({
  status: 'idle',
  error: null,
  attempt: 0,
  markConnecting: () => set({ status: 'connecting', error: null }),
  markConnected: () => set({ status: 'connected', error: null }),
  markError: (error) => set({ status: 'error', error }),
  markClosed: () => set({ status: 'closed' }),
  retry: () => set((s) => ({ status: 'connecting', error: null, attempt: s.attempt + 1 })),
  reset: () => set({ status: 'idle', error: null })
}))
