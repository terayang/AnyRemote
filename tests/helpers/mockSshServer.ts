/**
 * In-process mock SSH server for sshService/sftpService tests, built on
 * ssh2's server mode. No real credentials or keys: the host key is a fresh
 * throwaway ed25519 pair generated per server instance via ssh2's keygen
 * utils, and the only accepted login is test/secret (publickey is accepted
 * for the same test user regardless of key).
 *
 * - Shell: echoes any received data back, records window-change sizes, and
 *   exits the channel when it receives "exit".
 * - SFTP: backed by a real temporary directory (per instance), implementing
 *   the requests ssh2's client issues: OPEN/READ/WRITE/CLOSE/FSTAT (fastGet/
 *   fastPut), OPENDIR/READDIR (readdir reads until EOF), STAT/LSTAT, MKDIR,
 *   RENAME, REMOVE, RMDIR and REALPATH (homeDir).
 *
 * Remote paths are POSIX-style and sandboxed under the instance's rootDir.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  Server,
  utils,
  type Attributes,
  type Connection,
  type FileEntry as Ssh2FileEntry,
  type SFTPWrapper
} from 'ssh2'
import type { AddressInfo } from 'node:net'

export interface MockSshServer {
  port: number
  /** Absolute path of the temp dir backing the SFTP filesystem. */
  rootDir: string
  username: string
  password: string
  /** Every window-change request received, in order. */
  windowChanges: Array<{ cols: number; rows: number }>
  /** Stops the server, disconnects clients and removes the temp dir. */
  close: () => Promise<void>
}

const USERNAME = 'test'
const PASSWORD = 'secret'
const STATUS = utils.sftp.STATUS_CODE

/** Maps a sandboxed remote path onto the instance's local temp dir. */
function toLocal(rootDir: string, remotePath: string): string {
  const normalized = path.posix
    .normalize(remotePath.replace(/\\/g, '/'))
    .replace(/^(\.\.(\/|$))+/, '')
  return path.join(rootDir, normalized)
}

/** fs.Stats -> wire Attributes (times as Unix seconds). */
function toAttrs(stats: fs.Stats): Attributes {
  return {
    mode: stats.mode,
    uid: stats.uid,
    gid: stats.gid,
    size: stats.size,
    atime: Math.floor(stats.atimeMs / 1000),
    mtime: Math.floor(stats.mtimeMs / 1000)
  }
}

function zeroAttrs(): Attributes {
  return { mode: 0, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 }
}

function errnoToStatus(err: NodeJS.ErrnoException): number {
  return err.code === 'ENOENT' ? STATUS.NO_SUCH_FILE : STATUS.FAILURE
}

