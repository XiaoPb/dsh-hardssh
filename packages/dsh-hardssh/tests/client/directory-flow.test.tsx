// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DirectoryFlow, isNativeCapabilityError, isNoCreateError, type DirectoryFlowInjected } from '../../src/client/directory-flow.tsx'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const host = (alias: string) => ({ alias, host: `${alias}.example`, port: 22, user: 'root' })

afterEach(() => {
  document.body.innerHTML = ''
})

describe('DirectoryFlow request sequencing', () => {
  it('ignores stale host/directory results and disables path-changing controls while browsing', async () => {
    const firstHosts = deferred<ReturnType<typeof host>[]>()
    const secondHosts = deferred<ReturnType<typeof host>[]>()
    const pendingDirectory = deferred<{ path: string; entries: [] }>()
    const listHosts = vi.fn()
      .mockReturnValueOnce(firstHosts.promise)
      .mockReturnValueOnce(secondHosts.promise)
      .mockResolvedValue([host('newest')])
    const listRemoteDir = vi.fn(() => pendingDirectory.promise)
    const injected: DirectoryFlowInjected = {
      pickDirectory: vi.fn(async () => null),
      createSshWorkspace: vi.fn(),
      listHosts,
      createHost: vi.fn(),
      listRemoteDir,
      ensureConnected: vi.fn(async () => true),
    }
    const callbacks = {
      busy: false,
      onPicked: vi.fn(),
      onCancel: vi.fn(),
      onError: vi.fn(),
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => { root.render(<DirectoryFlow open {...callbacks} {...injected} />) })
    await act(async () => { root.render(<DirectoryFlow open={false} {...callbacks} {...injected} />) })
    await act(async () => { root.render(<DirectoryFlow open {...callbacks} {...injected} />) })
    await act(async () => { secondHosts.resolve([host('newest')]) })
    await act(async () => { firstHosts.resolve([host('stale')]) })

    let menu = document.querySelector<HTMLElement>('[data-ssh-workspace-flow-menu]')!
    await act(async () => { menu.querySelectorAll<HTMLButtonElement>('button')[1].click() })
    let select = menu.querySelector<HTMLSelectElement>('select')!
    expect([...select.options].map(option => option.value)).toContain('newest')
    expect([...select.options].map(option => option.value)).not.toContain('stale')

    await act(async () => {
      select.value = 'newest'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    menu = document.querySelector<HTMLElement>('[data-ssh-workspace-flow-menu]')!
    const sshButtons = menu.querySelectorAll<HTMLButtonElement>('button')
    await act(async () => { sshButtons[1].click() })

    menu = document.querySelector<HTMLElement>('[data-ssh-workspace-flow-menu]')!
    select = menu.querySelector<HTMLSelectElement>('select')!
    const pathInput = menu.querySelectorAll<HTMLInputElement>('input')[0]
    expect(select.disabled).toBe(true)
    expect(pathInput.disabled).toBe(true)
    for (const button of menu.querySelectorAll<HTMLButtonElement>('button')) expect(button.disabled).toBe(true)

    // Closing invalidates the outstanding directory request. Its late result
    // must not leak into the next opening.
    await act(async () => { root.render(<DirectoryFlow open={false} {...callbacks} {...injected} />) })
    await act(async () => { root.render(<DirectoryFlow open {...callbacks} {...injected} />) })
    await act(async () => { pendingDirectory.resolve({ path: '/stale/path', entries: [] }) })
    menu = document.querySelector<HTMLElement>('[data-ssh-workspace-flow-menu]')!
    await act(async () => { menu.querySelectorAll<HTMLButtonElement>('button')[1].click() })
    expect(menu.querySelector<HTMLInputElement>('input')!.value).toBe('')
    expect(callbacks.onError).not.toHaveBeenCalled()

    await act(async () => { root.unmount() })
  })
})

/** Mount the flow open, with the given picker behaviour, and return helpers. */
async function mount(
  pickDirectory: DirectoryFlowInjected['pickDirectory'],
  withOnError = true,
  extra: Partial<DirectoryFlowInjected> = {},
) {
  const injected: DirectoryFlowInjected = {
    pickDirectory,
    createSshWorkspace: vi.fn(),
    listHosts: vi.fn(async () => []),
    createHost: vi.fn(),
    listRemoteDir: vi.fn(),
    ensureConnected: vi.fn(async () => true),
    ...extra,
  }
  const onError = vi.fn()
  const onPicked = vi.fn()
  const onCancel = vi.fn()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const props = {
    open: true,
    busy: false,
    onPicked,
    onCancel,
    ...(withOnError ? { onError } : {}),
  }
  await act(async () => { root.render(<DirectoryFlow {...props} {...injected} />) })
  const menu = () => document.querySelector<HTMLElement>('[data-ssh-workspace-flow-menu]')!
  return { root, menu, onError, onPicked, onCancel }
}

describe('DirectoryFlow local branch robustness', () => {
  it('shows a visible waiting state instead of an empty dropdown while the picker is open', async () => {
    const pending = deferred<string | null>()
    const { root, menu } = await mount(() => pending.promise)
    // First entry is "Local workspace…" (the reported click target).
    await act(async () => { menu().querySelectorAll<HTMLButtonElement>('button')[0].click() })
    // The regression: this used to render a zero-content white strip. Locale is
    // whatever the dictionary default is, so assert structure, not copy.
    expect(menu().querySelector('[role="status"]')).not.toBeNull()
    expect((menu().textContent ?? '').trim().length).toBeGreaterThan(0)
    await act(async () => { pending.resolve('/tmp/picked') })
    await act(async () => { root.unmount() })
  })

  it('surfaces a synchronous picker failure instead of swallowing it', async () => {
    // Exactly the shipped kernel bug: the service method did not exist, so the
    // call threw before returning a promise.
    const throwing = ((): Promise<string> => {
      throw new TypeError('ctx.workspaces.pickDirectory is not a function')
    }) as DirectoryFlowInjected['pickDirectory']
    const { root, menu, onError } = await mount(throwing)
    await act(async () => { menu().querySelectorAll<HTMLButtonElement>('button')[0].click() })
    expect(onError).toHaveBeenCalledTimes(1)
    expect(String(onError.mock.calls[0]?.[0])).toContain('pickDirectory is not a function')
    // The menu is re-armed rather than left in the empty waiting state.
    expect(menu().querySelector('[role="status"]')).toBeNull()
    expect(menu().querySelectorAll('button').length).toBeGreaterThanOrEqual(2)
    await act(async () => { root.unmount() })
  })

  it('keeps the message inside the dropdown when the owner provides no onError', async () => {
    const throwing = ((): Promise<string> => {
      throw new Error('no picker service')
    }) as DirectoryFlowInjected['pickDirectory']
    const { root, menu } = await mount(throwing, false)
    await act(async () => { menu().querySelectorAll<HTMLButtonElement>('button')[0].click() })
    expect(menu().textContent).toContain('no picker service')
    await act(async () => { root.unmount() })
  })

  it('refuses a filesystem root before the host stores an unopenable workspace', async () => {
    // Reported: a workspace created at C:\ can never open a session, because
    // the kernel's mkdir(cwd, {recursive:true}) gets EPERM on a drive root.
    const { root, menu, onError, onPicked } = await mount(async () => 'C:\\')
    await act(async () => { menu().querySelectorAll<HTMLButtonElement>('button')[0].click() })
    expect(onPicked).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(String(onError.mock.calls[0]?.[0])).toMatch(/root/i)
    await act(async () => { root.unmount() })
  })

  it('trims a trailing separator before handing the path to the owner', async () => {
    const { root, menu, onPicked } = await mount(async () => 'C:\\projects\\')
    await act(async () => { menu().querySelectorAll<HTMLButtonElement>('button')[0].click() })
    expect(onPicked).toHaveBeenCalledWith('C:\\projects')
    await act(async () => { root.unmount() })
  })

  it('treats a null result as a cancel, not as a pick', async () => {
    const { root, menu, onCancel, onPicked } = await mount(async () => null)
    await act(async () => { menu().querySelectorAll<HTMLButtonElement>('button')[0].click() })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onPicked).not.toHaveBeenCalled()
    await act(async () => { root.unmount() })
  })
})

describe('DirectoryFlow browse capability (Android / browse-only host)', () => {
  const flush = async (): Promise<void> => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }

  const listing = (path = '/storage/emulated/0') => ({
    path,
    home: '/data/user/0/app.dsh.mobile/files/dsh-home',
    crumbs: [{ name: '/', path: '/', hidden: false }, { name: path, path, hidden: false }],
    entries: [{ name: 'Documents', path: `${path}/Documents`, hidden: false }],
    truncated: false,
  })

  it('uses the kernel browse listing instead of calling the missing native picker', async () => {
    const listLocalDir = vi.fn(async () => listing())
    const pickDirectory = vi.fn(async () => '/native/should-not-run')
    const { root, menu, onPicked } = await mount(pickDirectory, true, {
      listLocalDir,
      listLocalRoots: async () => [{ kind: 'storage', path: '/storage/emulated/0' }],
    })

    await act(async () => { menu().querySelectorAll<HTMLButtonElement>('button')[0].click() })
    await flush()

    expect(menu().querySelector('[data-test="local-browser"]')).not.toBeNull()
    expect(pickDirectory).not.toHaveBeenCalled()
    expect(listLocalDir).toHaveBeenCalledWith(undefined)

    await act(async () => { menu().querySelector<HTMLButtonElement>('[data-test="local-use"]')!.click() })
    expect(onPicked).toHaveBeenCalledWith('/storage/emulated/0')
    await act(async () => { root.unmount() })
  })

  it('falls back to the native picker only when the host serves the native capability', async () => {
    const listLocalDir = vi.fn(async () => {
      throw { rpcError: { code: 'directory-picker/unavailable', details: { capability: 'native' } } }
    })
    const pickDirectory = vi.fn(async () => '/tmp/picked')
    const { root, menu, onPicked } = await mount(pickDirectory, true, { listLocalDir })

    await act(async () => { menu().querySelectorAll<HTMLButtonElement>('button')[0].click() })
    await flush()

    expect(listLocalDir).toHaveBeenCalledTimes(1)
    expect(pickDirectory).toHaveBeenCalledTimes(1)
    expect(onPicked).toHaveBeenCalledWith('/tmp/picked')
    await act(async () => { root.unmount() })
  })

  it('falls back to native on a legacy kernel without the browse verb', async () => {
    const listLocalDir = vi.fn(async () => {
      throw { code: 'dsh-hardssh/no-browse' }
    })
    const pickDirectory = vi.fn(async () => '/legacy/picked')
    const { root, menu, onPicked } = await mount(pickDirectory, true, { listLocalDir })

    await act(async () => { menu().querySelectorAll<HTMLButtonElement>('button')[0].click() })
    await flush()

    expect(pickDirectory).toHaveBeenCalledTimes(1)
    expect(onPicked).toHaveBeenCalledWith('/legacy/picked')
    await act(async () => { root.unmount() })
  })

  it('recognises only the native-capability refusal as a native fallback signal', () => {
    expect(isNativeCapabilityError({
      rpcError: { code: 'directory-picker/unavailable', details: { capability: 'native' } },
    })).toBe(true)
    expect(isNativeCapabilityError({
      rpcError: { code: 'directory-picker/unavailable', details: { capability: 'browse' } },
    })).toBe(false)
    expect(isNativeCapabilityError(new Error('EACCES'))).toBe(false)
    expect(isNativeCapabilityError(undefined)).toBe(false)
  })
})

