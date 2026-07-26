import { ConfigProvider, Input, Space, Tag, theme, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import { useAppStore } from './store'

const { Title, Text } = Typography

export default function App() {
  const { t } = useTranslation()
  const targetAddress = useAppStore((s) => s.targetAddress)
  const setTargetAddress = useAppStore((s) => s.setTargetAddress)
  const versions = window.anyremote?.versions

  return (
    <ConfigProvider
      theme={{
        algorithm: [theme.darkAlgorithm, theme.compactAlgorithm]
      }}
    >
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#141414'
        }}
      >
        <Space direction="vertical" align="center" size="middle">
          <Title level={1} style={{ margin: 0 }}>
            {t('app.title')}
          </Title>
          <Text type="secondary">{t('app.tagline')}</Text>
          <Input
            style={{ width: 320 }}
            placeholder={t('app.targetPlaceholder')}
            value={targetAddress}
            onChange={(e) => setTargetAddress(e.target.value)}
          />
          {versions && (
            <Space size="small" wrap>
              <Tag>Electron {versions.electron}</Tag>
              <Tag>Node {versions.node}</Tag>
              <Tag>Chromium {versions.chrome}</Tag>
            </Space>
          )}
        </Space>
      </div>
    </ConfigProvider>
  )
}
