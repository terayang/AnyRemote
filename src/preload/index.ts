import { contextBridge } from 'electron'

/** API surface exposed to the renderer as `window.anyremote`. */
export interface AnyRemoteApi {
  versions: {
    electron: string
    node: string
    chrome: string
  }
}

const api: AnyRemoteApi = {
  versions: {
    electron: process.versions.electron ?? '',
    node: process.versions.node ?? '',
    chrome: process.versions.chrome ?? ''
  }
}

contextBridge.exposeInMainWorld('anyremote', api)
