/**
 * IPC trunk layer: registers every main-process service behind typed ipcMain
 * handlers matching the window.anyremote contract exposed by the preload
 * bridge (src/preload/index.ts). Handlers stay thin delegates over the
 * service layer (scanner, sshService, sftpService, vncBridge, localFs) and
 * the native dialogs; every failure is serialized to an IpcError via
 * toTransportError (src/shared/ipc.ts) so the renderer can distinguish
 * causes (AUTH_FAILED / TIMEOUT / UNREACHABLE / ...).
 */

import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import type {
  IpcMainInvokeEvent,
  OpenDialogOptions,
  SaveDialogOptions,
  WebContents
} from 'electron'
import {
  IPC_CHANNELS,
  sftpProgressChannel,
  sshCloseChannel,
  sshDataChannel,
  toTransportError,
  type IpcErrorCodeMapper,
  type SavedConnection,
  type SavedConnectionInput,
  type SavedConnectionSummary,
  type VncBridgeHandle,
  type VncStartBridgeParams
} from '../shared/ipc'
import type { SshAuthConfig, ShellSize } from '../shared/ssh'
import { scanTarget } from './scanner'
import * as localFs from './localFs'
import { RfbAuthError, RfbConnectionError, RfbProtocolError, RfbTimeoutError } from './rfb/types'
import * as sftpService from './ssh/sftpService'
import * as sshService from './ssh/sshService'
import * as store from './store'
import { startVncBridge, type VncBridge } from './vncBridge'

/**
 * Maps the RFB handshake error classes (which distinguish by instanceof, not
 * by a code field) onto the same style of IPC codes SshError uses.
 */
const mapVncErrorCode: IpcErrorCodeMapper = (err) => {
  if (err instanceof RfbAuthError) return 'AUTH_FAILED'
  if (err instanceof RfbTimeoutError) return 'TIMEOUT'
  if (err instanceof RfbProtocolError) return 'PROTOCOL_ERROR'
  if (err instanceof RfbConnectionError) return 'UNREACHABLE'
  return undefined
}

// The per-handler lambdas below carry the concrete parameter types.
type IpcHandler = (event: IpcMainInvokeEvent, ...args: any[]) => unknown

/**
 * Registers one invoke handler. Any failure — thrown or rejected — is
 * serialized via toTransportError so `code` survives the IPC boundary.
 */
function handle(channel: string, fn: IpcHandler, mapCode?: IpcErrorCodeMapper): void {
  ipcMain.handle(channel, async (event, ...args: any[]) => {
    try {
      return await fn(event, ...args)
    } catch (err) {
      throw toTransportError(err, mapCode)
    }
  })
}

/** Sends on a channel only while the target renderer is still alive. */
function send(target: WebContents, channel: string, ...args: unknown[]): void {
  if (!target.isDestroyed()) target.send(channel, ...args)
}

/** Live VNC bridges by bridgeId; all closed on before-quit. */
const bridges = new Map<string, VncBridge>()
let bridgeSeq = 0

