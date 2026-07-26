import { SearchOutlined } from '@ant-design/icons'
import { Button, Input, Progress, Space, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PROTOCOLS } from '../../shared/protocols'
import ProtocolCard from '../components/ProtocolCard'
import { useAppStore } from '../store'

const { Title, Text } = Typography

export default function ScanPage() {
  const { t } = useTranslation()
  const targetAddress = useAppStore((s) => s.targetAddress)
  const setTargetAddress = useAppStore((s) => s.setTargetAddress)
  const scanning = useAppStore((s) => s.scanning)
  const openProtocols = useAppStore((s) => s.openProtocols)
  const selected = useAppStore((s) => s.selected)
  const startScan = useAppStore((s) => s.startScan)
  const toggleProtocol = useAppStore((s) => s.toggleProtocol)
  const connect = useAppStore((s) => s.connect)

  // Fake but smooth progress bar for the mock scan (~1.5s).
  const [percent, setPercent] = useState(0)
  useEffect(() => {
    if (!scanning) {
      setPercent(0)
      return
    }
    const timer = setInterval(() => {
      setPercent((p) => Math.min(p + 6, 95))
    }, 90)
    return () => clearInterval(timer)
  }, [scanning])

  return (
    <div className="scan-page">
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
            onPressEnter={startScan}
          />
          <Button
            type="primary"
            size="large"
            icon={<SearchOutlined />}
            loading={scanning}
            onClick={startScan}
          >
            {t('scan.start')}
          </Button>
        </Space.Compact>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('scan.shortcutHint')}
        </Text>
        {scanning && (
          <div style={{ width: 420 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('scan.scanning')}
            </Text>
            <Progress percent={percent} size="small" status="active" showInfo={false} />
          </div>
        )}
      </Space>

      {openProtocols && (
        <div className="protocol-grid">
          {PROTOCOLS.map((meta) => (
            <ProtocolCard
              key={meta.id}
              meta={meta}
              open={openProtocols.includes(meta.id)}
              selected={selected.includes(meta.id)}
              onToggle={toggleProtocol}
            />
          ))}
        </div>
      )}

      {openProtocols && (
        <div className="scan-footer">
          <Text type="secondary">{t('scan.selectedCount', { count: selected.length })}</Text>
          <Button type="primary" disabled={selected.length === 0} onClick={connect}>
            {t('scan.connect')}
          </Button>
        </div>
      )}
    </div>
  )
}
