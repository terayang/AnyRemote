import { create } from 'zustand'

/** Minimal example store: the target address entered on the scan page. */
interface AppState {
  targetAddress: string
  setTargetAddress: (address: string) => void
}

export const useAppStore = create<AppState>((set) => ({
  targetAddress: '',
  setTargetAddress: (address) => set({ targetAddress: address })
}))
