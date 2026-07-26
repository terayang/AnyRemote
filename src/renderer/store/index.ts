import { create } from 'zustand'
import type { ProtocolId } from '../../shared/protocols'

export type Page = 'scan' | 'session'

export type TabKind = 'desktop' | 'terminal' | 'files'

export interface SessionTab {
  key: TabKind
  /** i18n key for the tab label. */
  titleKey: string
}

/** Mock scan outcome for phase 1: only SSH and VNC are detected open. */
const MOCK_OPEN_PROTOCOLS: readonly ProtocolId[] = ['ssh', 'vnc']

const MOCK_SCAN_DURATION_MS = 1500

const SESSION_TABS: readonly SessionTab[] = [
  { key: 'desktop', titleKey: 'session.tabs.desktop' },
  { key: 'terminal', titleKey: 'session.tabs.terminal' },
  { key: 'files', titleKey: 'session.tabs.files' }
]

interface AppState {
  page: Page
  targetAddress: string
  scanning: boolean
  /** Protocols reported open by the last (mock) scan; null before any scan. */
  openProtocols: readonly ProtocolId[] | null
  selected: ProtocolId[]
  tabs: SessionTab[]
  activeTab: TabKind | null
  setTargetAddress: (address: string) => void
  startScan: () => void
  toggleProtocol: (id: ProtocolId) => void
  connect: () => void
  setActiveTab: (key: TabKind) => void
  closeTab: (key: TabKind) => void
  disconnect: () => void
}

export const useAppStore = create<AppState>((set, get) => ({
  page: 'scan',
  targetAddress: '192.168.50.43',
  scanning: false,
  openProtocols: null,
  selected: [],
  tabs: [],
  activeTab: null,

  setTargetAddress: (address) => set({ targetAddress: address }),

  startScan: () => {
    if (get().scanning) return
    set({ scanning: true, openProtocols: null, selected: [] })
    // Phase 1 mock: simulate a network scan, then reveal fixed results.
    setTimeout(() => {
      set({ scanning: false, openProtocols: MOCK_OPEN_PROTOCOLS })
    }, MOCK_SCAN_DURATION_MS)
  },

  toggleProtocol: (id) =>
    set((state) => ({
      selected: state.selected.includes(id)
        ? state.selected.filter((p) => p !== id)
        : [...state.selected, id]
    })),

  connect: () =>
    set({
      page: 'session',
      tabs: [...SESSION_TABS],
      activeTab: 'desktop'
    }),

  setActiveTab: (key) => set({ activeTab: key }),

  closeTab: (key) =>
    set((state) => {
      const tabs = state.tabs.filter((t) => t.key !== key)
      if (tabs.length === 0) {
        // Closing the last tab ends the session and returns to the scan page.
        return { tabs, activeTab: null, page: 'scan' as Page }
      }
      const activeTab =
        state.activeTab === key ? tabs[tabs.length - 1].key : state.activeTab
      return { tabs, activeTab }
    }),

  disconnect: () =>
    set({ page: 'scan', tabs: [], activeTab: null, selected: [] })
}))
