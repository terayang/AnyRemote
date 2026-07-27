import { DisconnectOutlined, ReloadOutlined, SettingOutlined, WarningOutlined } from '@ant-design/icons'
import { Button, Popover, Segmented, Select, Space, Spin, Tooltip, Typography } from 'antd'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useSessionStore } from '../store/session'
import {
  attachVnc,
  detachVnc,
  retryVnc,
  useVncStore,
  userDisconnectVnc,
  type VncErrorKind
} from '../store/vnc'
import './vnc.css'

const { Text } = Typography

const VNC_PORT = 5900

export default function DesktopPanel() {
  const { t } = useTranslation()
  const context = useSessionStore((s) => s.context)
  const status = useVncStore((s) => s.status)
  const errorKind = useVncStore((s) => s.errorKind)
  const desktopName = useVncStore((s) => s.desktopName)
  const scaleMode = useVncStore((s) => s.scaleMode)
  const setScaleMode = useVncStore((s) => s.setScaleMode)
  const cursorMode = useVncStore((s) => s.cursorMode)
  const setCursorMode = useVncStore((s) => s.setCursorMode)
  const encMode = useVncStore((s) => s.encMode)
  const quality = useVncStore((s) => s.quality)
  const compression = useVncStore((s) => s.compression)
  const setEncMode = useVncStore((s) => s.setEncMode)
  const setQuality = useVncStore((s) => s.setQuality)
  const setCompression = useVncStore((s) => s.setCompression)
  const containerRef = useRef<HTMLDivElement>(null)

  // The mount lifecycle owns the connection: exactly one attach per mount,
  // detach on unmount. attachVnc() tears down any previous live session, so
  // StrictMode double-mounts and tab close/reopen cannot stack connections.
  useEffect(() => {
    const container = containerRef.current
    if (context === null || container === null) return
    void attachVnc(container, {
      host: context.target,
      port: VNC_PORT,
      username: context.credentials.username,
      password: context.credentials.password
    })
    return () => {
      detachVnc()
    }
  }, [context])

  const errorMessages: Record<VncErrorKind, string> = {
    auth: t('vnc.errorAuth', { defaultValue: '认证失败，请检查 macOS 用户名或密码' }),
    connection: t('vnc.errorUnreachable', { defaultValue: '无法连接到目标 VNC' }),
    protocol: t('vnc.errorProtocol', { defaultValue: 'VNC 协议错误' }),
    timeout: t('vnc.errorTimeout', { defaultValue: '连接超时' }),
    unknown: t('vnc.errorUnknown', { defaultValue: '连接已断开' })
  }

  const displaySettings = (
    <Space direction="vertical" size={10} style={{ width: 240 }}>
      <div>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('desktop.encMode')}
        </Text>
        <Select
          size="small"
          style={{ width: '100%' }}
          value={encMode}
          onChange={setEncMode}
          options={[
            { value: 'auto', label: t('desktop.encAuto') },
            { value: 'zrle', label: 'ZRLE' },
            { value: 'hextile', label: 'Hextile' },
            { value: 'raw', label: 'Raw' }
          ]}
        />
        <div>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {t('desktop.encHint')}
          </Text>
        </div>
      </div>
      <div>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('desktop.quality')}
        </Text>
        <Select
          size="small"
          style={{ width: '100%' }}
          value={quality}
          onChange={setQuality}
          options={[
            { value: 8, label: t('desktop.qualityHigh') },
            { value: 6, label: t('desktop.qualityMid') },
            { value: 3, label: t('desktop.qualityLow') }
          ]}
        />
        <div>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {t('desktop.qualityHint')}
          </Text>
        </div>
      </div>
      <div>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('desktop.compression')}
        </Text>
        <Select
          size="small"
          style={{ width: '100%' }}
          value={compression}
          onChange={setCompression}
          options={[
            { value: 6, label: t('desktop.compSaver') },
            { value: 2, label: t('desktop.compBalanced') },
            { value: 0, label: t('desktop.compLowCpu') }
          ]}
        />
      </div>
    </Space>
  )

  return (
    <div className="desktop-panel">
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 8 }}>
        <Space size={12}>
          <Select
            size="small"
            value={scaleMode}
            style={{ width: 140 }}
            onChange={setScaleMode}
            options={[
              { value: 'fit', label: t('desktop.zoomFit') },
              { value: 'actual', label: t('desktop.zoomActual') }
            ]}
          />
          <Tooltip title={t('desktop.cursorModeHint')} placement="bottom">
            <Segmented
              size="small"
              value={cursorMode}
              onChange={(value) => setCursorMode(value as 'remote' | 'local')}
              options={[
                { value: 'remote', label: t('desktop.cursorRemote') },
                { value: 'local', label: t('desktop.cursorLocal') }
              ]}
            />
          </Tooltip>
          <Popover
            content={displaySettings}
            title={t('desktop.settings')}
            trigger="click"
            placement="bottomLeft"
          >
            <Button size="small" icon={<SettingOutlined />} />
          </Popover>
          {desktopName !== '' && (
            <Text className="mono" type="secondary" style={{ fontSize: 12 }}>
              {desktopName}
            </Text>
          )}
        </Space>
        <Button size="small" danger icon={<DisconnectOutlined />} onClick={userDisconnectVnc}>
          {t('desktop.disconnect')}
        </Button>
      </Space>
      <div className="desktop-viewport vnc-viewport">
        <div
          ref={containerRef}
          className={cursorMode === 'local' ? 'vnc-container local-cursor' : 'vnc-container'}
        />
        {context === null && (
          <div className="vnc-overlay">
            <Text type="secondary">
              {t('vnc.noContext', { defaultValue: '没有可用的会话信息，请重新连接' })}
            </Text>
          </div>
        )}
        {context !== null && status === 'connecting' && (
          <div className="vnc-overlay" data-testid="vnc-connecting">
            <Spin />
            <Text type="secondary">
              {t('vnc.connecting', { defaultValue: '正在连接远程桌面…' })}
            </Text>
          </div>
        )}
        {context !== null && status === 'idle' && (
          <div className="vnc-overlay">
            <Text type="secondary">{t('vnc.disconnected', { defaultValue: '已断开连接' })}</Text>
            <Button icon={<ReloadOutlined />} onClick={() => void retryVnc()}>
              {t('vnc.reconnect', { defaultValue: '重新连接' })}
            </Button>
          </div>
        )}
        {context !== null && status === 'error' && errorKind !== null && (
          <div className="vnc-overlay" data-testid="vnc-error" data-error-kind={errorKind}>
            <WarningOutlined style={{ fontSize: 28, color: '#ff4d4f' }} />
            <Text>{errorMessages[errorKind]}</Text>
            <Button type="primary" icon={<ReloadOutlined />} onClick={() => void retryVnc()}>
              {t('vnc.retry', { defaultValue: '重试' })}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
