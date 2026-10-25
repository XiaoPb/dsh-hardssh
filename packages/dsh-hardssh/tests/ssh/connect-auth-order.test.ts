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
  shouldForgetSessionSecret,
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
    const fallback = keyFile()
    // Inject the default-key seam instead of depending on the runner's ~/.ssh:
    // CI runners have no default key, while developer machines often do.
    const config = buildConnectConfig(entry({ kind: 'key', keyPath: configured }), OPTIONS, undefined, {
      defaultKeyPath: () => fallback,
    })
    expect(config.privateKey).toContain('OPENSSH PRIVATE KEY')
    expect(config.authHandler).toEqual(['publickey'])
  })

  it('does not leak the configured passphrase onto the fallback key', () => {
    delete process.env.SSH_AUTH_SOCK
    const configured = join(tempDir(), 'missing-key')
    const fallback = keyFile()
    const config = buildConnectConfig(entry({ kind: 'key', keyPath: configured, passphrase: 'secret' }), OPTIONS, undefined, {
      defaultKeyPath: () => fallback,
    })
    expect(config.privateKey).toContain('OPENSSH PRIVATE KEY')
    expect(config.passphrase).toBeUndefined()
  })

  it('fails loudly when neither key material nor an agent is available', () => {
    delete process.env.SSH_AUTH_SOCK
    const configured = join(tempDir(), 'missing-key')
    expect(() => buildConnectConfig(entry({ kind: 'key', keyPath: configured }), OPTIONS, undefined, {
      defaultKeyPath: () => undefined,
    })).toThrow(/private key not found/)
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

describe('shouldForgetSessionSecret (the "first password entry fails" race)', () => {
  it('forgets the exact credential the attempt carried and the server rejected', () => {
    expect(shouldForgetSessionSecret({ password: 'p1' }, { password: 'p1' }, true)).toBe(true)
    expect(shouldForgetSessionSecret({ passphrase: 'k1' }, { passphrase: 'k1' }, true)).toBe(true)
  })

  it('never forgets when the failed attempt carried no session secret', () => {
    // The regression: a key-only attempt (started before the prompt finished)
    // was denied and erased the password the user had just stored, so the
    // prompt's retry had nothing to use and asked again.
    expect(shouldForgetSessionSecret(undefined, { password: 'p1' }, true)).toBe(false)
    expect(shouldForgetSessionSecret({}, { password: 'p1' }, true)).toBe(false)
    expect(shouldForgetSessionSecret({ password: '' }, { password: 'p1' }, true)).toBe(false)
  })

  it('keeps a credential stored while the handshake was in flight', () => {
    expect(shouldForgetSessionSecret({ password: 'old' }, { password: 'new' }, true)).toBe(false)
    expect(shouldForgetSessionSecret({ passphrase: 'old' }, { passphrase: 'new' }, true)).toBe(false)
  })

  it('only acts on authentication denials', () => {
    expect(shouldForgetSessionSecret({ password: 'p1' }, { password: 'p1' }, false)).toBe(false)
    // Nothing stored: nothing to forget.
    expect(shouldForgetSessionSecret({ password: 'p1' }, undefined, true)).toBe(false)
  })
})