describe('DirectoryFlow local new-folder composer', () => {
  const flush = async (): Promise<void> => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  }

  const level = (entries: Array<{ name: string; path: string; hidden: boolean }>) => ({
    path: '/data/home',
    home: '/data/home',
    crumbs: [{ name: '/', path: '/', hidden: false }, { name: 'data', path: '/data', hidden: false }],
    entries,
    truncated: false,
  })

  /** Drive the React-controlled folder name input with the native setter. */
  const typeName = async (menu: () => HTMLElement, value: string): Promise<void> => {
    const input = menu().querySelector<HTMLInputElement>('[data-test="local-new-name"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  const openLocal = async (menu: () => HTMLElement): Promise<void> => {
    await act(async () => { menu().querySelectorAll<HTMLButtonElement>('button')[0].click() })
    await flush()
  }

  it('creates in the listed level, re-lists it and reveals the new row', async () => {
    const before = level([{ name: 'old', path: '/data/home/old', hidden: false }])
    const after = level([
      { name: 'newdir', path: '/data/home/newdir', hidden: false },
      { name: 'old', path: '/data/home/old', hidden: false },
    ])
    const listLocalDir = vi.fn()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after)
    const createLocalDir = vi.fn(async () => '/data/home/newdir')
    const { root, menu } = await mount(async () => null, true, { listLocalDir, createLocalDir })

    await openLocal(menu)
    const newButton = menu().querySelector<HTMLButtonElement>('[data-test="local-new-folder"]')!
    expect(newButton.disabled).toBe(false)
    await act(async () => { newButton.click() })
    expect(menu().querySelector('[data-test="local-new-name"]')).not.toBeNull()

    await typeName(menu, 'newdir')
    const create = menu().querySelector<HTMLButtonElement>('[data-test="local-new-create"]')!
    expect(create.disabled).toBe(false)
    await act(async () => { create.click() })
    await flush()

    expect(createLocalDir).toHaveBeenCalledWith('/data/home', 'newdir')
    expect(listLocalDir).toHaveBeenLastCalledWith('/data/home')
    // The composer closed and the re-listed row is present (the flash class is
    // applied for 1.8s; asserting the row is enough without depending on CSS).
    expect(menu().querySelector('[data-test="local-new-name"]')).toBeNull()
    expect(menu().querySelector('[data-entry-name="newdir"]')).not.toBeNull()
    await act(async () => { root.unmount() })
  })

  it('rejects an invalid name locally and keeps the host out of it', async () => {
    const listLocalDir = vi.fn(async () => level([]))
    const createLocalDir = vi.fn(async () => '/data/home/x')
    const { root, menu } = await mount(async () => null, true, { listLocalDir, createLocalDir })
    await openLocal(menu)
    await act(async () => { menu().querySelector<HTMLButtonElement>('[data-test="local-new-folder"]')!.click() })

    await typeName(menu, 'bad/name')
    await act(async () => { menu().querySelector<HTMLButtonElement>('[data-test="local-new-create"]')!.click() })
    await flush()

    expect(createLocalDir).not.toHaveBeenCalled()
    expect(menu().querySelector('[role="alert"]')?.textContent).toContain('cannot contain')
    expect(menu().querySelector('[data-test="local-new-name"]')).not.toBeNull()
    await act(async () => { root.unmount() })
  })

  it('keeps the composer open and shows the host message when create fails', async () => {
    const listLocalDir = vi.fn(async () => level([]))
    const createLocalDir = vi.fn(async () => {
      throw { rpcError: { message: 'EEXIST: file already exists' } }
    })
    const { root, menu } = await mount(async () => null, true, { listLocalDir, createLocalDir })
    await openLocal(menu)
    await act(async () => { menu().querySelector<HTMLButtonElement>('[data-test="local-new-folder"]')!.click() })

    await typeName(menu, 'dupe')
    await act(async () => { menu().querySelector<HTMLButtonElement>('[data-test="local-new-create"]')!.click() })
    await flush()

    expect(createLocalDir).toHaveBeenCalledWith('/data/home', 'dupe')
    expect(menu().querySelector('[role="alert"]')?.textContent).toContain('EEXIST')
    expect(menu().querySelector('[data-test="local-new-name"]')).not.toBeNull()
    // No refresh on failure: only the initial listing call happened.
    expect(listLocalDir).toHaveBeenCalledTimes(1)
    await act(async () => { root.unmount() })
  })

  it('disables the action when the kernel exposes no create verb', async () => {
    const listLocalDir = vi.fn(async () => level([]))
    const { root, menu } = await mount(async () => null, true, { listLocalDir })
    await openLocal(menu)
    expect(menu().querySelector<HTMLButtonElement>('[data-test="local-new-folder"]')!.disabled).toBe(true)
    await act(async () => { root.unmount() })
  })

  it('recognises only the no-create marker as a missing capability', () => {
    expect(isNoCreateError({ code: 'dsh-hardssh/no-create-dir' })).toBe(true)
    expect(isNoCreateError({ code: 'dsh-hardssh/no-browse' })).toBe(false)
    expect(isNoCreateError(new Error('EEXIST'))).toBe(false)
    expect(isNoCreateError(undefined)).toBe(false)
  })
})
