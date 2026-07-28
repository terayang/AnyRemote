import { Checkbox, Collapse, Form, Input, Modal, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSavedConnectionsStore } from '../store/savedConnections'
import type { SessionCredentials } from '../store/session'

const { Text } = Typography

interface CredentialsFormValues {
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
}

/** Save intent collected alongside the credentials (F5). */
export interface SaveConnectionRequest {
  name: string
  /**
   * Set when an entry with the same host + username already exists (B7
   * dedup): the caller passes it as SavedConnectionInput.id so the save takes
   * the update branch instead of creating a duplicate.
   */
  existingId?: string
}

interface CredentialsModalProps {
  open: boolean
  /** Target host shown for context (mono, read-only). */
  target: string
  onCancel: () => void
  /**
   * saveRequest is present when the user checked "save this connection";
   * persisting is the caller's job and must not block connecting.
   */
  onSubmit: (credentials: SessionCredentials, saveRequest?: SaveConnectionRequest) => void
}

/**
 * Pre-connect credential collection. The username/password input and submit
 * button ids (`cred-username` / `cred-password` / `connect-submit`) are a
 * cross-agent contract relied on by smoke tests — do not rename. The save
 * checkbox/input ids (`cred-save-connection` / `cred-save-name`) are too.
 */
export default function CredentialsModal({
  open,
  target,
  onCancel,
  onSubmit
}: CredentialsModalProps) {
  const { t } = useTranslation()
  const [form] = Form.useForm<CredentialsFormValues>()
  const [saveChecked, setSaveChecked] = useState(false)
  const [saveName, setSaveName] = useState(target)

  // Reset the save controls every time the modal opens for a (new) target.
  useEffect(() => {
    if (open) {
      setSaveChecked(false)
      setSaveName(target)
    }
  }, [open, target])

  // B7 dedup: an entry with the same host + username would be updated, not
  // duplicated — the checkbox label says so and its id rides along on submit.
  const usernameValue = Form.useWatch('username', form)
  const savedConnections = useSavedConnectionsStore((s) => s.connections)
  const normalizedTarget = target.trim().toLowerCase()
  const existing = savedConnections.find(
    (c) =>
      c.host.trim().toLowerCase() === normalizedTarget &&
      c.username === (usernameValue ?? '').trim()
  )

  const handleOk = async (): Promise<void> => {
    const values = await form.validateFields()
    onSubmit(
      {
        username: values.username.trim(),
        password: values.password || undefined,
        privateKey: values.privateKey?.trim() || undefined,
        passphrase: values.passphrase || undefined
      },
      saveChecked ? { name: saveName.trim() || target, existingId: existing?.id } : undefined
    )
  }

  return (
    <Modal
      title={t('credentials.title')}
      open={open}
      width={420}
      okText={t('credentials.submit')}
      cancelText={t('credentials.cancel')}
      okButtonProps={{ id: 'connect-submit' }}
      onOk={() => {
        void handleOk()
      }}
      onCancel={onCancel}
      destroyOnHidden
    >
      <Text type="secondary" className="mono" style={{ fontSize: 12 }}>
        {target}
      </Text>
      <Form form={form} layout="vertical" preserve={false} style={{ marginTop: 12 }}>
        <Form.Item
          name="username"
          label={t('credentials.username')}
          rules={[
            { required: true, whitespace: true, message: t('credentials.usernameRequired') }
          ]}
        >
          <Input id="cred-username" autoFocus autoComplete="username" />
        </Form.Item>
        <Form.Item name="password" label={t('credentials.password')}>
          <Input.Password id="cred-password" autoComplete="current-password" />
        </Form.Item>
        <Collapse
          ghost
          items={[
            {
              key: 'advanced',
              label: t('credentials.advanced'),
              children: (
                <>
                  <Form.Item name="privateKey" label={t('credentials.privateKey')}>
                    <Input className="mono" placeholder={t('credentials.privateKeyPlaceholder')} />
                  </Form.Item>
                  <Form.Item name="passphrase" label={t('credentials.passphrase')}>
                    <Input.Password placeholder={t('credentials.passphrasePlaceholder')} />
                  </Form.Item>
                </>
              )
            }
          ]}
        />
        <Form.Item style={{ marginBottom: 0, marginTop: 8 }}>
          <Checkbox
            id="cred-save-connection"
            checked={saveChecked}
            onChange={(e) => setSaveChecked(e.target.checked)}
          >
            {t(existing ? 'credentials.updateThis' : 'credentials.saveThis')}
          </Checkbox>
          <Input
            id="cred-save-name"
            style={{ marginTop: 8 }}
            size="small"
            disabled={!saveChecked}
            placeholder={t('credentials.saveNamePlaceholder')}
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
          />
        </Form.Item>
      </Form>
    </Modal>
  )
}
