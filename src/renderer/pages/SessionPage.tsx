import { ApiOutlined } from '@ant-design/icons'
import { Layout, Space, Tabs, Tag, Typography } from 'antd'
import type { ComponentType } from 'react'
import { useTranslation } from 'react-i18next'
import DesktopPanel from '../components/DesktopPanel'
import FileManagerPanel from '../components/FileManagerPanel'
import TerminalPanel from '../components/TerminalPanel'
import { useAppStore, type TabKind } from '../store'

const { Sider, Content } = Layout
const { Text } = Typography

/** Mock saved-connection list for the phase-1 UI prototype. */
const SAVED_CONNECTIONS = [
  { name: 'Mac Studio', address: '100.103.82.44' },
  { name: 'Linux Relay', address: '100.110.128.32' }
]

const TAB_PANELS: Record<TabKind, ComponentType> = {
  desktop: DesktopPanel,
  terminal: TerminalPanel,
  files: FileManagerPanel
}

export default function SessionPage() {
  const { t } = useTranslation()
  const targetAddress = useAppStore((s) => s.targetAddress)
  const tabs = useAppStore((s) => s.tabs)
  const activeTab = useAppStore((s) => s.activeTab)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const closeTab = useAppStore((s) => s.closeTab)

  return (
    <Layout style={{ height: '100vh' }}>
      <Sider width={216} className="session-sider">
        <div className="session-sider-header">
          <ApiOutlined style={{ color: '#4c8dff' }} />
          <Text strong>AnyRemote</Text>
        </div>
        <Text type="secondary" style={{ fontSize: 12, padding: '0 12px' }}>
          {t('session.saved')}
        </Text>
        <div className="saved-list">
          <div className="saved-item saved-item-active">
            <Space size={6}>
              <Text style={{ fontSize: 13 }}>{t('session.current')}</Text>
              <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                SSH+VNC
              </Tag>
            </Space>
            <Text className="mono" type="secondary" style={{ fontSize: 12 }}>
              {targetAddress}
            </Text>
          </div>
          {SAVED_CONNECTIONS.map((c) => (
            <div key={c.address} className="saved-item">
              <Text style={{ fontSize: 13 }}>{c.name}</Text>
              <Text className="mono" type="secondary" style={{ fontSize: 12 }}>
                {c.address}
              </Text>
            </div>
          ))}
        </div>
      </Sider>
      <Content style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column' }}>
        <Tabs
          className="session-tabs"
          type="editable-card"
          hideAdd
          activeKey={activeTab ?? undefined}
          onChange={(key) => setActiveTab(key as TabKind)}
          onEdit={(key, action) => {
            if (action === 'remove') closeTab(key as TabKind)
          }}
          items={tabs.map((tab) => {
            const Panel = TAB_PANELS[tab.key]
            return {
              key: tab.key,
              label: t(tab.titleKey),
              children: <Panel />
            }
          })}
        />
      </Content>
    </Layout>
  )
}
