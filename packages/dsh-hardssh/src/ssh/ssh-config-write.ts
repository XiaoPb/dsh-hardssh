/**
 * Writer for the user's `~/.ssh/config`.
 *
 * Model (agreed): that file is the single source of HOST DEFINITIONS. The
 * plugin's own store keeps only metadata, credentials and an ignore list. The
 * GUI edits this file through these functions.
 *
 * Safety rules this module enforces — the file is user-owned and critical, so
 * every rule here is deliberate:
 *
 *  1. ONLY the fields the plugin models are written (`Host`, `HostName`, `Port`,
 *     `User`, `IdentityFile`, `ProxyJump`). Passwords/keys are never written.
 *  2. Editing touches ONLY the target field lines: comments, blank lines,
 *     unknown directives (`Compression`, `LocalForward`, …), block order and
 *     line endings survive byte-for-byte.
 *  3. Writes are atomic (temp file in the same directory + rename) after a
 *     timestamped backup, keeping the last few backups.
 *  4. A caller that supplies an expected content hash gets a hard conflict
 *     refusal when the file changed underneath it (no silent overwrite).
 *  5. Cross-process lock file, because the desktop app and a `dsh web` process
 *     can run at once.
 *  6. Clearing a field REMOVES its line (OpenSSH then applies its default)
 *     instead of writing an empty value.
 *
 * Blocks the plugin cannot edit safely are detected by the caller through
 * `pattern`/`patterns`: wildcards and multi-pattern `Host a b` blocks are
 * read-only by policy (see ssh-config.ts for the read side).
 * @module dsh-hardssh/ssh-config-write
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** One `Host` block with its exact line range. */
export interface SshConfigBlock {
  /** First pattern of the `Host` line — the alias the plugin addresses. */
  pattern: string
  /** Every pattern on the `Host` line (more than one is read-only by policy). */
  patterns: string[]
  /** 0-based index of the `Host` line. */
  hostLine: number
  /** 0-based exclusive end index (next `Host` line, or end of file). */
  endLine: number
  /** Lowercase keyword → value (last value wins, `IdentityFile` keeps the first). */
  props: Record<string, string>
  /** Lowercase keyword → line indexes that carry it (for surgical edits). */
  propLines: Record<string, number[]>
}

/** A parsed config document. */
export interface SshConfigDocument {
  text: string
  /** Dominant line ending; new/edited lines use it. */
  eol: '\n' | '\r\n'
  hasBom: boolean
  lines: string[]
  blocks: SshConfigBlock[]
}

/** A host definition to write (the fields the plugin owns). */
export interface SshConfigHostWrite {
  alias: string
  host: string
  port?: number
  user?: string
  identityFile?: string
  proxyJump?: readonly string[]
}

/**
 * One surgical edit.
 *
 * `undefined` leaves a field alone, `null` removes its line, any other value
 * replaces it. This is what lets the GUI clear `IdentityFile` without inventing
 * an empty path.
 */
export interface SshConfigHostEdit {
  alias: string
  host?: string | null
  port?: number | null
  user?: string | null
  identityFile?: string | null
  proxyJump?: readonly string[] | null
}

/** The alias does not exist in the document (caller decides append vs error). */
export class SshConfigUnknownHostError extends Error {
  constructor(readonly alias: string) {
    super(`ssh config has no Host block for '${alias}'`)
    this.name = 'SshConfigUnknownHostError'
  }
}

/** The file changed since it was read; the caller must reload before writing. */
export class SshConfigConflictError extends Error {
  constructor(readonly path: string) {
    super(`ssh config changed on disk since it was read: ${path}`)
    this.name = 'SshConfigConflictError'
  }
}

const BOM = '\uFEFF'

/**
 * Split a document into lines plus its `Host` blocks with exact ranges.
 * @param text - the file content.
 * @returns the parsed document (line endings normalised only for inspection).
 */
