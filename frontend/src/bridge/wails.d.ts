/**
 * Types for the globals the Wails runtime injects into the webview:
 * window.go.<package>.<Struct>.<method> for every bound Go method and
 * window.runtime for the event bus. The generated (gitignored)
 * frontend/wailsjs bindings are thin wrappers over exactly this surface;
 * declaring it here keeps `tsc --noEmit` and plain `vite dev` independent of
 * `wails build`.
 *
 * The method list mirrors the exported methods of *App (bindings.go) and the
 * JSON shapes mirror the Go structs' json tags (which match the shared TS
 * types one-to-one).
 */

import type { VncBridgeHandle } from '../../shared/ipc'
import type { TargetScanReport } from '../../shared/scan'
import type { FileEntry, SshAuthConfig } from '../../shared/ssh'

/** window.go.main.App: the bound *App methods (see bindings.go). */
export interface WailsApp {
  Scan(host: string): Promise<TargetScanReport>
  SshConnect(cfg: SshAuthConfig): Promise<string>
  SshOpenShell(id: string, cols: number, rows: number): Promise<void>
  SshWrite(id: string, data: string): Promise<void>
  SshResize(id: string, cols: number, rows: number): Promise<void>
  SshClose(id: string): Promise<void>
  SftpHomeDir(id: string): Promise<string>
  SftpList(id: string, path: string): Promise<FileEntry[]>
  SftpMkdir(id: string, path: string): Promise<void>
  SftpRename(id: string, oldPath: string, newPath: string): Promise<void>
  SftpDeleteFile(id: string, path: string): Promise<void>
  SftpDeleteDir(id: string, path: string): Promise<void>
  SftpUpload(id: string, localPath: string, remotePath: string): Promise<void>
  SftpDownload(id: string, remotePath: string, localPath: string): Promise<void>
  VncStartBridge(
    host: string,
    port: number,
    username: string,
    password: string,
    encodings: number[] | null
  ): Promise<VncBridgeHandle>
  VncStopBridge(id: string): Promise<void>
  LocalFsHomeDir(): Promise<string>
  LocalFsList(path: string): Promise<FileEntry[]>
  DialogPickFiles(): Promise<string[]>
  /** Resolves with "" when the dialog is canceled. */
  DialogPickSavePath(defaultName: string): Promise<string>
}

/** The subset of the injected window.runtime event bus the bridge uses. */
export interface WailsRuntime {
  /** Subscribes to a Go-emitted event; returns the unsubscribe function. */
  EventsOn(eventName: string, callback: (...args: any[]) => void): () => void
  EventsOff(eventName: string, ...additionalEventNames: string[]): void
}

declare global {
  interface Window {
    /** Present only inside the Wails webview (absent under plain vite dev). */
    go?: { main?: { App?: WailsApp } }
    runtime?: WailsRuntime
  }
}

export {}
