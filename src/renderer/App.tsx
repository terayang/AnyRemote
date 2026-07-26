import { ConfigProvider, theme } from 'antd'
import { useEffect } from 'react'
import ScanPage from './pages/ScanPage'
import SessionPage from './pages/SessionPage'
import { useAppStore } from './store'

export default function App() {
  const page = useAppStore((s) => s.page)

  // Keyboard-first shortcuts (see docs/ARCHITECTURE.md §8).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      const key = e.key.toLowerCase()
      if (key === 'k') {
        e.preventDefault()
        document.getElementById('target-address-input')?.focus()
      } else if (key === 'w') {
        e.preventDefault()
        const { activeTab, closeTab } = useAppStore.getState()
        if (activeTab) closeTab(activeTab)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <ConfigProvider
      theme={{
        algorithm: [theme.darkAlgorithm, theme.compactAlgorithm],
        token: {
          colorPrimary: '#4c8dff',
          colorInfo: '#4c8dff',
          borderRadius: 6
        }
      }}
    >
      {page === 'scan' ? <ScanPage /> : <SessionPage />}
    </ConfigProvider>
  )
}