export function parseConfigDocument(text: string): SshConfigDocument {
  const hasBom = text.startsWith(BOM)
  const body = hasBom ? text.slice(1) : text
  const eol: '\n' | '\r\n' = body.includes('\r\n') ? '\r\n' : '\n'
  const lines = body.split(/\r?\n/)
  const blocks: SshConfigBlock[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*Host\s+(.+)$/i.exec(lines[index] ?? '')
    if (match === null) continue
    const patterns = match[1]!.trim().split(/\s+/).filter(part => part !== '')
    const block: SshConfigBlock = {
      pattern: patterns[0] ?? '',
      patterns,
      hostLine: index,
      endLine: lines.length,
      props: {},
      propLines: {},
    }
    // Close the previous block at this Host line.
    const previous = blocks[blocks.length - 1]
    if (previous !== undefined) previous.endLine = index
    blocks.push(block)
  }
  for (const block of blocks) {
    for (let index = block.hostLine + 1; index < block.endLine; index += 1) {
      const line = lines[index] ?? ''
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      const match = /^([A-Za-z0-9_-]+)\s+(.+)$/.exec(trimmed)
      if (match === null) continue
      const key = match[1]!.toLowerCase()
      // IdentityFile is additive in OpenSSH; keep its first line.
      if (key === 'identityfile' && (block.propLines.identityfile?.length ?? 0) > 0) continue
      block.props[key] = match[2]!.trim()
      block.propLines[key] = [...(block.propLines[key] ?? []), index]
    }
  }
  return { text, eol, hasBom, lines, blocks }
}

/** Read and parse a config file. A missing file is an empty document. */
export async function readConfigDocument(path: string): Promise<SshConfigDocument> {
  let text = ''
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw error
  }
  return parseConfigDocument(text)
}

/** The blocks that address `alias`, in file order. */
export function blocksForAlias(doc: SshConfigDocument, alias: string): SshConfigBlock[] {
  return doc.blocks.filter(block => block.pattern === alias)
}

/** Join lines back into file text, preserving BOM and line endings. */
function joinDocument(doc: SshConfigDocument, lines: readonly string[]): string {
  const body = lines.join(doc.eol)
  return doc.hasBom ? `${BOM}${body}` : body
}

/** Indentation a rewritten field line should use (existing line wins). */
function indentFor(block: SshConfigBlock, prop: string, lines: readonly string[]): string {
  const existing = block.propLines[prop]?.[0]
  if (existing !== undefined) {
    const line = lines[existing] ?? ''
    return /^\s*/.exec(line)?.[0] ?? '  '
  }
  return '  '
}

/** One `Key value` line as the document's existing style. */
function fieldLine(indent: string, key: string, value: string): string {
  return `${indent}${key} ${value}`
}

/**
 * Apply one surgical edit to a block, returning the new full text.
 *
 * Only the first block for the alias is edited (OpenSSH's effective one); the
 * caller receives the duplicate count so the GUI can warn.
 * @param doc - parsed document.
 * @param edit - fields to set (`undefined`) or clear (`null`).
 * @returns next text, the edited block and any duplicate blocks.
 * @throws SshConfigUnknownHostError when the alias is absent.
 */
