import { DeleteOutlined, SearchOutlined } from '@ant-design/icons'
import { Alert, Button, Input, Popconfirm, Radio, Space, Spin, Tag, Tooltip, Typography, message } from 'antd'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ipcErrorMessage } from '../../shared/ipc'
import { PROTOCOLS } from '../../shared/protocols'
import CredentialsModal from '../components/CredentialsModal'
import ProtocolCard from '../components/ProtocolCard'
import { useAppStore } from '../store'
import { savedToCredentials, useSavedConnectionsStore } from '../store/savedConnections'

const { Title, Text } = Typography

export default function ScanPage() {
  const { t } = useTranslation()
  const targetAddress = useAppStore((s) => s.targetAddress)
  const setTargetAddress = useAppStore((s) => s.setTargetAddress)
  const scanning = useAppStore((s) => s.scanning)
  const scanReport = useAppStore((s) => s.scanReport)
  const scanError = useAppStore((s) => s.scanError)
  const selected = useAppStore((s) => s.selected)
  const startScan = useAppStore((s) => s.startScan)
  const toggleProtocol = useAppStore((s) => s.toggleProtocol)
  const beginSession = useAppStore((s) => s.beginSession)
  const beginSavedSession = useAppStore((s) => s.beginSavedSession)

  const savedConnections = useSavedConnectionsStore((s) => s.connections)
  const savedLoaded = useSavedConnectionsStore((s) => s.loaded)
  const refreshSaved = useSavedConnectionsStore((s) => s.refresh)
  const saveConnection = useSavedConnectionsStore((s) => s.save)
  const removeConnection = useSavedConnectionsStore((s) => s.remove)

  const [messageApi, contextHolder] = message.useMessage()
  const [credsOpen, setCredsOpen] = useState(false)

  // Load the saved-connection list once per visit to the scan page.
  useEffect(() => {
    void refreshSaved()
  }, [refreshSaved])

  // B1: exact saved-address match (trim + lowercase) driving the quick-connect
  // banner; skipped until the saved list has loaded to avoid a first-paint
  // flicker, and empty input never matches.
  const normalizedInput = targetAddress.trim().toLowerCase()
  const matches =
    savedLoaded && normalizedInput !== ''
      ? savedConnections.filter((c) => c.host.trim().toLowerCase() === normalizedInput)
      : []
  // B3: several identities for one host — the user picks one (first by default).
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null)
  const activeMatch = matches.find((m) => m.id === selectedMatchId) ?? matches[0]

  // B5: the saved list filters live by input substring (name / host /
  // username, case-insensitive); empty input restores the full list.
  const filteredSaved =
    normalizedInput === ''
      ? savedConnections
      : savedConnections.filter((c) =>
          [c.name, c.host, c.username].some((v) => v.toLowerCase().includes(normalizedInput))
        )

  // Elapsed-time ticker shown next to the spinner while a scan runs.
  const [elapsedMs, setElapsedMs] = useState(0)
  useEffect(() => {
    if (!scanning) {
      setElapsedMs(0)
      return
    }
    const startedAt = Date.now()
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), 100)
    return () => clearInterval(timer)
  }, [scanning])

  // Surface scan failures via an antd message toast.
  useEffect(() => {
    if (scanError) {
      void messageApi.error(`${t('scan.failed')}: ${scanError}`)
    }
  }, [scanError, messageApi, t])

  /** Direct connect from a saved entry: fetch decrypted credentials and go. */
  const connectSaved = async (id: string): Promise<void> => {
    try {
      const conn = await window.anyremote.connections.get(id)
      if (!conn) {
        await refreshSaved() // stale entry (deleted elsewhere): reload the list
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

  const removeSaved = async (id: string): Promise<void> => {
    try {
      await removeConnection(id)
    } catch (err) {
      void messageApi.error(`${t('saved.deleteFailed')}: ${ipcErrorMessage(err)}`)
    }
  }

  return (
    <div className="scan-page">
      {contextHolder}
      <Space direction="vertical" size={4} align="center" style={{ marginTop: 48 }}>
        <Title level={2} style={{ margin: 0 }}>
          {t('app.title')}
        </Title>
        <Text type="secondary">{t('app.tagline')}</Text>
      </Space>

      <Space direction="vertical" size={12} align="center" style={{ marginTop: 32 }}>
        <Space.Compact style={{ width: 420 }}>
          <Input
            id="target-address-input"
            className="mono"
            size="large"
            placeholder={t('app.targetPlaceholder')}
            value={targetAddress}
            disabled={scanning}
            onChange={(e) => setTargetAddress(e.target.value)}
            onPressEnter={() => {
              // B6: Enter connects directly when the input exactly matches a
              // saved entry; otherwise it starts a scan (unchanged behavior).
              if (activeMatch) void connectSaved(activeMatch.id)
              else void startScan()
            }}
          />
          <Button
            type="primary"
            size="large"
            icon={<SearchOutlined />}
            loading={scanning}
            onClick={() => void startScan()}
          >
            {t('scan.start')}
          </Button>
        </Space.Compact>
        {matches.length > 0 && activeMatch && (
          <div id="quick-connect-banner" style={{ width: 420 }}>
            <Alert
              type="info"
              showIcon
              message={
                <Space direction="vertical" size={6} style={{ width: '100%' }}>
                  <Text style={{ fontSize: 13 }}>
                    {matches.length === 1
                      ? t('scan.savedMatch', {
                          name: activeMatch.name,
                          username: activeMatch.username,
                          host: activeMatch.host
                        })
                      : t('scan.savedMatchMulti', { count: matches.length })}
                  </Text>
                  {matches.length > 1 && (
                    <Radio.Group
                      size="small"
                      value={activeMatch.id}
                      onChange={(e) => setSelectedMatchId(e.target.value as string)}
                    >
                      <Space direction="vertical" size={2}>
                        {matches.map((m) => (
                          <Radio key={m.id} value={m.id}>
                            <Text style={{ fontSize: 12 }}>
                              {m.name}（{m.username}）
                            </Text>
                          </Radio>
                        ))}
                      </Space>
                    </Radio.Group>
                  )}
                  <Space size={8}>
                    <Button
                      size="small"
                      type="primary"
                      onClick={() => void connectSaved(activeMatch.id)}
                    >
                      {t('scan.directConnect')}
                    </Button>
                    <Tooltip title={t('scan.rescanTooltip')}>
                      <Button size="small" type="link" onClick={() => void startScan()}>
                        {t('scan.rescan')}
                      </Button>
                    </Tooltip>
                  </Space>
                </Space>
              }
            />
          </div>
        )}
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('scan.shortcutHint')}
        </Text>
        {scanning && (
          <Space size={8}>
            <Spin size="small" />
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('scan.scanning')} ·{' '}
              {t('scan.elapsed', { seconds: (elapsedMs / 1000).toFixed(1) })}
            </Text>
          </Space>
        )}
      </Space>

      <div className="saved-connections">
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('session.saved')}
        </Text>
        {savedLoaded && savedConnections.length === 0 ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('saved.empty')}
          </Text>
        ) : savedLoaded && filteredSaved.length === 0 ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('saved.noMatch')}
          </Text>
        ) : (
          <div className="saved-conn-list">
            {filteredSaved.map((conn) => (
              <div
                key={conn.id}
                className="saved-conn-item"
                title={`${conn.host} · ${t('saved.doubleClickHint')}`}
                onClick={() => setTargetAddress(conn.host)}
                onDoubleClick={() => void connectSaved(conn.id)}
              >
                <div className="saved-conn-info">
                  <Text strong style={{ fontSize: 13 }}>
                    {conn.name}
                  </Text>
                  <Text className="mono" type="secondary" style={{ fontSize: 12 }}>
                    {conn.host}
                  </Text>
                  <Space size={4}>
                    {conn.protocols.map((p) => (
                      <Tag key={p} style={{ marginInlineEnd: 0 }}>
                        {p.toUpperCase()}
                      </Tag>
                    ))}
                  </Space>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {conn.username}
                  </Text>
                </div>
                <Space size={4} className="saved-conn-actions">
                  <Button
                    size="small"
                    onClick={(e) => {
                      e.stopPropagation()
                      void connectSaved(conn.id)
                    }}
                  >
                    {t('scan.connect')}
                  </Button>
                  <Popconfirm
                    title={t('saved.deleteConfirm')}
                    okText={t('saved.delete')}
                    cancelText={t('saved.cancel')}
                    onConfirm={() => void removeSaved(conn.id)}
                  >
                    <Button
                      size="small"
                      type="text"
                      danger
                      className="saved-conn-delete"
                      icon={<DeleteOutlined />}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </Popconfirm>
                </Space>
              </div>
            ))}
          </div>
        )}
      </div>

      {scanReport && (
        <div className="protocol-grid">
          {PROTOCOLS.map((meta) => {
            const result = scanReport.results.find((r) => r.protocolId === meta.id)
            if (!result) return null
            return (
              <ProtocolCard
                key={meta.id}
                meta={meta}
                result={result}
                selected={selected.includes(meta.id)}
                onToggle={toggleProtocol}
              />
            )
          })}
        </div>
      )}

      {scanReport && (
        <div className="scan-footer">
          <Text type="secondary">{t('scan.selectedCount', { count: selected.length })}</Text>
          <Button
            type="primary"
            disabled={selected.length === 0}
            onClick={() => setCredsOpen(true)}
          >
            {t('scan.connect')}
          </Button>
        </div>
      )}

      <CredentialsModal
        open={credsOpen}
        target={targetAddress.trim()}
        onCancel={() => setCredsOpen(false)}
        onSubmit={(credentials, saveRequest) => {
          setCredsOpen(false)
          if (!saveRequest) {
            beginSession(credentials)
            return
          }
          // Save first (failures toast but never block connecting), then go.
          // B7: saveRequest.existingId updates the same-host+username entry
          // instead of creating a duplicate.
          void (async () => {
            try {
              await saveConnection({
                ...(saveRequest.existingId ? { id: saveRequest.existingId } : {}),
                name: saveRequest.name,
                host: targetAddress.trim(),
                protocols: [...selected],
                username: credentials.username,
                secret: credentials.password
                  ? { kind: 'password', data: credentials.password }
                  : credentials.privateKey
                    ? { kind: 'privateKeyPath', data: credentials.privateKey }
                    : undefined
              })
            } catch (err) {
              void messageApi.error(`${t('saved.saveFailed')}: ${ipcErrorMessage(err)}`)
            }
            beginSession(credentials)
          })()
        }}
      />
    </div>
  )
}