/** Registers all AnyRemote IPC handlers. Call once at app startup. */
export function registerIpcHandlers(): void {
  // --- Protocol scanner ---
  handle(IPC_CHANNELS.scan, (_event, host: string) => scanTarget(host))

  // --- SSH terminal sessions ---
  handle(IPC_CHANNELS.sshConnect, (_event, config: SshAuthConfig) =>
    sshService.createSession(config)
  )
  handle(IPC_CHANNELS.sshOpenShell, (event, sessionId: string, size: ShellSize) =>
    sshService.openShell(sessionId, size, {
      onData: (data) => send(event.sender, sshDataChannel(sessionId), data),
      onClose: () => send(event.sender, sshCloseChannel(sessionId))
    })
  )
  // Keystrokes and resizes are fire-and-forget (send, not invoke): they must
  // never block or reject the renderer; a dead shell simply swallows them.
  ipcMain.on(IPC_CHANNELS.sshWrite, (_event, sessionId: string, data: string) => {
    try {
      sshService.writeToShell(sessionId, data)
    } catch {
      // Shell already closed or session gone: drop the input silently.
    }
  })
  ipcMain.on(IPC_CHANNELS.sshResize, (_event, sessionId: string, cols: number, rows: number) => {
    try {
      sshService.resizeShell(sessionId, cols, rows)
    } catch {
      // Shell already closed or session gone: drop the resize silently.
    }
  })
  handle(IPC_CHANNELS.sshClose, (_event, sessionId: string) => sshService.closeSession(sessionId))

  // --- SFTP file management ---
  handle(IPC_CHANNELS.sftpHomeDir, (_event, sessionId: string) => sftpService.homeDir(sessionId))
  handle(IPC_CHANNELS.sftpList, (_event, sessionId: string, path: string) =>
    sftpService.list(sessionId, path)
  )
  handle(IPC_CHANNELS.sftpMkdir, (_event, sessionId: string, path: string) =>
    sftpService.mkdir(sessionId, path)
  )
  handle(IPC_CHANNELS.sftpRename, (_event, sessionId: string, oldPath: string, newPath: string) =>
    sftpService.rename(sessionId, oldPath, newPath)
  )
  handle(IPC_CHANNELS.sftpDeleteFile, (_event, sessionId: string, path: string) =>
    sftpService.deleteFile(sessionId, path)
  )
  handle(IPC_CHANNELS.sftpDeleteDir, (_event, sessionId: string, path: string) =>
    sftpService.deleteDir(sessionId, path)
  )
  handle(IPC_CHANNELS.sftpUpload, (event, sessionId: string, localPath: string, remotePath: string) =>
    sftpService.upload(sessionId, localPath, remotePath, (progress) =>
      send(event.sender, sftpProgressChannel(sessionId), { ...progress, direction: 'upload' })
    )
  )
  handle(
    IPC_CHANNELS.sftpDownload,
    (event, sessionId: string, remotePath: string, localPath: string) =>
      sftpService.download(sessionId, remotePath, localPath, (progress) =>
        send(event.sender, sftpProgressChannel(sessionId), { ...progress, direction: 'download' })
      )
  )

  // --- VNC WebSocket bridges ---
  handle(
    IPC_CHANNELS.vncStartBridge,
    async (_event, params: VncStartBridgeParams): Promise<VncBridgeHandle> => {
      const bridge = await startVncBridge(params)
      const bridgeId = `bridge-${++bridgeSeq}`
      bridges.set(bridgeId, bridge)
      return { bridgeId, wsPort: bridge.wsPort }
    },
    mapVncErrorCode
  )
  handle(IPC_CHANNELS.vncStopBridge, async (_event, bridgeId: string) => {
    const bridge = bridges.get(bridgeId)
    if (bridge === undefined) return // idempotent: an unknown id is already stopped
    bridges.delete(bridgeId)
    await bridge.close()
  })

  // --- Local filesystem (file manager left pane) ---
  handle(IPC_CHANNELS.localFsHomeDir, () => localFs.homeDir())
  handle(IPC_CHANNELS.localFsList, (_event, path: string) => localFs.list(path))

  // --- Saved connections (safeStorage-encrypted secrets, src/main/store.ts) ---
  handle(IPC_CHANNELS.connectionsList, (): Promise<SavedConnectionSummary[]> => store.list())
  handle(IPC_CHANNELS.connectionsGet, (_event, id: string): Promise<SavedConnection | null> =>
    store.get(id)
  )
  handle(
    IPC_CHANNELS.connectionsSave,
    (_event, input: SavedConnectionInput): Promise<SavedConnectionSummary> => store.save(input)
  )
  handle(IPC_CHANNELS.connectionsDelete, (_event, id: string) => store.remove(id))

  // --- Native file dialogs ---
  handle(IPC_CHANNELS.dialogPickFiles, async (event) => {
    const options: OpenDialogOptions = { properties: ['openFile', 'multiSelections'] }
    const win = BrowserWindow.fromWebContents(event.sender)
    const result =
      win === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(win, options)
    return result.canceled ? [] : result.filePaths
  })
  handle(IPC_CHANNELS.dialogPickSavePath, async (event, defaultName: string) => {
    const options: SaveDialogOptions = { defaultPath: defaultName }
    const win = BrowserWindow.fromWebContents(event.sender)
    const result =
      win === null ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(win, options)
    return result.canceled || result.filePath === '' ? null : result.filePath
  })

  // Release every SSH session and VNC bridge when the app quits.
  app.on('before-quit', () => {
    sshService.closeAll()
    for (const bridge of bridges.values()) void bridge.close()
    bridges.clear()
  })
}
