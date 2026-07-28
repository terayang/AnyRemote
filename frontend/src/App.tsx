import { SettingOutlined } from '@ant-design/icons'
import { App as AntdApp, Button, ConfigProvider, Segmented, theme } from 'antd'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import SettingsModal from './components/SettingsModal'
import { setLanguage, type AppLanguage } from './i18n'
import ScanPage from './pages/ScanPage'
import SessionPage from './pages/SessionPage'
import { useAppStore } from './store'

export default function App() {
  const page = useAppStore((s) => s.page)
  const { t, i18n } = useTranslation()
  const language: AppLanguage = i18n.language.startsWith('en') ? 'en-US' : 'zh-CN'
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Keyboard-first shortcuts (see docs/ARCHITECTURE.md §8).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      const key = e.key.toLowerCase()
      if (key === 'k') {
        e.preventDefault()
        // ⌘K dispatches per page: on the scan page it focuses the target
        // input; in the session workspace it opens the new-connection modal.
        const { page, setNewConnectionOpen } = useAppStore.getState()
        if (page === 'session') {
          setNewConnectionOpen(true)
        } else {
          document.getElementById('target-address-input')?.focus()
        }
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
      <AntdApp>
        <div className="app-shell">
          <div className="app-header">
            <Segmented
              size="small"
              value={language}
              onChange={(lng) => setLanguage(lng as AppLanguage)}
              options={[
                { label: '中文', value: 'zh-CN' },
                { label: 'EN', value: 'en-US' }
              ]}
            />
            <Button
              type="text"
              size="small"
              icon={<SettingOutlined />}
              aria-label={t('settings.open')}
              style={{ marginLeft: 8 }}
              onClick={() => setSettingsOpen(true)}
            />
          </div>
          <div className="app-body">{page === 'scan' ? <ScanPage /> : <SessionPage />}</div>
          <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        </div>
      </AntdApp>
    </ConfigProvider>
  )
}
