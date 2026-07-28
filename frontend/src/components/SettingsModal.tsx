import { App as AntdApp, Modal, Radio, Spin, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ipcErrorMessage } from '../../shared/ipc'

const { Text } = Typography

interface SettingsModalProps {
  open: boolean
  onClose: () => void
}

/**
 * Application settings. Currently one section: the credential storage backend
 * (system keychain vs encrypted local file). Switching migrates every stored
 * credential on the Go side (SetSecretStorage in bindings.go); while the
 * migration runs the radio group is disabled behind a Spin. The local-file
 * description deliberately states its real security level (obfuscation grade,
 * see internal/store/secrets_file.go) — do not soften the wording.
 */
export default function SettingsModal({ open, onClose }: SettingsModalProps) {
  const { t } = useTranslation()
  const { message } = AntdApp.useApp()
  const [mode, setMode] = useState<string>('keychain')
  const [loading, setLoading] = useState(false)
  const [migrating, setMigrating] = useState(false)

  // Read the active backend every time the modal opens.
  useEffect(() => {
    if (!open) return
    setLoading(true)
    window.anyremote.settings
      .getSecretStorage()
      .then(setMode)
      .catch(() => undefined) // keep the keychain default when the read fails
      .finally(() => setLoading(false))
  }, [open])

  const handleChange = async (next: string): Promise<void> => {
    const previous = mode
    setMode(next)
    setMigrating(true)
    try {
      await window.anyremote.settings.setSecretStorage(next)
      message.success(t('settings.secretStorage.migrated'))
    } catch (err) {
      // The backend kept the previous mode; revert the selection and show
      // the failure verbatim (the [CODE] prefix is stripped).
      setMode(previous)
      message.error(ipcErrorMessage(err))
    } finally {
      setMigrating(false)
    }
  }

  return (
    <Modal
      title={t('settings.title')}
      open={open}
      width={440}
      footer={null}
      onCancel={onClose}
      destroyOnHidden
    >
      <Spin spinning={loading || migrating} tip={migrating ? t('settings.secretStorage.migrating') : undefined}>
        <div style={{ marginBottom: 8 }}>{t('settings.secretStorage.label')}</div>
        <Radio.Group
          value={mode}
          disabled={loading || migrating}
          onChange={(e) => void handleChange(e.target.value as string)}
          style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
        >
          <Radio value="keychain">
            {t('settings.secretStorage.keychain')}
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('settings.secretStorage.keychainHint')}
              </Text>
            </div>
          </Radio>
          <Radio value="localFile">
            {t('settings.secretStorage.localFile')}
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('settings.secretStorage.localFileHint')}
              </Text>
            </div>
          </Radio>
        </Radio.Group>
      </Spin>
    </Modal>
  )
}
