import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC_CHANNELS,
  rebuildIpcError,
  sftpProgressChannel,
  sshCloseChannel,
  sshDataChannel,
  type SftpProgressEvent,
  type VncBridgeHandle,
  type VncStartBridgeParams
} from '../shared/ipc'
import type { TargetScanReport } from '../shared/scan'
import type { FileEntry, ShellSize, SshAuthConfig } from '../shared/ssh'

/** API surface exposed to the renderer as `window.anyremote`. */
export interface AnyRemoteApi {
  versions: {
    electron: string
    node: string
    chrome: string
  }
  scan(host: string): Promise<TargetScanReport>
  ssh: {
    /** Resolves with the session id; rejects with IpcInvokeError (code kept). */
    connect(config: SshAuthConfig): Promise<string>
    openShell(sessionId: string, size: ShellSize): Promise<void>
    /** Fire-and-forget keystroke input (send, not invoke). */
    write(sessionId: string, data: string): void
    resize(sessionId: string, cols: number, rows: number): void
    close(sessionId: string): Promise<void>
    /** Subscribes to shell output; returns the unsubscribe function. */
    onData(sessionId: string, cb: (data: string) => void): () => void
    /** Subscribes to the shell-closed event; returns the unsubscribe function. */
    onClose(sessionId: string, cb: () => void): () => void
  }
  sftp: {
    homeDir(sessionId: string): Promise<string>
    list(sessionId: string, path: string): Promise<FileEntry[]>
    mkdir(sessionId: string, path: string): Promise<void>
    rename(sessionId: string, oldPath: string, newPath: string): Promise<void>
    deleteFile(sessionId: string, path: string): Promise<void>
    deleteDir(sessionId: string, path: string): Promise<void>
    /** Progress is delivered via onProgress, not the promise. */
    upload(sessionId: string, localPath: string, remotePath: string): Promise<void>
    download(sessionId: string, remotePath: string, localPath: string): Promise<void>
    onProgress(sessionId: string, cb: (progress: SftpProgressEvent) => void): () => void
  }
  vnc: {
    startBridge(params: VncStartBridgeParams): Promise<VncBridgeHandle>
    stopBridge(bridgeId: string): Promise<void>
  }
  localFs: {
    homeDir(): Promise<string>
    list(path: string): Promise<FileEntry[]>
  }
  dialog: {
    /** Multi-select file picker; resolves with [] when canceled. */
    pickFiles(): Promise<string[]>
    /** Save-as picker; resolves with null when canceled. */
    pickSavePath(defaultName: string): Promise<string | null>
  }
}

/**
 * invoke wrapper: rebuilds the IpcError the handler threw (Electron re-wraps
 * handler errors, dropping the code; see src/shared/ipc.ts).
 */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T
  } catch (err) {
    throw rebuildIpcError(err)
  }
}

/** Subscribes to a main-process event channel; returns the unsubscribe function. */
function subscribe<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, ...args: unknown[]): void => {
    cb(...(args as T))
  }
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: AnyRemoteApi = {
  versions: {
    electron: process.versions.electron ?? '',
    node: process.versions.node ?? '',
    chrome: process.versions.chrome ?? ''
  },
  scan: (host) => invoke<TargetScanReport>(IPC_CHANNELS.scan, host),
  ssh: {
    connect: (config) => invoke<string>(IPC_CHANNELS.sshConnect, config),
    openShell: (sessionId, size) => invoke<void>(IPC_CHANNELS.sshOpenShell, sessionId, size),
    write: (sessionId, data) => {
      ipcRenderer.send(IPC_CHANNELS.sshWrite, sessionId, data)
    },
    resize: (sessionId, cols, rows) => {
      ipcRenderer.send(IPC_CHANNELS.sshResize, sessionId, cols, rows)
    },
    close: (sessionId) => invoke<void>(IPC_CHANNELS.sshClose, sessionId),
    onData: (sessionId, cb) => subscribe(sshDataChannel(sessionId), cb),
    onClose: (sessionId, cb) => subscribe(sshCloseChannel(sessionId), cb)
  },
  sftp: {
    homeDir: (sessionId) => invoke<string>(IPC_CHANNELS.sftpHomeDir, sessionId),
    list: (sessionId, path) => invoke<FileEntry[]>(IPC_CHANNELS.sftpList, sessionId, path),
    mkdir: (sessionId, path) => invoke<void>(IPC_CHANNELS.sftpMkdir, sessionId, path),
    rename: (sessionId, oldPath, newPath) =>
      invoke<void>(IPC_CHANNELS.sftpRename, sessionId, oldPath, newPath),
    deleteFile: (sessionId, path) => invoke<void>(IPC_CHANNELS.sftpDeleteFile, sessionId, path),
    deleteDir: (sessionId, path) => invoke<void>(IPC_CHANNELS.sftpDeleteDir, sessionId, path),
    upload: (sessionId, localPath, remotePath) =>
      invoke<void>(IPC_CHANNELS.sftpUpload, sessionId, localPath, remotePath),
    download: (sessionId, remotePath, localPath) =>
      invoke<void>(IPC_CHANNELS.sftpDownload, sessionId, remotePath, localPath),
    onProgress: (sessionId, cb) => subscribe(sftpProgressChannel(sessionId), cb)
  },
  vnc: {
    startBridge: (params) => invoke<VncBridgeHandle>(IPC_CHANNELS.vncStartBridge, params),
    stopBridge: (bridgeId) => invoke<void>(IPC_CHANNELS.vncStopBridge, bridgeId)
  },
  localFs: {
    homeDir: () => invoke<string>(IPC_CHANNELS.localFsHomeDir),
    list: (path) => invoke<FileEntry[]>(IPC_CHANNELS.localFsList, path)
  },
  dialog: {
    pickFiles: () => invoke<string[]>(IPC_CHANNELS.dialogPickFiles),
    pickSavePath: (defaultName) =>
      invoke<string | null>(IPC_CHANNELS.dialogPickSavePath, defaultName)
  }
}

contextBridge.exposeInMainWorld('anyremote', api)
