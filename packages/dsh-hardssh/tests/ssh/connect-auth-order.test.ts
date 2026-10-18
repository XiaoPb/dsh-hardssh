/**
 * Key-first authentication for SSH connections.
 *
 * The mode the GUI now offers is the VS Code Remote-SSH one: use key material
 * (explicit IdentityFile → OpenSSH default key → ssh-agent) and never ask for a
 * password when a key works. Two implementation facts make that possible:
 *
 *  - ssh2's DEFAULT order tries `password` BEFORE `publickey`/`agent` whenever
 *    both are configured, so a host with a password (or a stale one) prompted
 *    even though the key was accepted. `buildConnectConfig` now pins the order
 *    explicitly.
 *  - Windows OpenSSH exposes its agent as a named pipe and never sets
 *    SSH_AUTH_SOCK, so a running agent used to be invisible.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildConnectConfig,
  DEFAULT_PRIVATE_KEY_NAMES,
  defaultPrivateKeyPath,
} from '../../src/ssh/connection/manager.ts'
import type { SshHostEntry } from '../../src/ssh/protocol.ts'

const OPTIONS = { connectTimeoutMs: 5_000, keepaliveIntervalMs: 15_000 }

const created: string[] = []
const savedSock = process.env.SSH_AUTH_SOCK

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-auth-'))
  created.push(dir)
  return dir
}

function keyFile(content = '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n'): string {
  const path = join(tempDir(), 'explicit-key')
  writeFileSync(path, content)
  return path
}

function entry(auth: SshHostEntry['auth']): SshHostEntry {
  return { alias: 'h', host: '10.0.0.1', port: 22, user: 'u', auth } as SshHostEntry
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (savedSock === undefined) delete process.env.SSH_AUTH_SOCK
  else process.env.SSH_AUTH_SOCK = savedSock
})

describe('defaultPrivateKeyPath', () => {
  it('finds the usual keys in OpenSSH preference order', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'id_rsa'), 'rsa')
    expect(defaultPrivateKeyPath(dir)).toBe(join(dir, 'id_rsa'))
    writeFileSync(join(dir, 'id_ed25519'), 'ed')
    // id_ed25519 outranks id_rsa, exactly like OpenSSH's default list.
    expect(defaultPrivateKeyPath(dir)).toBe(join(dir, 'id_ed25519'))
  })

  it('answers undefined for a directory without default keys', () => {
    expect(defaultPrivateKeyPath(tempDir())).toBeUndefined()
  })

  it('declares the canonical default names', () => {
    expect([...DEFAULT_PRIVATE_KEY_NAMES]).toEqual(['id_ed25519', 'id_ecdsa', 'id_rsa', 'id_dsa'])
  })
})

describe('buildConnectConfig authentication order', () => {
  it('tries the explicit key, then the agent, then a password', () => {
    const keyPath = keyFile()
    process.env.SSH_AUTH_SOCK = '/tmp/fake-agent.sock'
    const config = buildConnectConfig(entry({ kind: 'password', keyPath, password: 'pw' }), OPTIONS)
    expect(config.privateKey).toContain('OPENSSH PRIVATE KEY')
    expect(config.agent).toBe('/tmp/fake-agent.sock')
    expect(config.password).toBe('pw')
    // ssh2's default would put 'password' FIRST; this pins key-first instead.
    expect(config.authHandler).toEqual(['publickey', 'agent', 'password'])
  })

  it('never needs a password when a key is usable', () => {
    const keyPath = keyFile()
    delete process.env.SSH_AUTH_SOCK
    const config = buildConnectConfig(entry({ kind: 'key', keyPath }), OPTIONS)
    expect(config.password).toBeUndefined()
    expect(config.authHandler).toEqual(['publickey'])
  })

  it('falls back to the default key when the configured one is missing', () => {
    delete process.env.SSH_AUTH_SOCK
    const configured = join(tempDir(), 'not-delivered-yet')
    const config = buildConnectConfig(entry({ kind: 'key', keyPath: configured }), OPTIONS)
    const fallback = defaultPrivateKeyPath()
    if (fallback === undefined) {
      // A machine without default keys must fail loudly instead of silently
      // authenticating as nobody.
      expect(() => buildConnectConfig(entry({ kind: 'key', keyPath: configured }), OPTIONS)).toThrow()
      return
    }
    expect(config.privateKey).toBeDefined()
    expect(config.authHandler).toEqual(['publickey'])
  })

  it('does not leak the configured passphrase onto the fallback key', () => {
    delete process.env.SSH_AUTH_SOCK
    const configured = join(tempDir(), 'missing-key')
    const config = buildConnectConfig(entry({ kind: 'key', keyPath: configured, passphrase: 'secret' }), OPTIONS)
    if (defaultPrivateKeyPath() !== undefined) expect(config.passphrase).toBeUndefined()
  })

  it('keeps the passphrase for the key it belongs to', () => {
    const keyPath = keyFile()
    delete process.env.SSH_AUTH_SOCK
    const config = buildConnectConfig(entry({ kind: 'key', keyPath, passphrase: 'secret' }), OPTIONS)
    expect(config.passphrase).toBe('secret')
  })

  it('prefers the vault-resolved auth over the stored one', () => {
    const keyPath = keyFile()
    delete process.env.SSH_AUTH_SOCK
    const config = buildConnectConfig(entry({ kind: 'password', password: 'stale' }), OPTIONS, undefined, {
      authOverride: { kind: 'key', keyPath },
    })
    expect(config.password).toBeUndefined()
    expect(config.privateKey).toContain('OPENSSH PRIVATE KEY')
    expect(config.authHandler).toEqual(['publickey'])
  })
})
