import {
  CodeOutlined,
  ConsoleSqlOutlined,
  DesktopOutlined,
  FolderOpenOutlined,
  GlobalOutlined,
  HddOutlined,
  LockOutlined,
  WindowsOutlined
} from '@ant-design/icons'
import { Badge, Card, Checkbox, Space, Tag, Tooltip, Typography } from 'antd'
import type { ComponentType, CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProtocolId, ProtocolMeta } from '../../shared/protocols'
import type { ProtocolScanResult } from '../../shared/scan'

const { Text } = Typography

const PROTOCOL_ICONS: Record<ProtocolId, ComponentType<{ style?: CSSProperties }>> = {
  ssh: CodeOutlined,
  vnc: DesktopOutlined,
  rdp: WindowsOutlined,
  telnet: ConsoleSqlOutlined,
  ftp: FolderOpenOutlined,
  smb: HddOutlined,
  http: GlobalOutlined,
  https: LockOutlined
}

interface ProtocolCardProps {
  meta: ProtocolMeta
  /** Real fingerprint outcome for this protocol from the last scan. */
  result: ProtocolScanResult
  selected: boolean
  onToggle: (id: ProtocolId) => void
}

export default function ProtocolCard({ meta, result, selected, onToggle }: ProtocolCardProps) {
  const { t } = useTranslation()
  const Icon = PROTOCOL_ICONS[meta.id]
  const open = result.status === 'open'
  const detected = result.detected
  // Only a positively identified AND implemented protocol may be checked.
  const selectable = detected && meta.mvpSupported

  const status = detected
    ? { badge: 'success' as const, text: t('scan.detected'), color: '#52c41a' }
    : open
      ? { badge: 'default' as const, text: t('scan.unidentified'), color: undefined }
      : { badge: 'default' as const, text: t('scan.closed'), color: undefined }

  const checkbox = (
    <Checkbox
      checked={selected}
      disabled={!selectable}
      onChange={() => onToggle(meta.id)}
      aria-label={meta.name}
    />
  )

  const card = (
    <Card
      size="small"
      className={`protocol-card${detected ? '' : ' protocol-card-dim'}`}
      data-protocol={meta.id}
    >
      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space size={8}>
            <Icon style={{ fontSize: 18, color: detected ? '#4c8dff' : '#595959' }} />
            <Text strong>{meta.name}</Text>
            <Text type="secondary" className="mono" style={{ fontSize: 12 }}>
              :{result.port}
            </Text>
          </Space>
          {detected && !meta.mvpSupported ? (
            <Tooltip title={t('scan.unsupportedTooltip')}>{checkbox}</Tooltip>
          ) : (
            checkbox
          )}
        </Space>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t(meta.descriptionKey)}
        </Text>
        {result.banner && (
          <Text
            type="secondary"
            className="mono"
            style={{ fontSize: 11 }}
            ellipsis={{ tooltip: result.banner }}
          >
            {result.banner}
          </Text>
        )}
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Badge
            status={status.badge}
            text={
              <Text
                type={status.color ? undefined : 'secondary'}
                style={{ fontSize: 12, color: status.color }}
              >
                {status.text}
              </Text>
            }
          />
          {meta.mvpSupported ? (
            <Tag color="green" style={{ marginInlineEnd: 0 }}>
              {t('scan.supported')}
            </Tag>
          ) : (
            <Tooltip title={t('scan.unsupportedTooltip')}>
              <Tag style={{ marginInlineEnd: 0 }}>{t('scan.unsupported')}</Tag>
            </Tooltip>
          )}
        </Space>
      </Space>
    </Card>
  )

  return card
}
