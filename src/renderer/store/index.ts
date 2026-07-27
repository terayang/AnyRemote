import { create } from 'zustand'
import type { ProtocolId } from '../../shared/protocols'
import type { TargetScanReport } from '../../shared/scan'
import { useFilesStore } from './files'
import { useSessionStore, type SessionCredentials } from './session'
import { useTerminalStore } from './terminal'
import { detachVnc } from './vnc'

export type Page = 'scan' | 'session'

export type TabKind = 'desktop' | 'terminal' | 'files'

export interface SessionTab {
  key: TabKind
  /** i18n key for the tab label. */
  titleKey: string
}

/** Session tabs implied by the protocols the user checked: ssh -> terminal +
 * files, vnc -> remote desktop. */
function tabsForProtocols(protocols: readonly ProtocolId[]): SessionTab[] {
  const tabs: SessionTab[] = []
  if (protocols.includes('vnc')) tabs.push({ key: 'desktop', titleKey: 'session.tabs.desktop' })
  if (protocols.includes('ssh')) {
    tabs.push({ key: 'terminal', titleKey: 'session.tabs.terminal' })
    tabs.push({ key: 'files', titleKey: 'session.tabs.files' })
  }
  return tabs
}

/** Protocols the MVP can actually open a session for (others are scan-only). */
const SESSION_PROTOCOLS: readonly ProtocolId[] = ['ssh', 'vnc']

function toSessionProtocols(protocols: readonly string[]): ProtocolId[] {
  return protocols.filter((p): p is ProtocolId =>
    (SESSION_PROTOCOLS as readonly string[]).includes(p)
  )
}

/**
 * Releases every panel's per-session resources (SSH sessions close via the
 * panels' own unmount/context-change cleanups; the stores and the live VNC
 * session are reset here so nothing from the previous target leaks into the
 * next one).
 */
function resetPanelStores(): void {
  useTerminalStore.getState().reset()
  useFilesStore.getState().reset()
  detachVnc()
}

interface AppState {
  page: Page
  targetAddress: string
  scanning: boolean
  /** Fingerprint report of the last completed scan; null before any scan. */
  scanReport: TargetScanReport | null
  /** Error message of the last failed scan; null when the scan succeeded. */
  scanError: string | null
  selected: ProtocolId[]
  tabs: SessionTab[]
  activeTab: TabKind | null
  setTargetAddress: (address: string) => void
  startScan: () => Promise<void>
  toggleProtocol: (id: ProtocolId) => void
  /** Stores the session context and switches to the session workspace. */
  beginSession: (credentials: SessionCredentials) => void
  /**
   * Starts a session straight from a saved connection (scan page double-click
   * or session-sider click): drops the current session's resources, then
   * opens the saved target's tabs with its decrypted credentials. The saved
   * entry's id is kept in the session context (SessionContext.savedId).
   */
  beginSavedSession: (
    saved: { host: string; protocols: string[]; id?: string },
    credentials: SessionCredentials
  ) => void
  setActiveTab: (key: TabKind) => void
  closeTab: (key: TabKind) => void
  disconnect: () => void
  /** NewConnectionModal visibility (session page button / ⌘K on session page). */
  newConnectionOpen: boolean
  setNewConnectionOpen: (open: boolean) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  page: 'scan',
  targetAddress: '192.168.50.43',
  scanning: false,
  scanReport: null,
  scanError: null,
  selected: [],
  tabs: [],
  activeTab: null,
  newConnectionOpen: false,

  setTargetAddress: (address) => set({ targetAddress: address }),

  startScan: async () => {
    const host = get().targetAddress.trim()
    if (get().scanning || host === '') return
    set({ scanning: true, scanReport: null, scanError: null, selected: [] })
    try {
      const scanReport = await window.anyremote.scan(host)
      set({ scanning: false, scanReport })
    } catch (err) {
      set({
        scanning: false,
        scanError: err instanceof Error ? err.message : String(err)
      })
    }
  },

  toggleProtocol: (id) =>
    set((state) => ({
      selected: state.selected.includes(id)
        ? state.selected.filter((p) => p !== id)
        : [...state.selected, id]
    })),

  beginSession: (credentials) => {
    const { targetAddress, selected } = get()
    resetPanelStores()
    useSessionStore.getState().setContext({
      target: targetAddress.trim(),
      protocols: [...selected],
      credentials
    })
    const tabs = tabsForProtocols(selected)
    set({ page: 'session', tabs, activeTab: tabs[0]?.key ?? null, newConnectionOpen: false })
  },

  beginSavedSession: (saved, credentials) => {
    const protocols = toSessionProtocols(saved.protocols)
    resetPanelStores()
    useSessionStore.getState().setContext({
      target: saved.host,
      protocols,
      credentials,
      ...(saved.id ? { savedId: saved.id } : {})
    })
    const tabs = tabsForProtocols(protocols)
    set({
      page: 'session',
      tabs,
      activeTab: tabs[0]?.key ?? null,
      targetAddress: saved.host,
      selected: protocols,
      newConnectionOpen: false
    })
  },

  setActiveTab: (key) => set({ activeTab: key }),

  closeTab: (key) =>
    set((state) => {
      const tabs = state.tabs.filter((t) => t.key !== key)
      if (tabs.length === 0) {
        // Closing the last tab ends the session and returns to the scan page.
        useSessionStore.getState().clearContext()
        resetPanelStores()
        return { tabs, activeTab: null, page: 'scan' as Page, newConnectionOpen: false }
      }
      const activeTab =
        state.activeTab === key ? tabs[tabs.length - 1].key : state.activeTab
      return { tabs, activeTab }
    }),

  disconnect: () => {
    useSessionStore.getState().clearContext()
    resetPanelStores()
    set({ page: 'scan', tabs: [], activeTab: null, selected: [], newConnectionOpen: false })
  },

  setNewConnectionOpen: (open) => set({ newConnectionOpen: open })
}))
