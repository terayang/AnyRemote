import { ApiOutlined } from '@ant-design/icons'
import { Button, Layout, Modal, Popconfirm, Space, Tabs, Tag, Typography, message } from 'antd'
import { useEffect, type ComponentType } from 'react'
import { useTranslation } from 'react-i18next'
import { ipcErrorMessage } from '../../shared/ipc'
import DesktopPanel from '../components/DesktopPanel'
import FileManagerPanel from '../components/FileManagerPanel'
import NewConnectionModal from '../components/NewConnectionModal'
import TerminalPanel from '../components/TerminalPanel'
import { useAppStore, type TabKind } from '../store'
import { savedToCredentials, useSavedConnectionsStore } from '../store/savedConnections'
import { useSessionStore } from '../store/session'

const { Sider, Content } = Layout
const { Text } = Typography

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
  const beginSavedSession = useAppStore((s) => s.beginSavedSession)
  const disconnect = useAppStore((s) => s.disconnect)
  const newConnectionOpen = useAppStore((s) => s.newConnectionOpen)
  const setNewConnectionOpen = useAppStore((s) => s.setNewConnectionOpen)
  const context = useSessionStore((s) => s.context)
  const target = context?.target ?? targetAddress
  const protocolTag =
    context && context.protocols.length > 0
      ? context.protocols.join('+').toUpperCase()
      : null

  const [messageApi, contextHolder] = message.useMessage()
  const [modalApi, modalHolder] = Modal.useModal()
  const savedConnections = useSavedConnectionsStore((s) => s.connections)
  const refreshSaved = useSavedConnectionsStore((s) => s.refresh)
  // The saved entry the current session started from (A5/A6), when any.
  const currentSaved = savedConnections.find((c) => c.id === context?.savedId)

  useEffect(() => {
    void refreshSaved()
  }, [refreshSaved])

  /**
   * Reconnects to a saved target with its decrypted credentials
   * (beginSavedSession resets the panels' per-session stores; the panels
   * close their own SSH/VNC resources via their context-change cleanups).
   */
  const openSavedSession = async (id: string): Promise<void> => {
    try {
      const conn = await window.anyremote.connections.get(id)
      if (!conn) {
        await refreshSaved()
        return
      }
      beginSavedSession(
        { id: conn.id, host: conn.host, protocols: conn.protocols },
        savedToCredentials(conn)
      )
    } catch (err) {
      void messageApi.error(`${t('saved.loadFailed')}: ${ipcErrorMessage(err)}`)
    }
  }

  /**
   * Sider entry click. Switching targets replaces the live session
   * (single-session model), so it always asks first; cancelling leaves the
   * current session untouched.
   */
  const switchToSaved = (id: string): void => {
    if (!context) {
      void openSavedSession(id)
      return
    }
    void modalApi.confirm({
      title: t('session.switchNewConfirm', { target: context.target }),
      okText: t('credentials.submit'),
      cancelText: t('saved.cancel'),
      onOk: () => void openSavedSession(id)
    })
  }

  return (
    <Layout style={{ height: '100%' }}>
      {contextHolder}
      <Sider width={216} className="session-sider">
        {modalHolder}
        <div className="session-sider-header">
          <ApiOutlined style={{ color: '#4c8dff' }} />
          <Text strong>AnyRemote</Text>
        </div>
        <div className="session-sider-newconn">
          <Button
            id="new-connection-button"
            type="primary"
            block
            onClick={() => setNewConnectionOpen(true)}
          >
            {t('session.newConnection')}
          </Button>
        </div>
        <Text type="secondary" style={{ fontSize: 12, padding: '0 12px' }}>
          {t('session.saved')}
        </Text>
        <div className="saved-list">
          <div className="saved-item saved-item-active">
            <Space size={6}>
              <Text style={{ fontSize: 13 }}>
                {currentSaved ? `${t('session.current')} · ${currentSaved.name}` : t('session.current')}
              </Text>
              {protocolTag && (
                <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                  {protocolTag}
                </Tag>
              )}
            </Space>
            <Text className="mono" type="secondary" style={{ fontSize: 12 }}>
              {target}
            </Text>
            {currentSaved && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {currentSaved.username}
              </Text>
            )}
          </div>
          {savedConnections
            // A5: hide only the exact identity the session started from —
            // same-host siblings (other usernames) stay visible and clickable.
            .filter((c) => c.id !== context?.savedId)
            .map((c) => (
              <div key={c.id} className="saved-item" onClick={() => switchToSaved(c.id)}>
                <Space size={6}>
                  <Text style={{ fontSize: 13 }}>{c.name}</Text>
                  {c.protocols.map((p) => (
                    <Tag key={p} style={{ marginInlineEnd: 0 }}>
                      {p.toUpperCase()}
                    </Tag>
                  ))}
                </Space>
                <Text className="mono" type="secondary" style={{ fontSize: 12 }}>
                  {c.host}
                </Text>
              </div>
            ))}
        </div>
        <div className="session-sider-footer">
          <Popconfirm
            title={t('session.disconnectConfirm', { target })}
            okText={t('session.disconnect')}
            cancelText={t('saved.cancel')}
            placement="topLeft"
            onConfirm={() => disconnect()}
          >
            <Button id="disconnect-button" type="text" danger block>
              {t('session.disconnect')}
            </Button>
          </Popconfirm>
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
      <NewConnectionModal
        open={newConnectionOpen}
        onClose={() => setNewConnectionOpen(false)}
      />
    </Layout>
  )
}
