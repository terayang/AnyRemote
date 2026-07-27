import { DisconnectOutlined, ReloadOutlined, WarningOutlined } from '@ant-design/icons'
import { Button, Segmented, Select, Space, Spin, Tooltip, Typography } from 'antd'
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
