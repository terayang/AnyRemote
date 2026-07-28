import type { AnyRemoteApi } from './index'

declare global {
  interface Window {
    anyremote: AnyRemoteApi
  }
}

export {}
