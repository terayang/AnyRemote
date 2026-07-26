import {
  DeleteOutlined,
  DownloadOutlined,
  FileOutlined,
  FolderAddOutlined,
  FolderOutlined,
  UploadOutlined
} from '@ant-design/icons'
import { Button, Space, Table, Typography } from 'antd'
import { useTranslation } from 'react-i18next'

const { Text } = Typography

interface FileEntry {
  name: string
  dir: boolean
  size: string
  modified: string
}

/** Mock listings for the phase-1 UI prototype. */
const LOCAL_FILES: FileEntry[] = [
  { name: 'Documents', dir: true, size: '—', modified: '2026-07-20 11:24' },
  { name: 'Downloads', dir: true, size: '—', modified: '2026-07-25 09:10' },
  { name: 'notes.txt', dir: false, size: '4.2 KB', modified: '2026-07-24 22:31' },
  { name: 'backup-plan.md', dir: false, size: '1.8 KB', modified: '2026-07-21 15:02' },
  { name: 'AnyRemote-logo.png', dir: false, size: '86 KB', modified: '2026-07-18 10:47' }
]

const REMOTE_FILES: FileEntry[] = [
  { name: 'Projects', dir: true, size: '—', modified: '2026-07-26 08:12' },
  { name: 'Pictures', dir: true, size: '—', modified: '2026-07-19 20:03' },
  { name: 'deploy.sh', dir: false, size: '2.1 KB', modified: '2026-07-22 14:55' },
  { name: 'backup.tar.gz', dir: false, size: '1.2 GB', modified: '2026-07-25 02:40' },
  { name: 'server-config.yaml', dir: false, size: '6.4 KB', modified: '2026-07-23 17:26' }
]

function FileName({ entry }: { entry: FileEntry }) {
  return (
    <Space size={6}>
      {entry.dir ? <FolderOutlined style={{ color: '#e3b341' }} /> : <FileOutlined />}
      <span className="mono">{entry.name}</span>
    </Space>
  )
}

export default function FileManagerPanel() {
  const { t } = useTranslation()

  const columns = [
    {
      title: t('files.name'),
      dataIndex: 'name',
      key: 'name',
      render: (_: string, entry: FileEntry) => <FileName entry={entry} />
    },
    { title: t('files.size'), dataIndex: 'size', key: 'size', width: 110 },
    { title: t('files.modified'), dataIndex: 'modified', key: 'modified', width: 170 }
  ]

  return (
    <div className="files-panel">
      <Space style={{ marginBottom: 8 }}>
        <Button size="small" icon={<UploadOutlined />}>
          {t('files.upload')}
        </Button>
        <Button size="small" icon={<DownloadOutlined />}>
          {t('files.download')}
        </Button>
        <Button size="small" icon={<FolderAddOutlined />}>
          {t('files.newFolder')}
        </Button>
        <Button size="small" danger icon={<DeleteOutlined />}>
          {t('files.delete')}
        </Button>
      </Space>
      <div className="files-columns">
        <div className="files-column">
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('files.local')}
          </Text>
          <div className="local-file-list">
            {LOCAL_FILES.map((entry) => (
              <div key={entry.name} className="local-file-item">
                <FileName entry={entry} />
                <Text type="secondary" className="mono" style={{ fontSize: 12 }}>
                  {entry.size}
                </Text>
              </div>
            ))}
          </div>
        </div>
        <div className="files-column">
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('files.remote')}
          </Text>
          <Table<FileEntry>
            size="small"
            columns={columns}
            dataSource={REMOTE_FILES}
            rowKey="name"
            pagination={false}
          />
        </div>
      </div>
    </div>
  )
}
