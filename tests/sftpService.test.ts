import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeAll, closeSession, createSession } from '../src/main/ssh/sshService'
import {
  deleteDir,
  deleteFile,
  download,
  homeDir,
  list,
  mkdir,
  rename,
  upload
} from '../src/main/ssh/sftpService'
import type { TransferProgress } from '../src/shared/ssh'
import { startMockSshServer, type MockSshServer } from './helpers/mockSshServer'

let server: MockSshServer
let sessionId: string
let localDir: string

beforeAll(async () => {
  server = await startMockSshServer()
  sessionId = await createSession({
    host: '127.0.0.1',
    port: server.port,
    username: server.username,
    password: server.password
  })
  localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anyremote-sftp-local-'))
})

afterAll(async () => {
  closeAll()
  await server.close()
  await fs.promises.rm(localDir, { recursive: true, force: true })
})

describe('directory operations', () => {
  it('homeDir resolves to the sandbox root', async () => {
    await expect(homeDir(sessionId)).resolves.toBe('/')
  })

  it('mkdir then list shows the new directory entry', async () => {
    await mkdir(sessionId, '/dir1')
    const entries = await list(sessionId, '/')
    expect(entries.find((e) => e.name === 'dir1')).toMatchObject({ type: 'directory' })
    const dir1 = entries.find((e) => e.name === 'dir1')
    expect(dir1?.mtimeMs).toBeGreaterThan(0)
    expect(dir1?.mode).toBeGreaterThan(0)
  })

  it('list rejects with REMOTE_ERROR for a missing directory', async () => {
    await expect(list(sessionId, '/no-such-dir')).rejects.toMatchObject({
      code: 'REMOTE_ERROR'
    })
  })
})

describe('file transfer and management', () => {
  const FILE_SIZE = 100_000
  let localUp: string

  beforeAll(async () => {
    localUp = path.join(localDir, 'big.bin')
    fs.writeFileSync(localUp, randomBytes(FILE_SIZE))
    await mkdir(sessionId, '/xfer')
  })

  it('uploads a file with increasing progress and exact content', async () => {
    const progress: TransferProgress[] = []
    await upload(sessionId, localUp, '/xfer/big.bin', (p) => progress.push(p))

    // 100 KB in 32 KB chunks -> more than one progress event, strictly increasing.
    expect(progress.length).toBeGreaterThan(1)
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i].transferred).toBeGreaterThan(progress[i - 1].transferred)
      expect(progress[i].total).toBe(FILE_SIZE)
    }
    const last = progress[progress.length - 1]
    expect(last.transferred).toBe(FILE_SIZE)
    expect(last.percent).toBe(100)

    // Byte-for-byte content check against the mock's backing filesystem.
    const remoteCopy = fs.readFileSync(path.join(server.rootDir, 'xfer', 'big.bin'))
    expect(remoteCopy.equals(fs.readFileSync(localUp))).toBe(true)

    expect(await list(sessionId, '/xfer')).toContainEqual(
      expect.objectContaining({ name: 'big.bin', type: 'file', size: FILE_SIZE })
    )
  })

  it('downloads the file back with progress and identical content', async () => {
    const localDown = path.join(localDir, 'big-downloaded.bin')
    const progress: TransferProgress[] = []
    await download(sessionId, '/xfer/big.bin', localDown, (p) => progress.push(p))

    expect(progress.length).toBeGreaterThan(1)
    expect(progress[progress.length - 1].transferred).toBe(FILE_SIZE)
    expect(progress[progress.length - 1].percent).toBe(100)
    expect(fs.readFileSync(localDown).equals(fs.readFileSync(localUp))).toBe(true)
  })

  it('renames a remote file', async () => {
    await rename(sessionId, '/xfer/big.bin', '/xfer/renamed.bin')
    const names = (await list(sessionId, '/xfer')).map((e) => e.name)
    expect(names).toContain('renamed.bin')
    expect(names).not.toContain('big.bin')
  })

  it('deletes a remote file', async () => {
    await deleteFile(sessionId, '/xfer/renamed.bin')
    const names = (await list(sessionId, '/xfer')).map((e) => e.name)
    expect(names).not.toContain('renamed.bin')
  })

  it('upload rejects with REMOTE_ERROR for a missing local file', async () => {
    await expect(
      upload(sessionId, path.join(localDir, 'missing.bin'), '/xfer/x.bin')
    ).rejects.toMatchObject({ code: 'REMOTE_ERROR' })
  })
})

describe('deleteDir', () => {
  it('refuses a non-empty directory and removes an empty one (non-recursive)', async () => {
    const small = path.join(localDir, 'small.txt')
    fs.writeFileSync(small, 'data')
    await mkdir(sessionId, '/nonempty')
    await upload(sessionId, small, '/nonempty/small.txt')
    await expect(deleteDir(sessionId, '/nonempty')).rejects.toMatchObject({
      code: 'REMOTE_ERROR'
    })

    await mkdir(sessionId, '/empty')
    await deleteDir(sessionId, '/empty')
    const names = (await list(sessionId, '/')).map((e) => e.name)
    expect(names).not.toContain('empty')
    expect(names).toContain('nonempty')
  })
})

describe('session lifecycle', () => {
  it('rejects operations after the session is closed', async () => {
    const id = await createSession({
      host: '127.0.0.1',
      port: server.port,
      username: server.username,
      password: server.password
    })
    closeSession(id)
    await expect(list(id, '/')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
    await expect(homeDir(id)).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
  })

  it('rejects operations for an unknown session id', async () => {
    await expect(list('no-such-session', '/')).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND'
    })
  })
})
