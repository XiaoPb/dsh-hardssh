/**
 * Replayable SFTP reads.
 *
 * A stalled transport is retired by `withClient` itself (`lease.markBroken` on
 * any non-abort failure) and `withSftpTimeout` retires the shared channel — so a
 * hung READ only needed permission to run again on the fresh connection. Without
 * it the harness's path resolution saw the timeout and killed the whole agent
 * turn:
 *
 *   cannot resolve "/yutiancheng/2026/regvelo/.git":
 *     remote realpath timed out after 15000ms
 *
 * The host was not slow: the same non-existent path answers in ~5ms through the
 * shell (measured), so the budget was burned by a stalled channel — the
 * transient failure one replay fixes.
 *
 * These cases pin BOTH halves of the fix: reads ask for a replayable access, and
 * writes keep the single-attempt default (a replayed write may duplicate work
 * the server already observed).
 */
import { EventEmitter } from 'node:events'
import type { Client, SFTPWrapper } from 'ssh2'
import { describe, expect, it } from 'vitest'
import type { SftpClientAccess, SftpClientOptions, SftpOptions } from '../../src/ssh/sftp/service.ts'
import { SftpService } from '../../src/ssh/sftp/service.ts'

const SFTP_OPTIONS: SftpOptions = {
  sftpConcurrency: 8,
  sftpOpenTimeoutMs: 20,
  sftpOperationTimeoutMs: 20,
  sftpReadTimeoutMs: 20,
  maxReadFileBytes: 32 * 1024 * 1024,
  sftpTransferIdleTimeoutMs: 20,
  sftpRecursiveRmTimeoutMs: 40,
}

/** A channel whose requests never answer — the stalled transport. */
class StalledSftp extends EventEmitter {
  realpath(): void { /* never calls back */ }
  readdir(): void { /* never calls back */ }
  stat(): void { /* never calls back */ }
  lstat(): void { /* never calls back */ }
  rename(): void { /* never calls back */ }
  ext_openssh_rename(): void { /* never calls back */ }
  end(): void { /* nothing to close */ }
}

/** Attributes shaped like ssh2's `Stats`, for the stat/lstat reads. */
const FAKE_ATTRS = {
  isDirectory: () => true,
  isFile: () => false,
  isSymbolicLink: () => false,
  size: 0,
  mtime: 0,
  mode: 0o755,
}

/** A healthy channel that resolves everything to itself. */
class HealthySftp extends EventEmitter {
  realpath(path: string, callback: (error: Error | undefined, canonical?: string) => void): void {
    callback(undefined, path)
  }
  readdir(_path: string, callback: (error: Error | undefined, entries: unknown[]) => void): void {
    callback(undefined, [])
  }
  stat(_path: string, callback: (error: Error | undefined, attrs: unknown) => void): void {
    callback(undefined, FAKE_ATTRS)
  }
  lstat(_path: string, callback: (error: Error | undefined, attrs: unknown) => void): void {
    callback(undefined, FAKE_ATTRS)
  }
  end(): void { /* nothing to close */ }
}

const asSftp = (sftp: EventEmitter): SFTPWrapper => sftp as unknown as SFTPWrapper

/** Records the access options each call site asks for. */
function recordingService(seen: SftpClientOptions[]): SftpService {
  const sftp = new HealthySftp()
  const client = { sftp: (callback: (error: Error | undefined, value: SFTPWrapper) => void) => { callback(undefined, asSftp(sftp)) } } as unknown as Client
  const access: SftpClientAccess = {
    acquire: async () => { throw new Error('acquire is not used here') },
    withClient: async (alias, operation, options) => {
      if (options !== undefined) seen.push(options)
      return operation(client, { markCommitted: () => {} })
    },
  }
  return new SftpService(access, SFTP_OPTIONS)
}

/**
 * An access layer that applies `withClient`'s own policy faithfully: a failed
 * attempt is retried on the NEXT channel only when the caller asked for a
 * replayable operation. Every channel after the first answers normally.
 */
function retryingAccess(channels: EventEmitter[]): SftpClientAccess {
  return {
    acquire: async () => { throw new Error('acquire is not used here') },
    withClient: async (alias, operation, options) => {
      const attempts = options?.retryPolicy === 'idempotent' ? (options.attempts ?? 3) : 1
      let lastError: unknown
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const sftp = channels[Math.min(attempt, channels.length - 1)] as EventEmitter
        const client = { sftp: (callback: (error: Error | undefined, value: SFTPWrapper) => void) => { callback(undefined, asSftp(sftp)) } } as unknown as Client
        try {
          return await operation(client, { markCommitted: () => {} })
        } catch (error) {
          lastError = error
        }
      }
      throw lastError
    },
  }
}

describe('SFTP read access options', () => {
  it('asks for a replayable access on every read path', async () => {
    const seen: SftpClientOptions[] = []
    const ssh = recordingService(seen)
    await ssh.canonicalPath('host', '/srv/app')
    await ssh.realpaths('host', ['/srv/app'])
    await ssh.ls('host', '/srv/app')
    await ssh.stat('host', '/srv/app')
    await ssh.lstat('host', '/srv/app')
    ssh.dispose()

    expect(seen).toHaveLength(5)
    for (const options of seen) {
      expect(options.retryPolicy).toBe('idempotent')
      // One replay, not three full budgets: this is an interactive read.
      expect(options.attempts).toBe(2)
    }
  })

  it('leaves writes single-attempt (a replayed write may duplicate work)', async () => {
    const seen: SftpClientOptions[] = []
    const ssh = recordingService(seen)
    await ssh.rename('host', '/srv/a', '/srv/b').catch(() => undefined)
    ssh.dispose()

    expect(seen).toHaveLength(1)
    expect(seen[0]!.retryPolicy).toBeUndefined()
    expect(seen[0]!.attempts).toBeUndefined()
  })
})

describe('a stalled channel no longer kills the read', () => {
  it('recovers canonicalPath on the fresh connection', async () => {
    // The exact failure mode: the first channel stops answering, the read times
    // out, the transport is retired, and the replay lands on a healthy one.
    const ssh = new SftpService(retryingAccess([new StalledSftp(), new HealthySftp()]), SFTP_OPTIONS)
    await expect(ssh.canonicalPath('host', '/yutiancheng/2026/regvelo/.git', { allowMissingLeaf: true }))
      .resolves.toBe('/yutiancheng/2026/regvelo/.git')
    ssh.dispose()
  })

  it('still reports the timeout for a write, which must not be replayed', async () => {
    const ssh = new SftpService(retryingAccess([new StalledSftp(), new HealthySftp()]), SFTP_OPTIONS)
    await expect(ssh.rename('host', '/srv/a', '/srv/b')).rejects.toThrow(/timed out/)
    ssh.dispose()
  })
})
