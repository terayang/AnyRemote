import { DisconnectOutlined } from '@ant-design/icons'
import { Button, Select, Space } from 'antd'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../store'

export default function DesktopPanel() {
  const { t } = useTranslation()
  const disconnect = useAppStore((s) => s.disconnect)
  const [zoom, setZoom] = useState<'fit' | 'actual'>('fit')

  return (
    <div className="desktop-panel">
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 8 }}>
        <Select
          size="small"
          value={zoom}
          style={{ width: 140 }}
          onChange={(v) => setZoom(v)}
          options={[
            { value: 'fit', label: t('desktop.zoomFit') },
            { value: 'actual', label: t('desktop.zoomActual') }
          ]}
        />
        <Button size="small" danger icon={<DisconnectOutlined />} onClick={disconnect}>
          {t('desktop.disconnect')}
        </Button>
      </Space>
      <div className="desktop-viewport">
        <span className="mono" style={{ color: '#595959', fontSize: 14 }}>
          {t('desktop.placeholder', { resolution: '1920x1080' })}
        </span>
      </div>
    </div>
  )
}
