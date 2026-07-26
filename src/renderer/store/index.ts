import { create } from 'zustand'
import type { ProtocolId } from '../../shared/protocols'
import type { TargetScanReport } from '../../shared/scan'
import { useSessionStore, type SessionCredentials } from './session'

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
  setActiveTab: (key: TabKind) => void
  closeTab: (key: TabKind) => void
  disconnect: () => void
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
    useSessionStore.getState().setContext({
      target: targetAddress.trim(),
      protocols: [...selected],
      credentials
    })
    const tabs = tabsForProtocols(selected)
    set({ page: 'session', tabs, activeTab: tabs[0]?.key ?? null })
  },

  setActiveTab: (key) => set({ activeTab: key }),

  closeTab: (key) =>
    set((state) => {
      const tabs = state.tabs.filter((t) => t.key !== key)
      if (tabs.length === 0) {
        // Closing the last tab ends the session and returns to the scan page.
        useSessionStore.getState().clearContext()
        return { tabs, activeTab: null, page: 'scan' as Page }
      }
      const activeTab =
        state.activeTab === key ? tabs[tabs.length - 1].key : state.activeTab
      return { tabs, activeTab }
    }),

  disconnect: () => {
    useSessionStore.getState().clearContext()
    set({ page: 'scan', tabs: [], activeTab: null, selected: [] })
  }
}))
