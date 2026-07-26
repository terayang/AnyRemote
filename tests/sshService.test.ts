import net, { type AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { utils } from 'ssh2'
import {
  closeAll,
  closeSession,
  createSession,
  openShell,
  resizeShell,
  writeToShell
} from '../src/main/ssh/sshService'
import { SshError, type SshAuthConfig } from '../src/shared/ssh'
import { startMockSshServer, type MockSshServer } from './helpers/mockSshServer'

let server: MockSshServer

beforeAll(async () => {
  server = await startMockSshServer()
})

afterAll(async () => {
  closeAll()
  await server.close()
})

function auth(overrides?: Partial<SshAuthConfig>): SshAuthConfig {
  return {
    host: '127.0.0.1',
    port: server.port,
    username: server.username,
    password: server.password,
    ...overrides
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Returns a loopback port that is guaranteed closed. */
async function closedPort(): Promise<number> {
  const tmp = net.createServer()
  await new Promise<void>((resolve) => tmp.listen(0, '127.0.0.1', () => resolve()))
  const port = (tmp.address() as AddressInfo).port
  await new Promise<void>((resolve) => tmp.close(() => resolve()))
  return port
}

describe('createSession', () => {
  it('connects with password auth and returns a session id', async () => {
    const sessionId = await createSession(auth())
    expect(typeof sessionId).toBe('string')
    expect(sessionId.length).toBeGreaterThan(0)
    closeSession(sessionId)
  })

  it('connects with private key auth', async () => {
    const keyPair = utils.generateKeyPairSync('ed25519')
    const sessionId = await createSession(
      auth({ password: undefined, privateKey: keyPair.private })
    )
    expect(typeof sessionId).toBe('string')
    closeSession(sessionId)
  })

  it('rejects a wrong password with a distinguishable AUTH_FAILED error', async () => {
    await expect(createSession(auth({ password: 'wrong' }))).rejects.toMatchObject({
      name: 'SshError',
      code: 'AUTH_FAILED'
    })
    await expect(createSession(auth({ password: 'wrong' }))).rejects.toBeInstanceOf(SshError)
  })

  it('maps connection refusal to UNREACHABLE', async () => {
    await expect(
      createSession(auth({ port: await closedPort() }))
    ).rejects.toMatchObject({ code: 'UNREACHABLE' })
  })

  it('maps a handshake timeout to TIMEOUT', async () => {
    // Accepts connections but never speaks SSH.
    const silentSockets = new Set<net.Socket>()
    const silent = net.createServer((socket) => {
      silentSockets.add(socket)
      socket.once('close', () => silentSockets.delete(socket))
    })
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', () => resolve()))
    try {
      const port = (silent.address() as AddressInfo).port
      await expect(
        createSession(auth({ port }), { readyTimeoutMs: 300 })
      ).rejects.toMatchObject({ code: 'TIMEOUT' })
    } finally {
      for (const socket of silentSockets) socket.destroy()
      await new Promise<void>((resolve) => silent.close(() => resolve()))
    }
  })
})

describe('shell', () => {
  it('echo roundtrip: written data arrives via onData', async () => {
    const sessionId = await createSession(auth())
    const received: string[] = []
    let closed = false
    await openShell(
      sessionId,
      { cols: 80, rows: 24 },
      { onData: (data) => received.push(data), onClose: () => { closed = true } }
    )
    writeToShell(sessionId, 'hello-anyremote')
    await waitFor(() => received.join('').includes('hello-anyremote'))
    expect(closed).toBe(false)
    closeSession(sessionId)
  })

  it('resizeShell does not throw and the server records the new size', async () => {
    const sessionId = await createSession(auth())
    await openShell(sessionId, { cols: 80, rows: 24 }, { onData: () => {}, onClose: () => {} })
    expect(() => resizeShell(sessionId, 120, 40)).not.toThrow()
    await waitFor(() =>
      server.windowChanges.some((w) => w.cols === 120 && w.rows === 40)
    )
    closeSession(sessionId)
  })

  it('onClose fires when the remote shell exits', async () => {
    const sessionId = await createSession(auth())
    let closed = false
    await openShell(
      sessionId,
      { cols: 80, rows: 24 },
      { onData: () => {}, onClose: () => { closed = true } }
    )
    writeToShell(sessionId, 'exit')
    await waitFor(() => closed)
    closeSession(sessionId)
  })

  it('writeToShell and resizeShell throw when no shell is open', async () => {
    const sessionId = await createSession(auth())
    expect(() => writeToShell(sessionId, 'x')).toThrow(SshError)
    expect(() => resizeShell(sessionId, 80, 24)).toThrow(SshError)
    closeSession(sessionId)
  })
})

describe('session lifecycle', () => {
  it('operations after closeSession throw SESSION_NOT_FOUND', async () => {
    const sessionId = await createSession(auth())
    closeSession(sessionId)
    expect(() => writeToShell(sessionId, 'x')).toThrow(SshError)
    expect(() => resizeShell(sessionId, 80, 24)).toThrow(SshError)
    await expect(
      openShell(sessionId, { cols: 80, rows: 24 }, { onData: () => {}, onClose: () => {} })
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
    // Closing twice fails loudly for a single id...
    expect(() => closeSession(sessionId)).toThrow(SshError)
  })

  it('closeAll is idempotent', async () => {
    const a = await createSession(auth())
    const b = await createSession(auth())
    expect(a).not.toBe(b)
    expect(() => closeAll()).not.toThrow()
    expect(() => closeAll()).not.toThrow()
  })
})
