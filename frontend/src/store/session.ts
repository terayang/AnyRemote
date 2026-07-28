import { create } from 'zustand'

/** Credentials collected by CredentialsModal before a session starts. */
export interface SessionCredentials {
  username: string
  password?: string
  /** Path to a local private-key file (advanced option). */
  privateKey?: string
  /** Passphrase decrypting the private key (advanced option). */
  passphrase?: string
}

/**
 * Everything the session workspace needs to know about the current
 * connection: who we connect to, over which protocols, as which user.
 * Written once when the credentials modal is submitted; cleared on
 * disconnect / closing the last tab.
 */
export interface SessionContext {
  target: string
  /** Protocol ids the user checked on the scan page. */
  protocols: string[]
  credentials: SessionCredentials
  /**
   * Id of the saved connection this session started from (beginSavedSession
   * only); lets the sider filter the current entry by identity instead of by
   * host, so same-host siblings stay visible.
   */
  savedId?: string
}

interface SessionState {
  context: SessionContext | null
  setContext: (context: SessionContext) => void
  clearContext: () => void
}

export const useSessionStore = create<SessionState>((set) => ({
  context: null,
  setContext: (context) => set({ context }),
  clearContext: () => set({ context: null })
}))