export function editHost(doc: SshConfigDocument, edit: SshConfigHostEdit): {
  text: string
  edited: SshConfigBlock
  duplicates: SshConfigBlock[]
} {
  const matches = blocksForAlias(doc, edit.alias)
  const block = matches[0]
  if (block === undefined) throw new SshConfigUnknownHostError(edit.alias)
  const lines = [...doc.lines]
  // Work from the last line backwards so earlier indexes stay valid.
  const removals: number[] = []
  const replacements: Array<{ index: number; line: string }> = []
  const appends: string[] = []

  const apply = (prop: string, key: string, value: string | undefined | null): void => {
    const existing = block.propLines[prop] ?? []
    if (value === undefined) return
    if (value === null || value === '') {
      removals.push(...existing)
      return
    }
    const indent = indentFor(block, prop, lines)
    const line = fieldLine(indent, key, value)
    if (existing.length === 0) {
      appends.push(line)
      return
    }
    // Replace the FIRST line and drop any extra lines for the same keyword.
    replacements.push({ index: existing[0]!, line })
    removals.push(...existing.slice(1))
  }

  apply('hostname', 'HostName', edit.host)
  apply('port', 'Port', edit.port === undefined ? undefined : edit.port === null ? null : String(edit.port))
  apply('user', 'User', edit.user)
  apply('identityfile', 'IdentityFile', edit.identityFile)
  apply(
    'proxyjump',
    'ProxyJump',
    edit.proxyJump === undefined || edit.proxyJump === null
      ? edit.proxyJump
      : edit.proxyJump.length === 0 ? null : edit.proxyJump.join(','),
  )

  // Insert new field lines at the end of the block's meaningful content (before
  // trailing blank lines so the block keeps its own spacing).
  if (appends.length > 0) {
    let insertAt = block.endLine
    while (insertAt > block.hostLine + 1 && (lines[insertAt - 1] ?? '').trim() === '') insertAt -= 1
    let offset = 0
    for (const line of appends) {
      lines.splice(insertAt + offset, 0, line)
      offset += 1
    }
    // Indexes captured before the insert shift by the number of inserted lines
    // only when they are at/after the insertion point; field lines are inside
    // the block before it, so they are unaffected.
  }
  for (const { index, line } of replacements) lines[index] = line
  const removalSet = new Set(removals)
  if (removalSet.size > 0) {
    const kept = lines.filter((_, index) => !removalSet.has(index))
    lines.length = 0
    lines.push(...kept)
  }
  return { text: joinDocument(doc, lines), edited: block, duplicates: matches.slice(1) }
}

/** Append one host block at the end of the document. */
export function appendHost(doc: SshConfigDocument, host: SshConfigHostWrite): string {
  const block: string[] = [`Host ${host.alias}`]
  block.push(`  HostName ${host.host}`)
  if (host.port !== undefined && host.port !== 22) block.push(`  Port ${host.port}`)
  if (host.user !== undefined && host.user !== '') block.push(`  User ${host.user}`)
  if (host.identityFile !== undefined && host.identityFile !== '') block.push(`  IdentityFile ${host.identityFile}`)
  if (host.proxyJump !== undefined && host.proxyJump.length > 0) block.push(`  ProxyJump ${host.proxyJump.join(',')}`)

  const lines = [...doc.lines]
  // Drop the trailing empty line produced by a file that ends with a newline,
  // then re-add exactly one blank separator before the new block.
  while (lines.length > 0 && (lines[lines.length - 1] ?? '') === '') lines.pop()
  if (lines.length > 0) lines.push('')
  lines.push(...block, '')
  return joinDocument(doc, lines)
}

/**
 * Remove EVERY block that addresses `alias` (duplicates included), collapsing
 * the blank line the removal would otherwise leave behind.
 * @param doc - parsed document.
 * @param alias - exact first pattern to remove.
 * @returns next text and how many blocks were removed.
 */
export function deleteHost(doc: SshConfigDocument, alias: string): { text: string; removed: number } {
  const matches = blocksForAlias(doc, alias)
  if (matches.length === 0) return { text: doc.text, removed: 0 }
  const remove = new Set<number>()
  for (const block of matches) {
    for (let index = block.hostLine; index < block.endLine; index += 1) remove.add(index)
    // Also consume ONE following blank line so blocks do not collapse together.
    if ((doc.lines[block.endLine] ?? '').trim() === '') remove.add(block.endLine)
  }
  const kept = doc.lines.filter((_, index) => !remove.has(index))
  // Collapse blank lines the removal exposed at the tail, then restore the
  // file's original trailing-newline state (do not invent or drop one).
  while (kept.length > 0 && (kept[kept.length - 1] ?? '') === '') kept.pop()
  const hadTrailingNewline = doc.text.endsWith('\n')
  if (hadTrailingNewline) kept.push('')
  return { text: joinDocument(doc, kept), removed: matches.length }
}

