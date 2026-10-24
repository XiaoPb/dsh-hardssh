/** Key discovery/import helpers (Android search dirs, name safety, content sniff). */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { looksLikePrivateKey, privateKeySearchDirs, sanitizeKeyName } from '../../src/ssh/keys.ts'

afterEach(() => { vi.unstubAllEnvs() })

describe('privateKeySearchDirs', () => {
  it('keeps the private ~/.ssh first and appends the Android public key directory', () => {
    vi.stubEnv('ANDROID_DATA', '/data')
    vi.stubEnv('DSH_ANDROID_USER_DATA', '/storage/emulated/0/Documents/dshdata')
    const dirs = privateKeySearchDirs(['/custom/keys'])
    expect(dirs.slice(0, 3)).toEqual([
      '/custom/keys',
      join(homedir(), '.ssh'),
      join('/storage/emulated/0/Documents/dshdata', 'ssh'),
    ])
    expect(dirs).toContain('/storage/emulated/0/Documents/dshdata/ssh')
  })

  it('does not invent Android directories on a desktop runtime', () => {
    const dirs = privateKeySearchDirs()
    expect(dirs).toContain(join(homedir(), '.ssh'))
    expect(dirs.some(directory => directory.startsWith('/storage/emulated/0'))).toBe(false)
  })
})

describe('sanitizeKeyName', () => {
  it('accepts a single file name and rejects traversal or separators', () => {
    expect(sanitizeKeyName('id_ed25519')).toBe('id_ed25519')
    expect(sanitizeKeyName(' my-key.pem ')).toBe('my-key.pem')
    expect(sanitizeKeyName('../evil')).toBeUndefined()
    expect(sanitizeKeyName('a/b')).toBeUndefined()
    expect(sanitizeKeyName('a\\b')).toBeUndefined()
    expect(sanitizeKeyName('..')).toBeUndefined()
    expect(sanitizeKeyName('')).toBeUndefined()
  })
})

describe('looksLikePrivateKey', () => {
  it('recognises OpenSSH/PEM private key blocks', () => {
    expect(looksLikePrivateKey('-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----')).toBe(true)
    expect(looksLikePrivateKey('-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----')).toBe(true)
    expect(looksLikePrivateKey('ssh-ed25519 AAAA')).toBe(false)
    expect(looksLikePrivateKey('hello')).toBe(false)
  })
})
