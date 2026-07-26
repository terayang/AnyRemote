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
  /** Whether the (mock) scan found this protocol's port open. */
  open: boolean
  selected: boolean
  onToggle: (id: ProtocolId) => void
}

export default function ProtocolCard({ meta, open, selected, onToggle }: ProtocolCardProps) {
  const { t } = useTranslation()
  const Icon = PROTOCOL_ICONS[meta.id]
  const selectable = open && meta.mvpSupported

  const card = (
    <Card
      size="small"
      className={`protocol-card${open ? '' : ' protocol-card-dim'}`}
      data-protocol={meta.id}
    >
      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space size={8}>
            <Icon style={{ fontSize: 18, color: open ? '#4c8dff' : '#595959' }} />
            <Text strong>{meta.name}</Text>
            <Text type="secondary" className="mono" style={{ fontSize: 12 }}>
              :{meta.defaultPort}
            </Text>
          </Space>
          <Checkbox
            checked={selected}
            disabled={!selectable}
            onChange={() => onToggle(meta.id)}
            aria-label={meta.name}
          />
        </Space>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t(meta.descriptionKey)}
        </Text>
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Badge
            status={open ? 'success' : 'default'}
            text={
              <Text type="secondary" style={{ fontSize: 12 }}>
                {open ? t('scan.detected') : t('scan.closed')}
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