/** Wires the SFTP subsystem of one accepted session to the real temp dir. */
function serveSftp(sftp: SFTPWrapper, rootDir: string, rootAttrs: Attributes): void {
  let nextHandle = 0
  const openFiles = new Map<string, number>()
  const openDirs = new Map<string, { localPath: string; names: Ssh2FileEntry[]; sent: boolean }>()

  const takeHandle = (): string => `h${nextHandle++}`

  sftp.on('OPEN', (reqId, filename, flags, attrs) => {
    const localPath = toLocal(rootDir, filename)
    const fsFlags = utils.sftp.flagsToString(flags) ?? 'r'
    const mode = typeof attrs?.mode === 'number' ? attrs.mode : 0o666
    fs.open(localPath, fsFlags, mode, (err, fd) => {
      if (err) {
        sftp.status(reqId, errnoToStatus(err), err.message)
        return
      }
      const id = takeHandle()
      openFiles.set(id, fd)
      sftp.handle(reqId, Buffer.from(id))
    })
  })

  sftp.on('READ', (reqId, handle, offset, len) => {
    const fd = openFiles.get(handle.toString())
    if (fd === undefined) {
      sftp.status(reqId, STATUS.FAILURE, 'Invalid file handle')
      return
    }
    const buf = Buffer.alloc(len)
    fs.read(fd, buf, 0, len, offset, (err, bytesRead) => {
      if (err) {
        sftp.status(reqId, STATUS.FAILURE, err.message)
      } else if (bytesRead === 0) {
        sftp.status(reqId, STATUS.EOF)
      } else {
        sftp.data(reqId, buf.subarray(0, bytesRead))
      }
    })
  })

  sftp.on('WRITE', (reqId, handle, offset, data) => {
    const fd = openFiles.get(handle.toString())
    if (fd === undefined) {
      sftp.status(reqId, STATUS.FAILURE, 'Invalid file handle')
      return
    }
    fs.write(fd, data, 0, data.length, offset, (err) => {
      if (err) {
        sftp.status(reqId, STATUS.FAILURE, err.message)
      } else {
        sftp.status(reqId, STATUS.OK)
      }
    })
  })

  sftp.on('CLOSE', (reqId, handle) => {
    const id = handle.toString()
    const fd = openFiles.get(id)
    openFiles.delete(id)
    openDirs.delete(id)
    if (fd === undefined) {
      sftp.status(reqId, STATUS.OK)
      return
    }
    fs.close(fd, () => sftp.status(reqId, STATUS.OK))
  })

  sftp.on('FSTAT', (reqId, handle) => {
    const fd = openFiles.get(handle.toString())
    if (fd === undefined) {
      sftp.status(reqId, STATUS.FAILURE, 'Invalid file handle')
      return
    }
    fs.fstat(fd, (err, stats) => {
      if (err) {
        sftp.status(reqId, STATUS.FAILURE, err.message)
      } else {
        sftp.attrs(reqId, toAttrs(stats))
      }
    })
  })

  const replyStat = (reqId: number, err: NodeJS.ErrnoException | null, stats?: fs.Stats) => {
    if (err || !stats) {
      sftp.status(reqId, errnoToStatus(err ?? new Error('stat failed')), err?.message)
    } else {
      sftp.attrs(reqId, toAttrs(stats))
    }
  }
  sftp.on('STAT', (reqId, remotePath) => {
    fs.stat(toLocal(rootDir, remotePath), (err, stats) => replyStat(reqId, err, stats))
  })
  sftp.on('LSTAT', (reqId, remotePath) => {
    fs.lstat(toLocal(rootDir, remotePath), (err, stats) => replyStat(reqId, err, stats))
  })

  sftp.on('OPENDIR', (reqId, remotePath) => {
    const localPath = toLocal(rootDir, remotePath)
    fs.readdir(localPath, { withFileTypes: true }, (err, dirents) => {
      if (err) {
        sftp.status(reqId, errnoToStatus(err), err.message)
        return
      }
      const names = dirents.map((dirent) => {
        let attrs: Attributes
        try {
          attrs = toAttrs(fs.lstatSync(path.join(localPath, dirent.name)))
        } catch {
          attrs = zeroAttrs() // e.g. broken symlink; attributes are best-effort
        }
        return { filename: dirent.name, longname: dirent.name, attrs }
      })
      const id = takeHandle()
      openDirs.set(id, { localPath, names, sent: false })
      sftp.handle(reqId, Buffer.from(id))
    })
  })

  // The client issues READDIR repeatedly until it gets an EOF status.
  sftp.on('READDIR', (reqId, handle) => {
    const dir = openDirs.get(handle.toString())
    if (!dir) {
      sftp.status(reqId, STATUS.FAILURE, 'Invalid directory handle')
      return
    }
    if (dir.sent || dir.names.length === 0) {
      dir.sent = true
      sftp.status(reqId, STATUS.EOF)
      return
    }
    dir.sent = true
    sftp.name(reqId, dir.names)
  })

  sftp.on('MKDIR', (reqId, remotePath) => {
    fs.mkdir(toLocal(rootDir, remotePath), (err) => {
      if (err) {
        sftp.status(reqId, errnoToStatus(err), err.message)
      } else {
        sftp.status(reqId, STATUS.OK)
      }
    })
  })

  sftp.on('RENAME', (reqId, oldPath, newPath) => {
    fs.rename(toLocal(rootDir, oldPath), toLocal(rootDir, newPath), (err) => {
      if (err) {
        sftp.status(reqId, errnoToStatus(err), err.message)
      } else {
        sftp.status(reqId, STATUS.OK)
      }
    })
  })

  sftp.on('REMOVE', (reqId, remotePath) => {
    fs.unlink(toLocal(rootDir, remotePath), (err) => {
      if (err) {
        sftp.status(reqId, errnoToStatus(err), err.message)
      } else {
        sftp.status(reqId, STATUS.OK)
      }
    })
  })

  sftp.on('RMDIR', (reqId, remotePath) => {
    fs.rmdir(toLocal(rootDir, remotePath), (err) => {
      if (err) {
        sftp.status(reqId, errnoToStatus(err), err.message)
      } else {
        sftp.status(reqId, STATUS.OK)
      }
    })
  })

  // Home resolution: any relative path lands on the sandbox root ('/').
  sftp.on('REALPATH', (reqId, remotePath) => {
    const resolved = path.posix.normalize(
      remotePath.startsWith('/') ? remotePath : `/${remotePath}`
    )
    sftp.name(reqId, [{ filename: resolved, longname: resolved, attrs: rootAttrs }])
  })
}

