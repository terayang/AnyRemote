import { Collapse, Form, Input, Modal, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import type { SessionCredentials } from '../store/session'

const { Text } = Typography

interface CredentialsFormValues {
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
}

interface CredentialsModalProps {
  open: boolean
  /** Target host shown for context (mono, read-only). */
  target: string
  onCancel: () => void
  onSubmit: (credentials: SessionCredentials) => void
}

/**
 * Pre-connect credential collection. The username/password input and submit
 * button ids (`cred-username` / `cred-password` / `connect-submit`) are a
 * cross-agent contract relied on by smoke tests — do not rename.
 */
export default function CredentialsModal({
  open,
  target,
  onCancel,
  onSubmit
}: CredentialsModalProps) {
  const { t } = useTranslation()
  const [form] = Form.useForm<CredentialsFormValues>()

  const handleOk = async (): Promise<void> => {
    const values = await form.validateFields()
    onSubmit({
      username: values.username.trim(),
      password: values.password || undefined,
      privateKey: values.privateKey?.trim() || undefined,
      passphrase: values.passphrase || undefined
    })
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
      </Form>
    </Modal>
  )
}
