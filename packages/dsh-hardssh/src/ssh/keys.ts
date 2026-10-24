/**
 * SSH private-key discovery, import, and generation.
 *
 * OpenSSH's default-key preference order lives here (one source for the
 * connection fallback, the host-form prefill, and the key routes). On Android
 * the host account's `$HOME` is the app-private DSH home, so keys can also be
 * discovered from the app's PUBLIC data root (`DSH_ANDROID_USER_DATA/ssh`) and
 * the `Documents/dshdata/ssh` convention.
 *
 * @module dsh-hardssh/ssh/keys
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { utils as sshUtils } from 'ssh2'
import { androidUserDataRoot, isAndroidRuntime } from '../platform.ts'

/** Default private keys OpenSSH tries, in its own preference order. */
export const DEFAULT_PRIVATE_KEY_NAMES = ['id_ed25519', 'id_ecdsa', 'id_rsa', 'id_dsa'] as const

/** The app-private `~/.ssh` directory (or an overridden test/import dir). */
export function keyDirectory(override?: string): string {
  return override !== undefined && override !== '' ? override : join(homedir(), '.ssh')
}

/**
 * Directories searched for an OpenSSH default key, most-specific first.
 *
 * The explicit `extra` entries (the SSH routes' injectable key dir) win, then
 * the private `~/.ssh`, then the Android app's public key directory.
 *
 * @param extra - caller-provided directories to search before the defaults.
 * @returns de-duplicated absolute directories.
 */
export function privateKeySearchDirs(extra: readonly string[] = []): string[] {
  const dirs = [...extra, join(homedir(), '.ssh')]
  if (isAndroidRuntime()) {
    const appData = androidUserDataRoot()
    if (appData !== undefined) dirs.push(join(appData, 'ssh'))
    dirs.push('/storage/emulated/0/Documents/dshdata/ssh')
  }
  const seen = new Set<string>()
  return dirs.filter((dir) => {
    if (dir === '' || seen.has(dir)) return false
    seen.add(dir)
    return true
  })
}

/**
 * The first existing default private key in one directory, or undefined.
 *
 * @param sshDir - directory to inspect; defaults to the user's `~/.ssh`.
 * @returns an absolute key path, or undefined when none of them exists.
 */
export function defaultPrivateKeyPath(sshDir = join(homedir(), '.ssh')): string | undefined {
  for (const name of DEFAULT_PRIVATE_KEY_NAMES) {
    const candidate = join(sshDir, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Search several directories for the first default key.
 *
 * @param dirs - ordered directories; defaults to {@link privateKeySearchDirs}.
 * @returns the first existing key path, or undefined.
 */
export function findDefaultPrivateKey(dirs: readonly string[] = privateKeySearchDirs()): string | undefined {
  for (const dir of dirs) {
    const found = defaultPrivateKeyPath(dir)
    if (found !== undefined) return found
  }
  return undefined
}

/** Validate one upload/import file name (never a path, never `.`/`..`). */
export function sanitizeKeyName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const base = raw.trim()
  if (base === '' || base === '.' || base === '..') return undefined
  if (base.includes('/') || base.includes('\\')) return undefined
  return /^[A-Za-z0-9._-]{1,80}$/.test(base) ? base : undefined
}

/** True when the text looks like an unencrypted or encrypted private key. */
export function looksLikePrivateKey(text: string): boolean {
  return /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text)
}

/** Pick a non-existing `<name>[-N][.ext]` under `dir`. */
function uniqueKeyPath(dir: string, name: string): string {
  const candidate = join(dir, name)
  if (!existsSync(candidate)) return candidate
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  for (let index = 2; index < 100; index += 1) {
    const next = join(dir, `${stem}-${index}${extension}`)
    if (!existsSync(next)) return next
  }
  throw new Error('no free file name for the private key')
}

/** Create the key directory and make the private key owner-only. */
function writePrivateKey(dir: string, name: string, content: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(dir, 0o700)
  } catch {
    // Windows has no POSIX permission bits; keep the created directory.
  }
  const path = uniqueKeyPath(dir, name)
  const body = content.endsWith('\n') ? content : `${content}\n`
  writeFileSync(path, body, { mode: 0o600 })
  try {
    // writeFileSync's mode only applies on create; an existing target would
    // otherwise keep its previous (possibly group-readable) bits.
    chmodSync(path, 0o600)
  } catch {
    // Windows has no POSIX permission bits; the write itself already landed.
  }
  return path
}

/**
 * Import one private key into the key directory.
 *
 * @param content - the key text read by the browser file picker.
 * @param name - operator-supplied file name; sanitized, defaults to id_ed25519.
 * @param dir - key directory override (tests); defaults to `~/.ssh`.
 * @returns the absolute path of the imported key.
 */
export function importPrivateKey(content: string, name?: string, dir?: string): string {
  if (content === '' || !looksLikePrivateKey(content)) {
    throw new Error('not a private key (expected a "-----BEGIN ... PRIVATE KEY-----" block)')
  }
  const safeName = sanitizeKeyName(name) ?? DEFAULT_PRIVATE_KEY_NAMES[0]
  return writePrivateKey(keyDirectory(dir), safeName, content)
}

/**
 * Generate a new Ed25519 key pair and persist the private half.
 *
 * @param name - preferred file name (sanitized; unique suffix on collision).
 * @param dir - key directory override (tests); defaults to `~/.ssh`.
 * @returns the private key path and the OpenSSH public-key line.
 */
export function generatePrivateKey(name?: string, dir?: string): { path: string; publicKey: string } {
  const safeName = sanitizeKeyName(name) ?? DEFAULT_PRIVATE_KEY_NAMES[0]
  const pair = sshUtils.generateKeyPairSync('ed25519', { comment: 'dsh-hardssh' })
  const path = writePrivateKey(keyDirectory(dir), safeName, pair.private)
  return { path, publicKey: pair.public }
}
