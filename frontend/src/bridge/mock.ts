/**
 * Static development mock for window.anyremote, active only under plain
 * `vite dev` when the Wails runtime is absent (import.meta.env.DEV &&
 * window.go === undefined, see ./index.ts). It exists so the UI can render
 * for frontend-only preview and Playwright screenshots without any Go
 * backend. Every method behaves predictably and nothing here touches the
 * network, the filesystem, or a real SSH/VNC server.
 *
 * The fixture mirrors the developer's LAN machine 192.168.50.43: SSH and VNC
 * detected, everything else closed.
 */

import {
  sftpProgressChannel,
  sshCloseChannel,
  sshDataChannel,
  type SftpProgressEvent
} from '../../shared/ipc'
import type { TargetScanReport } from '../../shared/scan'
import type { FileEntry } from '../../shared/ssh'
import type { AnyRemoteApi } from './index'

type Listener = (...args: never[]) => void

/** Minimal per-channel event bus standing in for window.runtime.EventsOn. */
const listeners = new Map<string, Set<Listener>>()

function on(channel: string, cb: Listener): () => void {
  let set = listeners.get(channel)
  if (set === undefined) {
    set = new Set()
    listeners.set(channel, set)
  }
  set.add(cb)
  return () => {
    set.delete(cb)
    if (set.size === 0) listeners.delete(channel)
  }
}

function emit(channel: string, ...args: unknown[]): void {
  for (const cb of listeners.get(channel) ?? []) {
    ;(cb as (...a: unknown[]) => void)(...args)
  }
}

/** Simulates a small backend delay so loading states stay visible. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const MOCK_SCAN_RESULTS: TargetScanReport['results'] = [
  { protocolId: 'ssh', port: 22, status: 'open', detected: true, banner: 'SSH-2.0-OpenSSH_9.9', latencyMs: 3 },
  { protocolId: 'vnc', port: 5900, status: 'open', detected: true, banner: 'RFB 003.889', latencyMs: 2 },
  { protocolId: 'rdp', port: 3389, status: 'closed', detected: false, latencyMs: 1 },
  { protocolId: 'telnet', port: 23, status: 'closed', detected: false, latencyMs: 1 },
  { protocolId: 'ftp', port: 21, status: 'closed', detected: false, latencyMs: 1 },
  { protocolId: 'smb', port: 445, status: 'closed', detected: false, latencyMs: 1 },
  { protocolId: 'http', port: 80, status: 'closed', detected: false, latencyMs: 2 },
  { protocolId: 'https', port: 443, status: 'closed', detected: false, latencyMs: 2 }
]

const MOCK_HOME = '/Users/mock'

const MOCK_FILES: FileEntry[] = [
  { name: 'Desktop', type: 'directory', size: 0, mtimeMs: 1750000000000, mode: 0o755 },
  { name: 'Documents', type: 'directory', size: 0, mtimeMs: 1750000000000, mode: 0o755 },
  { name: 'notes.txt', type: 'file', size: 1286, mtimeMs: 1750000000000, mode: 0o644 },
  { name: 'photo.png', type: 'file', size: 248_930, mtimeMs: 1750000000000, mode: 0o644 }
]

const MOCK_SESSION_ID = 'mock-session'

/**
 * Builds the mock facade. The saved-connections part is injected so mock and
 * Wails modes share the same in-memory implementation (list starts empty).
 */
export function createMockApi(connections: AnyRemoteApi['connections']): AnyRemoteApi {
  return {
    versions: { electron: '', node: '', chrome: '' },
    scan: async (host) => {
      await delay(400)
      const startedAt = Date.now() - 400
      return { host, startedAt, durationMs: 400, results: MOCK_SCAN_RESULTS }
    },
    ssh: {
      connect: async () => {
        await delay(200)
        return MOCK_SESSION_ID
      },
      openShell: async (sessionId) => {
        // A greeting chunk so the terminal panel shows life; no echo after.
        setTimeout(
          () => emit(sshDataChannel(sessionId), 'mock shell — no backend connected\r\n$ '),
          50
        )
      },
      write: () => undefined,
      resize: () => undefined,
      close: async () => undefined,
      onData: (sessionId, cb) => on(sshDataChannel(sessionId), cb),
      onClose: (sessionId, cb) => on(sshCloseChannel(sessionId), cb)
    },
    sftp: {
      homeDir: async () => MOCK_HOME,
      list: async () => MOCK_FILES,
      mkdir: async () => undefined,
      rename: async () => undefined,
      deleteFile: async () => undefined,
      deleteDir: async () => undefined,
      upload: async (sessionId, _localPath, _remotePath) => {
        emitProgress(sessionId, 'upload')
      },
      download: async (sessionId, _remotePath, _localPath) => {
        emitProgress(sessionId, 'download')
      },
      onProgress: (sessionId, cb) => on(sftpProgressChannel(sessionId), cb)
    },
    vnc: {
      startBridge: async () => {
        await delay(100)
        throw new Error('[UNREACHABLE] mock: no VNC backend under vite dev')
      },
      stopBridge: async () => undefined
    },
    localFs: {
      homeDir: async () => MOCK_HOME,
      list: async () => MOCK_FILES
    },
    connections,
    dialog: {
      pickFiles: async () => [],
      pickSavePath: async () => null
    }
  }
}

/** One synthetic 100% progress event so the transfer queue completes. */
function emitProgress(sessionId: string, direction: SftpProgressEvent['direction']): void {
  const progress: SftpProgressEvent = { transferred: 1024, total: 1024, percent: 100, direction }
  setTimeout(() => emit(sftpProgressChannel(sessionId), progress), 50)
}