/** Starts a mock SSH server on an ephemeral loopback port. */
export function startMockSshServer(): Promise<MockSshServer> {
  return new Promise((resolve, reject) => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anyremote-mock-ssh-'))
    const rootAttrs = toAttrs(fs.statSync(rootDir))
    // Throwaway test-only host key, generated per instance (never persisted).
    const hostKey = utils.generateKeyPairSync('ed25519')
    const windowChanges: Array<{ cols: number; rows: number }> = []
    const connections = new Set<Connection>()

    const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
      connections.add(client)
      client.on('close', () => connections.delete(client))
      client.on('error', () => {}) // clients may vanish mid-teardown

      client.on('authentication', (ctx) => {
        if (ctx.method === 'password') {
          if (ctx.username === USERNAME && ctx.password === PASSWORD) {
            ctx.accept()
          } else {
            ctx.reject(['password', 'publickey'])
          }
        } else if (ctx.method === 'publickey') {
          // Any key is fine for the test user; password is the guarded path.
          if (ctx.username === USERNAME) {
            ctx.accept()
          } else {
            ctx.reject(['password'])
          }
        } else {
          ctx.reject(['password', 'publickey'])
        }
      })

      client.on('session', (accept) => {
        const session = accept()

        session.on('pty', (acceptPty) => {
          // wantReply=false requests carry no accept function.
          if (acceptPty) acceptPty()
        })
        session.on('window-change', (acceptChange, _reject, info) => {
          windowChanges.push({ cols: info.cols, rows: info.rows })
          if (acceptChange) acceptChange()
        })

        session.on('shell', (acceptShell) => {
          const channel = acceptShell()
          channel.on('data', (chunk: Buffer) => {
            if (chunk.toString('utf8').trim() === 'exit') {
              channel.exit(0)
              channel.end()
              return
            }
            channel.write(chunk) // echo
          })
        })

        session.on('sftp', (acceptSftp) => {
          serveSftp(acceptSftp(), rootDir, rootAttrs)
        })
      })
    })

    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        rootDir,
        username: USERNAME,
        password: PASSWORD,
        windowChanges,
        close: async () => {
          for (const conn of connections) {
            try {
              conn.end()
              // Hammer for half-open sockets (e.g. failed-auth clients):
              // ssh2 Server exposes no socket tracking, so go through the
              // connection's internal socket to guarantee close() returns.
              ;(conn as unknown as { _sock?: { destroy: () => void } })._sock?.destroy()
            } catch {
              // already gone
            }
          }
          await new Promise<void>((closeResolve) => {
            server.close(() => closeResolve())
          })
          await fs.promises.rm(rootDir, { recursive: true, force: true })
        }
      })
    })
  })
}
