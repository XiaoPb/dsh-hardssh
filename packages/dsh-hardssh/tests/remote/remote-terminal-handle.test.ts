/**
 * The terminal-seam members DSH 0.2.0 added to `SubprocessTerminalHandle`.
 *
 * The sidebar terminal failed on attach with
 * `终端错误：this.handle.resize is not a function`: the controller's
 * `BrowserTerminal` resizes the PTY through the handle, and this plugin's SSH
 * handle was written against 0.1.x, which had no `resize` (nor
 * `inspectActivity`, which the controller's retention observer calls on every
 * terminal). Both are implemented here and pinned so the next line of the seam
 * cannot drop them silently.
 */
import { describe, expect, it, vi } from 'vitest'
import { SshTerminalHandle } from '../../src/remote/remote-terminal.ts'

/** A handle over recording channel callbacks. */
function handle(overrides: { resize?: (cols: number, rows: number) => void } = {}) {
  const resize = vi.fn(overrides.resize)
  const send = vi.fn()
  const signal = vi.fn()
  const close = vi.fn()
  const instance = new SshTerminalHandle(close, send, signal, resize, 1_000)
  return { instance, resize, send, signal, close }
}

describe('SshTerminalHandle.resize', () => {
  it('forwards the new dimensions to the PTY', async () => {
    const { instance, resize } = handle()
    await instance.resize(120, 40)
    expect(resize).toHaveBeenCalledWith(120, 40)
    instance.forceClose()
  })

  it('refuses after exit, like the official local provider', async () => {
    const { instance, resize } = handle()
    instance.topLevelExited = true
    await expect(instance.resize(80, 24)).rejects.toThrow(/exited/)
    expect(resize).not.toHaveBeenCalled()
  })

  it('surfaces a channel failure instead of swallowing it', async () => {
    const { instance } = handle({ resize: () => { throw new Error('channel gone') } })
    await expect(instance.resize(80, 24)).rejects.toThrow('channel gone')
    instance.forceClose()
  })
})

describe('SshTerminalHandle.inspectActivity', () => {
  it('reports unknown — never idle — while tracking the facts it does observe', async () => {
    const { instance } = handle()
    // A raw SSH PTY carries no prompt/job evidence: claiming `idle` would tell
    // the controller a command finished when nothing was observed.
    expect(await instance.inspectActivity()).toEqual({ state: 'unknown', revision: 0 })

    await instance.write('ls\n')
    const afterInput = await instance.inspectActivity()
    expect(afterInput.state).toBe('unknown')
    expect(afterInput.revision).toBeGreaterThan(0)

    await instance.resize(100, 30)
    expect((await instance.inspectActivity()).revision).toBeGreaterThan(afterInput.revision)
    instance.forceClose()
  })

  it('advances the revision on exit', async () => {
    const { instance } = handle()
    const before = (await instance.inspectActivity()).revision
    instance.resolveExit({ exitCode: 0, signal: null })
    expect((await instance.inspectActivity()).revision).toBeGreaterThan(before)
  })
})

describe('SshTerminalHandle.inspectForeground', () => {
  it('stays undefined — an SSH channel exposes no foreground group', async () => {
    const { instance } = handle()
    await expect(instance.inspectForeground()).resolves.toBeUndefined()
    instance.forceClose()
  })
})
