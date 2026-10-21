/**
 * The `~/.ssh/config` WRITE layer.
 *
 * The file is user-owned and critical, so these cases pin the safety rules the
 * implementation promises: only modelled fields are touched, unknown directives
 * and comments survive, clearing a field removes its line, duplicates are
 * reported, deletion removes every duplicate, and a write is refused when the
 * file changed underneath the caller (plus a backup is taken).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendHost,
  blocksForAlias,
  contentHash,
  deleteHost,
  editHost,
  parseConfigDocument,
  readConfigDocument,
  SshConfigConflictError,
  SshConfigUnknownHostError,
  writeConfigFile,
} from '../../src/ssh/ssh-config-write.ts'

const created: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sshcfg-write-'))
  created.push(dir)
  return dir
}

const SAMPLE = [
  '# keep this comment',
  'Host alpha',
  '  HostName alpha.example',
  '  Port 2222',
  '  User alice',
  '  Compression yes',
  '',
  'Host beta',
  '  HostName beta.example',
  '',
].join('\n')

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('parseConfigDocument', () => {
  it('records exact block ranges and props', () => {
    const doc = parseConfigDocument(SAMPLE)
    expect(doc.blocks.map(block => block.pattern)).toEqual(['alpha', 'beta'])
    const alpha = doc.blocks[0]!
    expect(alpha.hostLine).toBe(1)
    expect(alpha.endLine).toBe(7)
    expect(alpha.props).toMatchObject({ hostname: 'alpha.example', port: '2222', user: 'alice', compression: 'yes' })
  })

  it('finds duplicate blocks for one alias', () => {
    const doc = parseConfigDocument('Host dup\nHostName a\n\nHost dup\nHostName b\n')
    expect(blocksForAlias(doc, 'dup')).toHaveLength(2)
  })

  it('detects CRLF documents', () => {
    expect(parseConfigDocument('Host a\r\nHostName a.example\r\n').eol).toBe('\r\n')
    expect(parseConfigDocument('Host a\nHostName a.example\n').eol).toBe('\n')
  })
})

describe('editHost', () => {
  it('rewrites only the target field lines and keeps everything else', () => {
    const doc = parseConfigDocument(SAMPLE)
    const { text } = editHost(doc, { alias: 'alpha', port: 2200, user: 'bob' })
    expect(text).toContain('  Port 2200\n')
    expect(text).toContain('  User bob\n')
    // Unknown directives and comments survive untouched.
    expect(text).toContain('  Compression yes')
    expect(text).toContain('# keep this comment')
    // The other block is byte-identical.
    expect(text).toContain('Host beta\n  HostName beta.example')
  })

  it('adds a missing field at the end of the block', () => {
    const doc = parseConfigDocument(SAMPLE)
    const { text } = editHost(doc, { alias: 'alpha', identityFile: '~/.ssh/id_new' })
    expect(text).toContain('  IdentityFile ~/.ssh/id_new')
    // Still inside the alpha block: before the blank line that precedes beta.
    const alphaPart = text.slice(0, text.indexOf('Host beta'))
    expect(alphaPart).toContain('IdentityFile ~/.ssh/id_new')
    expect(alphaPart.trimEnd().endsWith('IdentityFile ~/.ssh/id_new')).toBe(true)
  })

  it('removes a field line when the value is cleared', () => {
    const doc = parseConfigDocument('Host a\n  HostName h\n  Port 2222\n  User u\n')
    const { text } = editHost(doc, { alias: 'a', port: null })
    expect(text).not.toContain('Port')
    expect(text).toContain('  HostName h')
  })

  it('edits only the first duplicate block and reports the rest', () => {
    const doc = parseConfigDocument('Host dup\nHostName first\n\nHost dup\nHostName second\n')
    const result = editHost(doc, { alias: 'dup', host: 'edited.example' })
    expect(result.duplicates).toHaveLength(1)
    expect(result.text).toContain('HostName edited.example')
    expect(result.text).toContain('HostName second')
  })

  it('refuses an unknown alias', () => {
    const doc = parseConfigDocument(SAMPLE)
    expect(() => editHost(doc, { alias: 'nope', port: 22 })).toThrow(SshConfigUnknownHostError)
  })

  it('preserves the document trailing newline and BOM', () => {
    const doc = parseConfigDocument('\uFEFFHost a\n  HostName h\n')
    const { text } = editHost(doc, { alias: 'a', user: 'u' })
    expect(text.startsWith('\uFEFF')).toBe(true)
    expect(text.endsWith('\n')).toBe(true)
  })
})

describe('appendHost', () => {
  it('appends a block at the end with a blank separator and no port 22 noise', () => {
    const doc = parseConfigDocument('Host a\n  HostName a.example\n')
    const text = appendHost(doc, { alias: 'new', host: 'new.example', port: 22, user: 'u' })
    expect(text.endsWith('Host new\n  HostName new.example\n  User u\n')).toBe(true)
    expect(text).toContain('Host a\n  HostName a.example\n\nHost new')
    expect(text).not.toContain('\n\n\n')
  })

  it('starts an empty file cleanly', () => {
    const text = appendHost(parseConfigDocument(''), { alias: 'only', host: 'h.example' })
    expect(text).toBe('Host only\n  HostName h.example\n')
  })
})

describe('deleteHost', () => {
  it('removes every duplicate block and leaves the rest intact', () => {
    const doc = parseConfigDocument('Host keep\nHostName k\n\nHost dup\nHostName d1\n\nHost dup\nHostName d2\n\nHost keep2\nHostName k2\n')
    const { text, removed } = deleteHost(doc, 'dup')
    expect(removed).toBe(2)
    expect(text).not.toContain('dup')
    expect(text).toContain('Host keep\nHostName k')
    expect(text).toContain('Host keep2\nHostName k2')
    expect(text).not.toContain('\n\n\n')
  })

  it('is a no-op for an unknown alias', () => {
    const doc = parseConfigDocument(SAMPLE)
    expect(deleteHost(doc, 'nope')).toEqual({ text: SAMPLE, removed: 0 })
  })
})

describe('writeConfigFile', () => {
  it('backs up the previous file and writes the new content atomically', async () => {
    const path = join(tempDir(), 'config')
    writeFileSync(path, SAMPLE)
    const result = await writeConfigFile(path, '# replaced\n', { expectedHash: contentHash(SAMPLE) })
    expect(result.backupPath).toBeDefined()
    expect(existsSync(result.backupPath!)).toBe(true)
    expect(readFileSync(result.backupPath!, 'utf8')).toBe(SAMPLE)
    expect(readFileSync(path, 'utf8')).toBe('# replaced\n')
  })

  it('refuses when the file changed since it was read', async () => {
    const path = join(tempDir(), 'config')
    writeFileSync(path, SAMPLE)
    writeFileSync(path, `${SAMPLE}\nHost late\n  HostName l\n`)
    await expect(writeConfigFile(path, '# replaced\n', { expectedHash: contentHash(SAMPLE) }))
      .rejects.toBeInstanceOf(SshConfigConflictError)
  })

  it('round-trips through the reader', async () => {
    const path = join(tempDir(), 'config')
    const doc = parseConfigDocument('Host a\n  HostName a.example\n')
    writeFileSync(path, 'Host a\n  HostName a.example\n')
    const { text } = editHost(doc, { alias: 'a', port: 2022 })
    await writeConfigFile(path, text)
    const reread = await readConfigDocument(path)
    expect(reread.blocks[0]?.props.port).toBe('2022')
    expect(reread.text).toContain('  HostName a.example')
  })
})