/** SHA-256 of the document text (conflict detection). */
export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Stat + hash of a file, or undefined when it does not exist yet. */
export async function fileFingerprint(path: string): Promise<{ mtimeMs: number; hash: string } | undefined> {
  if (!existsSync(path)) return undefined
  const info = await stat(path)
  return { mtimeMs: info.mtimeMs, hash: contentHash(await readFile(path, 'utf8')) }
}

const LOCK_SUFFIX = '.dsh-lock'
const LOCK_STALE_MS = 30_000

/**
 * Run `operation` while holding a cross-process lock for the config file.
 *
 * The desktop app and a `dsh web` process can both write, so an in-process mutex
 * is not enough. A lock older than 30s is treated as abandoned (crashed writer).
 * @param path - config file being written.
 * @param operation - critical section.
 * @returns the operation's result.
 */
export async function withConfigLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${path}${LOCK_SUFFIX}`
  const deadline = Date.now() + 5_000
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx')
      try {
        await handle.writeFile(String(process.pid), 'utf8')
        return await operation()
      } finally {
        await handle.close()
        await unlink(lockPath).catch(() => undefined)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const info = await stat(lockPath)
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await unlink(lockPath).catch(() => undefined)
          continue
        }
      } catch { /* the holder released it between stat and read */ }
      if (Date.now() > deadline) throw new Error(`ssh config is locked by another process: ${lockPath}`)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
}

/** Copy the file to a timestamped sibling; returns the backup path. */
async function backupFile(path: string): Promise<string | undefined> {
  if (!existsSync(path)) return undefined
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = join(dirname(path), `${basename(path)}.dsh-backup-${stamp}`)
  await copyFile(path, backup)
  return backup
}

/** Keep only the newest `keep` backups for one config file. */
async function pruneBackups(path: string, keep: number): Promise<void> {
  const dir = dirname(path)
  const prefix = `${basename(path)}.dsh-backup-`
  const entries = (await readdir(dir).catch(() => [] as string[]))
    .filter(name => name.startsWith(prefix))
    .sort()
  for (const name of entries.slice(0, Math.max(0, entries.length - keep))) {
    await rm(join(dir, name), { force: true }).catch(() => undefined)
  }
}

/** Write `next` atomically: same-directory temp file, then rename over the target. */
async function atomicWrite(path: string, next: string): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.dsh-tmp-${process.pid}-${Date.now()}`)
  try {
    await writeFile(tmp, next, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

/** What one successful write did. */
export interface SshConfigWriteResult {
  backupPath?: string
}

/**
 * Write the next document text with backup, conflict check and atomic replace.
 *
 * @param path - config file path.
 * @param nextText - full new content.
 * @param options.expectedHash - hash the caller read; a mismatch refuses the write.
 * @param options.keepBackups - how many timestamped backups to retain (default 5).
 * @returns the backup path, when a previous file existed.
 * @throws SshConfigConflictError when another writer got there first.
 */
export async function writeConfigFile(
  path: string,
  nextText: string,
  options: { expectedHash?: string; keepBackups?: number } = {},
): Promise<SshConfigWriteResult> {
  return withConfigLock(path, async () => {
    if (options.expectedHash !== undefined) {
      const actual = existsSync(path) ? contentHash(await readFile(path, 'utf8')) : contentHash('')
      if (actual !== options.expectedHash) throw new SshConfigConflictError(path)
    }
    const backupPath = await backupFile(path)
    await atomicWrite(path, nextText)
    await pruneBackups(path, options.keepBackups ?? 5)
    return backupPath === undefined ? {} : { backupPath }
  })
}
