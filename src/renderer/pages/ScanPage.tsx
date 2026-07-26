import { SearchOutlined } from '@ant-design/icons'
import { Button, Input, Space, Spin, Typography, message } from 'antd'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PROTOCOLS } from '../../shared/protocols'
import CredentialsModal from '../components/CredentialsModal'
import ProtocolCard from '../components/ProtocolCard'
import { useAppStore } from '../store'

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

  const [messageApi, contextHolder] = message.useMessage()
  const [credsOpen, setCredsOpen] = useState(false)

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
            onPressEnter={() => void startScan()}
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
        onSubmit={(credentials) => {
          setCredsOpen(false)
          beginSession(credentials)
        }}
      />
    </div>
  )
}
