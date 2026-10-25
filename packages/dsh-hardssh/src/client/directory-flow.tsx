/**
 * The directory-flow occupant replacing the native-only "Add workspace…"
 * interaction. When the operator clicks the native "Add workspace…" entry,
 * this component opens a small chooser with two options:
 *
 *  - "Local workspace": delegates to the host native directory chooser
 *    (`host.pickDirectory`) and hands the picked path back through the owner
 *    conversation — exactly the original behavior.
 *  - "SSH workspace": opens the SSH workspace creation dialog (pick a host,
 *    browse a remote directory, name it). On success it calls
 *    `onPicked(anchorPath)` so the host adopts the LOCAL ANCHOR directory as
 *    a normal workspace (the seams route that workspace remote by its anchor
 *    path). On cancel it calls `onCancel`.
 *
 * Occupancy: both directory-flow holes are `kind: 'single'`, so registering
 * here replaces the native-only occupant. That is intended — we restore the
 * native path ourselves via `pickDirectory`.
 *
 * @module dsh-hardssh/client/directory-flow
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
// Type-only: pulls the SlotMap augmentation (the directory-flow holes) from
// the ui-workspace package, plus the DirectoryFlowOwnerProps contract.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { LocalRoot, SshWorkspaceRecord } from '../protocol.ts'
import { tt } from './text.ts'
import css from './workspace.module.css'
import { CloudIcon, ComputerIcon, ArrowRightIcon, CheckIcon, ChevronRightIcon, ChevronUpIcon, FolderIcon, FolderPlusIcon, LocalRootIcon } from './icons.tsx'
import { checkLocalWorkspacePath } from './local-workspace-path.ts'

/** One directory row returned by the kernel's browse capability. */
interface LocalDirectoryEntry {
  /** Base name shown in a row (a root crumb carries its full path). */
  name: string
  /** Absolute host path. */
  path: string
  /** Hidden by the host platform convention. */
  hidden: boolean
}

/** One directory level plus its ancestry, as the browse capability reports it. */
interface LocalDirectoryListing {
  path: string
  home: string
  crumbs: LocalDirectoryEntry[]
  entries: LocalDirectoryEntry[]
  truncated: boolean
}

/** True when a browse call failed only because the host serves `native`. */
export function isNativeCapabilityError(error: unknown): boolean {
  const record = error as {
    rpcError?: { code?: unknown; details?: { capability?: unknown } }
    code?: unknown
    details?: { capability?: unknown }
  } | null
  const rpc = record?.rpcError ?? record
  return rpc?.code === 'directory-picker/unavailable' && rpc?.details?.capability === 'native'
}

/** Marker code for an old kernel with neither `listDirectory` nor `native`. */
export const NO_BROWSE_ERROR_CODE = 'dsh-hardssh/no-browse'

/** True when the injected browse adapter reported "no listing method". */
export function isNoBrowseError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === NO_BROWSE_ERROR_CODE
}

/** Marker code for a kernel whose browse backend cannot create directories. */
export const NO_CREATE_ERROR_CODE = 'dsh-hardssh/no-create-dir'

/** True when the injected browse adapter reported "no create method". */
export function isNoCreateError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === NO_CREATE_ERROR_CODE
}

/** Human-readable message from an RPC failure object or a plain error. */
function reasonText(reason: unknown): string {
  const record = reason as { rpcError?: { message?: unknown }; message?: unknown } | null
  const rpc = record?.rpcError
  if (rpc !== null && typeof rpc === 'object' && typeof rpc.message === 'string' && rpc.message !== '') {
    return rpc.message
  }
  if (reason instanceof Error) return reason.message
  return String(reason)
}

/** The injected face: host native picker + our workspace manager API. */
export interface DirectoryFlowInjected {
  /** Ask the local Host to open its native single-directory chooser. */
  pickDirectory: () => Promise<string | null>
  /** List one local directory level through the kernel's browse capability. */
  listLocalDir?: (path?: string) => Promise<LocalDirectoryListing>
  /** Create one local subdirectory through the kernel's browse capability. */
  createLocalDir?: (path: string, name: string) => Promise<string>
  /** Quick-jump roots for the local browser. */
  listLocalRoots?: () => Promise<LocalRoot[]>
  /** Create an SSH workspace (host API). */
  createSshWorkspace: (input: { title: string; alias: string; remoteRoot: string }) => Promise<SshWorkspaceRecord>
  /** List configured SSH hosts (host API). */
  listHosts: () => Promise<Array<{ alias: string; host: string; port: number; user: string }>>
  /** Create a new SSH host (dsh-ssh host store; auth is required). */
  createHost: (input: {
    alias: string
    host: string
    port?: number
    user: string
    auth: { kind: 'password'; password: string } | { kind: 'key'; keyPath: string; passphrase?: string }
  }) => Promise<{ alias: string; host: string; port: number; user: string }>
  /** Browse a remote directory (host API). */
  listRemoteDir: (alias: string, path?: string) => Promise<{ path: string; entries: Array<{ name: string; type: 'dir' | 'file' | 'other'; size: number; mtimeMs: number }> }>
  /** Create one directory inside a listed remote level (host API). */
  createRemoteDir?: (alias: string, path: string, name: string) => Promise<{ path: string }>
  /** Interactive SSH connection gate: host-key TOFU + session-password
   *  dialogs. Resolves true when the alias is connected (or the user
   *  cancelled the prompts). Used to retry browsing. */
  ensureConnected: (alias: string) => Promise<boolean>
}

/** The two entry choices after "Add workspace…". */
type Choice = 'menu' | 'ssh' | 'browsing' | 'picking-local' | 'local-browsing'

/** A resolved anchor rect for the dropdown. */
interface AnchorRect {
  top: number
  left: number
  bottom: number
  width: number
}

/** Labels the host "Add workspace…" entry can carry (zh / en). Covers the
 *  kernel's own `workspace.add` / `menu.addWorkspace` copy plus the
 *  "local workspace" wording used by newer/other surfaces, since the anchor is
 *  only a positioning hint (a miss falls back to the viewport corner). */
const ADD_WORKSPACE_LABELS = [
  '添加工作区',
  '添加本地工作区',
  '新建工作区',
  'Add workspace',
  'Add local workspace',
  'New workspace',
]

/**
 * Find the host "Add workspace…" trigger element. It is a button/menu item
 * rendered by ui-workspace; match by visible text (case-insensitive, label
 * may include "…"/suffix). Prefer the LEFT sidebar container
 * (`[data-pane="sidebar"]` or a class mentioning the workspace browser) —
 * the workspace list lives there — and fall back to a whole-document scan so
 * the empty-state hero trigger works too. To avoid anchoring under a
 * RIGHT-side surface (another plugin's panel), the document scan prefers a
 * match whose horizontal center is in the LEFT half of the viewport.
 */
function findAddWorkspaceTrigger(): AnchorRect | undefined {
  const matchText = (el: HTMLElement): boolean => {
    const text = el.textContent?.trim() ?? ''
    return ADD_WORKSPACE_LABELS.some((label) => text.includes(label))
  }
  const rectOf = (el: HTMLElement): AnchorRect | undefined => {
    const rect = el.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      return { top: rect.top, left: rect.left, bottom: rect.bottom, width: rect.width }
    }
    return undefined
  }

  // 1) Left sidebar container preferred.
  for (const root of document.querySelectorAll<HTMLElement>('[data-pane="sidebar"], [class*="workspaceBrowser"], [class*="sidebar"]')) {
    for (const el of root.querySelectorAll<HTMLElement>('button, [role="menuitem"], [role="option"], li')) {
      if (matchText(el)) {
        const rect = rectOf(el)
        if (rect !== undefined) return rect
      }
    }
  }

  // 2) Whole-document fallback; prefer a LEFT-half match.
  let fallback: AnchorRect | undefined
  for (const el of document.querySelectorAll<HTMLElement>('button, [role="menuitem"], [role="option"], li')) {
    if (!matchText(el)) continue
    const rect = rectOf(el)
    if (rect === undefined) continue
    const centerX = rect.left + rect.width / 2
    if (centerX < window.innerWidth / 2) return rect
    if (fallback === undefined) fallback = rect
  }
  return fallback
}

/**
 * The flow occupant. Each rising `open` edge shows the menu; the ref arms
 * once per open so re-renders (and an adoption keeping `open` true while
 * `busy`) never launch a second flow.
 */
export function DirectoryFlow(props: DirectoryFlowOwnerProps & DirectoryFlowInjected): ReactElement | null {
  const { open, busy, onPicked, onCancel, onError } = props
  const outcome = useRef(props)
  outcome.current = props
  const [choice, setChoice] = useState<Choice>('menu')
  const [host, setHost] = useState('')
  const [dirPath, setDirPath] = useState('')
  const [title, setTitle] = useState('')
  const [hosts, setHosts] = useState<Array<{ alias: string; host: string; port: number; user: string }>>([])
  const [dirEntries, setDirEntries] = useState<Array<{ name: string; type: 'dir' | 'file' | 'other'; size: number; mtimeMs: number }>>([])
  const [localListing, setLocalListing] = useState<LocalDirectoryListing | null>(null)
  const [localPathInput, setLocalPathInput] = useState('')
  const [localRoots, setLocalRoots] = useState<LocalRoot[]>([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Local browser: inline "new folder" composer (Android hosts have no OS
  // dialog for it, and the browse capability exposes createDirectory).
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [newFolderError, setNewFolderError] = useState<string | null>(null)
  const [newFolderBusy, setNewFolderBusy] = useState(false)
  const [createdName, setCreatedName] = useState<string | null>(null)
  // SSH browser: same inline composer, kept separate so switching between the
  // local and SSH branches never leaks a half-typed name into the other.
  const [remoteNewFolderOpen, setRemoteNewFolderOpen] = useState(false)
  const [remoteNewFolderName, setRemoteNewFolderName] = useState('')
  const [remoteNewFolderError, setRemoteNewFolderError] = useState<string | null>(null)
  const [remoteNewFolderBusy, setRemoteNewFolderBusy] = useState(false)
  const [remoteCreatedName, setRemoteCreatedName] = useState<string | null>(null)
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  const remoteRowRefs = useRef(new Map<string, HTMLButtonElement>())
  const [anchor, setAnchor] = useState<AnchorRect | undefined>(undefined)
  // "Add server…" mini-form inside the SSH branch.
  const [addingHost, setAddingHost] = useState(false)
  const [newHost, setNewHost] = useState({ alias: '', host: '', port: '22', user: '', password: '' })
  const [savingHost, setSavingHost] = useState(false)
  const openRef = useRef(open)
  openRef.current = open
  const localPickRequestSequence = useRef(0)
  const hostsRequestSequence = useRef(0)
  const directoryRequestSequence = useRef(0)
  const createWorkspaceRequestSequence = useRef(0)
  const createHostRequestSequence = useRef(0)

  // The panel geometry (top / menuHeight) derives from window.innerHeight
  // inside the render. A soft keyboard opening, a rotation or a split-screen
  // resize would otherwise leave a stale height behind and push the footer
  // (and the new-folder input) below the visible viewport. Bump a render epoch
  // so the derived geometry is recomputed; the local browser's flexible list
  // then absorbs the difference.
  const [, setViewportEpoch] = useState(0)
  useEffect(() => {
    if (!open) return
    const onResize = (): void => setViewportEpoch((value) => value + 1)
    window.addEventListener('resize', onResize)
    window.visualViewport?.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.visualViewport?.removeEventListener('resize', onResize)
    }
  }, [open])

  // Reset and re-locate on each open edge. Every async data source owns a
  // request sequence; cleanup invalidates outstanding work from this opening.
  useEffect(() => {
    if (!open) return
    setChoice('menu')
    setHost('')
    setDirPath('')
    setTitle('')
    setDirEntries([])
    setLocalListing(null)
    setLocalPathInput('')
    setLocalRoots([])
    setLoading(false)
    setCreating(false)
    setSavingHost(false)
    setError(null)
    setNewFolderOpen(false)
    setNewFolderName('')
    setNewFolderError(null)
    setNewFolderBusy(false)
    setCreatedName(null)
    setRemoteNewFolderOpen(false)
    setRemoteNewFolderName('')
    setRemoteNewFolderError(null)
    setRemoteNewFolderBusy(false)
    setRemoteCreatedName(null)
    setAddingHost(false)
    setNewHost({ alias: '', host: '', port: '22', user: '', password: '' })
    setAnchorRect()
    // Lazy-load the host list for the SSH branch. A later refresh (for
    // example after adding a host) supersedes this request.
    const request = ++hostsRequestSequence.current
    // A synchronous throw here (missing injected dep) must not break the menu
    // render: the SSH branch then degrades to "no hosts", the local branch and
    // Cancel stay usable.
    try {
      void props.listHosts().then(
        (list) => {
          if (request === hostsRequestSequence.current && openRef.current) setHosts(list)
        },
        () => {
          if (request === hostsRequestSequence.current && openRef.current) setHosts([])
        },
      )
    } catch {
      if (request === hostsRequestSequence.current && openRef.current) setHosts([])
    }
    return () => {
      localPickRequestSequence.current += 1
      hostsRequestSequence.current += 1
      directoryRequestSequence.current += 1
      createWorkspaceRequestSequence.current += 1
      createHostRequestSequence.current += 1
    }
  }, [open])

  // A successful create lands in the refreshed listing: scroll the new row
  // into view and flash it so the operator sees what was created. The effect
  // re-runs when the re-listed level arrives (a name the host sorted away or
  // truncated simply never flashes).
  useEffect(() => {
    if (createdName === null) return
    const row = rowRefs.current.get(createdName)
    if (row !== undefined && typeof row.scrollIntoView === 'function') {
      try {
        row.scrollIntoView({ block: 'nearest' })
      } catch {
        /* jsdom and some older webviews do not implement smooth scrolling */
      }
    }
  }, [createdName, localListing])

  useEffect(() => {
    if (createdName === null) return
    const timer = window.setTimeout(() => setCreatedName(null), 2200)
    return () => window.clearTimeout(timer)
  }, [createdName])

  // Same reveal/flash contract for a directory created on the SSH host.
  useEffect(() => {
    if (remoteCreatedName === null) return
    const row = remoteRowRefs.current.get(remoteCreatedName)
    if (row !== undefined && typeof row.scrollIntoView === 'function') {
      try {
        row.scrollIntoView({ block: 'nearest' })
      } catch {
        /* jsdom and some older webviews do not implement smooth scrolling */
      }
    }
  }, [remoteCreatedName, dirEntries])

  useEffect(() => {
    if (remoteCreatedName === null) return
    const timer = window.setTimeout(() => setRemoteCreatedName(null), 2200)
    return () => window.clearTimeout(timer)
  }, [remoteCreatedName])

  // Leaving either browser retires its inline composer with it.
  useEffect(() => {
    if (choice === 'local-browsing') return
    setNewFolderOpen(false)
    setNewFolderError(null)
  }, [choice])

  useEffect(() => {
    if (choice === 'browsing') return
    setRemoteNewFolderOpen(false)
    setRemoteNewFolderError(null)
  }, [choice])

  /** Locate the trigger element that just opened the flow and anchor the menu
   *  directly under it. Priority: the focused element (the button the operator
   *  just clicked → document.activeElement), then a text-scan for the "Add
   *  workspace…" entry. Falls back to top-left of the viewport. */
  const setAnchorRect = (): void => {
    // 1) The element that had focus when `open` flipped true is almost
    //    always the trigger button (the owner sets open on click).
    const active = document.activeElement as HTMLElement | null
    if (active !== null && active !== document.body) {
      const rect = active.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        setAnchor({ top: rect.top, left: rect.left, bottom: rect.bottom, width: rect.width })
        return
      }
    }
    // 2) Text-scan fallback.
    const trigger = findAddWorkspaceTrigger()
    if (trigger !== undefined) {
      setAnchor(trigger)
      return
    }
    // 3) Last resort: top-left of the viewport.
    setAnchor({ top: 56, left: 16, bottom: 56, width: 200 })
  }

  // Close when a click lands OUTSIDE the dropdown (no full-screen capture
  // layer, so the trigger button and the rest of the UI stay clickable).
  const menuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const onMouseDown = (event: MouseEvent): void => {
      if (menuRef.current !== null && menuRef.current.contains(event.target as Node)) return
      if (!busy) outcome.current.onCancel()
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open, busy])

  if (!open) return null

  /** Surface a failure where the operator can see it. The kernel owner's
   *  `onError` opens its folder-error modal; a standalone mount without that
   *  callback keeps the message inside the dropdown instead of going silent. */
  const reportFailure = (reason: unknown): void => {
    const message = reason instanceof Error ? reason.message : String(reason)
    const onError = outcome.current.onError
    if (typeof onError === 'function') {
      onError(message)
      return
    }
    setError(message)
  }

  /**
   * Choose "Local workspace": drive the kernel's native chooser once.
   *
   * `props.pickDirectory` is wrapped in `Promise.resolve().then(...)` on
   * purpose: a synchronous throw (the 0.1.5 kernel renamed the picker service,
   * so the old call threw `TypeError: …pickDirectory is not a function`) used
   * to escape the click handler and leave the menu body empty. Converting it
   * into a rejection routes it through the same visible error path.
   */
  /** Map a path-policy failure onto the operator-facing copy. */
  const localPathProblem = (path: string): string | null => {
    const checked = checkLocalWorkspacePath(path)
    if (checked.ok) return null
    return tt(
      checked.problem === 'filesystem-root' ? 'flow.rootPath'
        : checked.problem === 'not-absolute' ? 'flow.relativePath'
          : 'flow.emptyPath',
    )
  }

  /**
   * Commit one local directory. `keepOpen` distinguishes the in-app browser
   * (show the reason inline and let the operator navigate elsewhere) from the
   * native chooser (re-arm the menu and report through the owner).
   */
  const commitLocalPath = (path: string, keepOpen: boolean): void => {
    const problem = localPathProblem(path)
    if (problem !== null) {
      if (keepOpen) {
        setError(problem)
      } else {
        setChoice('menu')
        reportFailure(new Error(problem))
      }
      return
    }
    const checked = checkLocalWorkspacePath(path)
    if (checked.ok) outcome.current.onPicked(checked.path)
  }

  /** Drive the kernel's native chooser (desktop). */
  const pickNativeLocal = (request: number): void => {
    Promise.resolve()
      .then(() => props.pickDirectory())
      .then(
        (path) => {
          if (request !== localPickRequestSequence.current || !openRef.current) return
          if (path === null || path === undefined) {
            outcome.current.onCancel()
            return
          }
          commitLocalPath(path, false)
        },
        (reason: unknown) => {
          if (request !== localPickRequestSequence.current || !openRef.current) return
          // Re-arm the menu so the operator can retry or choose the SSH branch.
          setChoice('menu')
          reportFailure(reason)
        },
      )
  }

  /** Load the host's quick-jump roots (best effort; the browser stays usable). */
  const loadLocalRoots = (request: number): void => {
    if (props.listLocalRoots === undefined) return
    void props.listLocalRoots().then(
      (roots) => {
        if (request === localPickRequestSequence.current && openRef.current) setLocalRoots(roots)
      },
      () => undefined,
    )
  }

  /**
   * Choose "Local workspace": probe the kernel capability first.
   *
   * 0.2.x hosts serve exactly one of `native` (one OS chooser) or `browse`
   * (listing primitives). Android is always browse, so calling the native
   * `pickDirectory()` unconditionally is guaranteed to fail there. The probe
   * uses the browse verb and falls back to native only when the host reports
   * that it serves the native capability.
   */
  const pickLocal = (): void => {
    const request = ++localPickRequestSequence.current
    setChoice('local-browsing')
    setLocalListing(null)
    setLocalPathInput('')
    setError(null)
    if (props.listLocalDir === undefined) {
      setChoice('picking-local')
      pickNativeLocal(request)
      return
    }
    setLoading(true)
    void Promise.resolve()
      .then(() => props.listLocalDir!(undefined))
      .then(
        (listing) => {
          if (request !== localPickRequestSequence.current || !openRef.current) return
          setLoading(false)
          setLocalListing(listing)
          setLocalPathInput(listing.path)
          loadLocalRoots(request)
        },
        (reason: unknown) => {
          if (request !== localPickRequestSequence.current || !openRef.current) return
          setLoading(false)
          if (isNativeCapabilityError(reason) || isNoBrowseError(reason)) {
            setChoice('picking-local')
            pickNativeLocal(request)
            return
          }
          setChoice('menu')
          reportFailure(reason)
        },
      )
  }

  /** Browse one local directory level through the kernel browse capability. */
  const browseLocal = async (path?: string): Promise<void> => {
    if (props.listLocalDir === undefined) {
      setError(tt('flow.noPicker'))
      return
    }
    const request = ++directoryRequestSequence.current
    setChoice('local-browsing')
    setLoading(true)
    setError(null)
    try {
      const listing = await props.listLocalDir(path)
      if (request !== directoryRequestSequence.current || !openRef.current) return
      setLocalListing(listing)
      setLocalPathInput(listing.path)
    } catch (reason: unknown) {
      if (request !== directoryRequestSequence.current || !openRef.current) return
      if (isNoBrowseError(reason)) {
        setError(tt('flow.noPicker'))
        return
      }
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(/EACCES|EPERM|permission denied/i.test(message)
        ? `${tt('flow.localDenied')}\n${message}`
        : message)
    } finally {
      if (request === directoryRequestSequence.current && openRef.current) setLoading(false)
    }
  }

  /** Commit the directory currently shown (or typed) in the local browser. */
  const useLocalDir = (): void => {
    const path = localPathInput.trim() === '' ? localListing?.path ?? '' : localPathInput
    commitLocalPath(path, true)
  }

  /** Close the inline new-folder composer without creating anything. */
  const closeNewFolder = (): void => {
    if (newFolderBusy) return
    setNewFolderOpen(false)
    setNewFolderName('')
    setNewFolderError(null)
  }

  /** Open the inline new-folder composer for the listed level. */
  const openNewFolder = (): void => {
    if (localListing === null || props.createLocalDir === undefined) return
    setNewFolderName('')
    setNewFolderError(null)
    setNewFolderOpen(true)
  }

  /**
   * Create the named folder inside the LISTED level (not the typed draft) and
   * re-list it, flashing the new row.
   *
   * Validation mirrors what the host rejects anyway, but happens inline so the
   * operator gets immediate copy instead of an RPC failure. A kernel whose
   * browse backend has no create verb surfaces `flow.newFolderNoService`
   * through the `dsh-hardssh/no-create-dir` marker.
   */
  const confirmNewFolder = async (): Promise<void> => {
    if (newFolderBusy) return
    const name = newFolderName.trim()
    if (name === '') {
      setNewFolderError(tt('flow.newFolderNeedName'))
      return
    }
    if (/[\\/]/.test(name) || name === '.' || name === '..') {
      setNewFolderError(tt('flow.newFolderInvalidName'))
      return
    }
    const parent = localListing?.path
    if (parent === undefined) {
      setNewFolderError(tt('flow.emptyPath'))
      return
    }
    if (props.createLocalDir === undefined) {
      setNewFolderError(tt('flow.newFolderNoService'))
      return
    }
    setNewFolderBusy(true)
    setNewFolderError(null)
    try {
      await props.createLocalDir(parent, name)
    } catch (reason: unknown) {
      setNewFolderBusy(false)
      setNewFolderError(
        isNoCreateError(reason)
          ? tt('flow.newFolderNoService')
          : tt('flow.newFolderFailed', reasonText(reason)),
      )
      return
    }
    setNewFolderBusy(false)
    setNewFolderOpen(false)
    setNewFolderName('')
    setCreatedName(name)
    void browseLocal(parent)
  }

  /** Open the SSH browser's inline new-folder composer for the listed level. */
  const openRemoteNewFolder = (): void => {
    if (dirPath === '' || props.createRemoteDir === undefined) return
    setRemoteNewFolderName('')
    setRemoteNewFolderError(null)
    setRemoteNewFolderOpen(true)
  }

  /** Close the SSH new-folder composer without creating anything. */
  const closeRemoteNewFolder = (): void => {
    if (remoteNewFolderBusy) return
    setRemoteNewFolderOpen(false)
    setRemoteNewFolderName('')
    setRemoteNewFolderError(null)
  }

  /**
   * Create the named folder inside the LISTED remote level and re-list it.
   *
   * The same validation as the local composer runs inline (the route rejects
   * these anyway). A connection that needs a credential (host key / session
   * password) runs the interactive gate and retries, so a long browse session
   * whose pooled connection was reaped still creates without a raw error.
   */
  const confirmRemoteNewFolder = async (): Promise<void> => {
    if (remoteNewFolderBusy) return
    const name = remoteNewFolderName.trim()
    if (name === '') {
      setRemoteNewFolderError(tt('flow.newFolderNeedName'))
      return
    }
    if (/[\\/]/.test(name) || name === '.' || name === '..') {
      setRemoteNewFolderError(tt('flow.newFolderInvalidName'))
      return
    }
    const parent = dirPath
    if (parent === '') {
      setRemoteNewFolderError(tt('flow.emptyPath'))
      return
    }
    const createRemoteDir = props.createRemoteDir
    if (createRemoteDir === undefined) {
      setRemoteNewFolderError(tt('flow.newFolderNoService'))
      return
    }
    const request = ++directoryRequestSequence.current
    setRemoteNewFolderBusy(true)
    setRemoteNewFolderError(null)
    let created = false
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await createRemoteDir(host, parent, name)
          created = true
          break
        } catch (reason: unknown) {
          if (request !== directoryRequestSequence.current || !openRef.current) return
          const code = (reason as { code?: string })?.code
          const interactive = code === 'NEEDS_PASSWORD' || code === 'HOST_KEY_UNKNOWN' || code === 'HOST_KEY_MISMATCH'
          if (!interactive) {
            setRemoteNewFolderError(tt('flow.newFolderFailed', reasonText(reason)))
            return
          }
          const connected = await props.ensureConnected(host)
          if (request !== directoryRequestSequence.current || !openRef.current) return
          if (!connected) return // user cancelled the credential prompts
        }
      }
      if (!created) {
        setRemoteNewFolderError(tt('create.needConnect'))
        return
      }
      setRemoteNewFolderBusy(false)
      setRemoteNewFolderOpen(false)
      setRemoteNewFolderName('')
      setRemoteCreatedName(name)
      void browse(host, parent)
    } finally {
      if (request === directoryRequestSequence.current && openRef.current) setRemoteNewFolderBusy(false)
    }
  }

  /** Browse a remote dir level for the SSH branch. When the connection needs
   *  a credential (host key untrusted / session password), run the interactive
   *  gate first, then retry — the operator never sees a raw "connect" error. */
  const browse = async (alias: string, path?: string): Promise<void> => {
    const request = ++directoryRequestSequence.current
    if (alias === '') {
      setError(tt('create.needHost'))
      return
    }
    setLoading(true)
    setError(null)
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const result = await props.listRemoteDir(alias, path)
          if (request !== directoryRequestSequence.current || !openRef.current) return
          setDirPath(result.path)
          setDirEntries(result.entries)
          setChoice('browsing')
          return
        } catch (e: unknown) {
          if (request !== directoryRequestSequence.current || !openRef.current) return
          const code = (e as { code?: string })?.code
          const interactive = code === 'NEEDS_PASSWORD' || code === 'HOST_KEY_UNKNOWN' || code === 'HOST_KEY_MISMATCH'
          if (!interactive) {
            setError(e instanceof Error ? e.message : String(e))
            return
          }
          const connected = await props.ensureConnected(alias)
          if (request !== directoryRequestSequence.current || !openRef.current) return
          if (!connected) return // user cancelled
        }
      }
      if (request === directoryRequestSequence.current && openRef.current) setError(tt('create.needConnect'))
    } finally {
      if (request === directoryRequestSequence.current && openRef.current) setLoading(false)
    }
  }

  /** Create the SSH workspace; on success hand the anchor to the owner. */
  const createSsh = async (): Promise<void> => {
    if (host === '' || dirPath === '' || title.trim() === '') {
      setError(host === '' ? tt('create.needHost') : dirPath === '' ? tt('create.needDir') : tt('create.needTitle'))
      return
    }
    const request = ++createWorkspaceRequestSequence.current
    setCreating(true)
    setError(null)
    try {
      const record = await props.createSshWorkspace({ title: title.trim(), alias: host, remoteRoot: dirPath })
      if (request !== createWorkspaceRequestSequence.current || !openRef.current) return
      // The anchor is a REAL local dir (host workspace registration happens on
      // the server); adopt it so the host workspace list refreshes.
      outcome.current.onPicked(record.anchorPath)
    } catch (e: unknown) {
      if (request === createWorkspaceRequestSequence.current && openRef.current) {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      // Always reset for the active opening: the owner may keep the flow open
      // after onPicked (e.g. a host-side adoption error).
      if (request === createWorkspaceRequestSequence.current && openRef.current) setCreating(false)
    }
  }

  /** Save a newly-added SSH host, refresh the list, select it, and close the
   *  add-server form. The password is OPTIONAL at creation — adding never
   *  connects; the credential is asked when browsing/connecting starts. */
  const saveHost = async (): Promise<void> => {
    if (newHost.alias.trim() === '' || newHost.host.trim() === '' || newHost.user.trim() === '') {
      setError(tt('host.needFields'))
      return
    }
    const request = ++createHostRequestSequence.current
    setSavingHost(true)
    setError(null)
    try {
      const created = await props.createHost({
        alias: newHost.alias.trim(),
        host: newHost.host.trim(),
        port: Number.parseInt(newHost.port, 10) || 22,
        user: newHost.user.trim(),
        auth: { kind: 'password', password: newHost.password },
      })
      if (request !== createHostRequestSequence.current || !openRef.current) return
      const hostsRequest = ++hostsRequestSequence.current
      const list = await props.listHosts()
      if (
        request !== createHostRequestSequence.current
        || hostsRequest !== hostsRequestSequence.current
        || !openRef.current
      ) return
      setHosts(list)
      setHost(created.alias)
      setAddingHost(false)
      setNewHost({ alias: '', host: '', port: '22', user: '', password: '' })
    } catch (e: unknown) {
      if (request === createHostRequestSequence.current && openRef.current) {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (request === createHostRequestSequence.current && openRef.current) setSavingHost(false)
    }
  }

  // Position the dropdown under the trigger, clamped inside the viewport.
  // The "add server" mini-form is taller — give it room so nothing clips.
  const menuWidth = choice === 'menu' ? 200 : 360
  const menuHeight = choice === 'local-browsing'
    ? Math.min(460, window.innerHeight - 16)
    : choice === 'browsing'
      ? Math.min(440, window.innerHeight - 16)
      : addingHost ? Math.min(560, window.innerHeight - 16) : 320
  const rawTop = anchor !== undefined ? anchor.bottom + 4 : 56
  const rawLeft = anchor !== undefined ? anchor.left : Math.max(8, window.innerWidth - menuWidth - 8)
  const top = Math.max(8, Math.min(rawTop, window.innerHeight - menuHeight - 8))
  const left = Math.max(8, Math.min(rawLeft, window.innerWidth - menuWidth - 8))

  /** Localized label for one quick-jump root kind. */
  const localRootLabel = (kind: LocalRoot['kind']): string => {
    switch (kind) {
      case 'home': return tt('flow.root.home')
      case 'app-data': return tt('flow.root.app-data')
      case 'documents': return tt('flow.root.documents')
      case 'storage': return tt('flow.root.storage')
      case 'downloads': return tt('flow.root.downloads')
    }
  }

  const localCrumbParent = localListing !== null && localListing.crumbs.length >= 2
    ? localListing.crumbs[localListing.crumbs.length - 2].path
    : undefined

  // The local browser is a fixed-height column (title + chips + list + footer)
  // so the list scrolls internally and the actions stay visible on a phone.
  const localBrowsing = choice === 'local-browsing'
  // Navigation is inert while a listing is in flight or the folder composer
  // owns the keyboard; the name input itself stays enabled.
  const navLocked = loading || newFolderOpen || newFolderBusy

  return createPortal(
    <div
      ref={menuRef}
      className={localBrowsing ? `${css.menuDropdown} ${css.menuDropdownPicker}` : css.menuDropdown}
      data-ssh-workspace-flow-menu=""
      role="menu"
      style={{
        top,
        left,
        width: menuWidth,
        maxHeight: menuHeight,
        height: localBrowsing ? menuHeight : undefined,
        overflowY: 'auto',
      }}
      onClick={(event) => event.stopPropagation()}
    >
      {error !== null && <div className={css.dialogFail}>{error}</div>}

        {choice === 'menu' && (
          <>
            <button
              type="button"
              className={css.menuItem}
              role="menuitem"
              disabled={busy}
              onClick={pickLocal}
            >
              <span className={css.menuItemIcon}><ComputerIcon size={14} /></span>
              <span>{tt('flow.local')}</span>
            </button>
            <button
              type="button"
              className={css.menuItem}
              role="menuitem"
              disabled={busy}
              onClick={() => setChoice('ssh')}
            >
              <span className={css.menuItemIcon}><CloudIcon size={14} /></span>
              <span>{tt('flow.ssh')}</span>
            </button>
            <div className={css.menuDivider} />
            <button
              type="button"
              className={css.menuItem}
              role="menuitem"
              onClick={() => outcome.current.onCancel()}
            >
              <span>{tt('create.cancel')}</span>
            </button>
          </>
        )}

        {choice === 'ssh' && (
          <div className={css.dialogGrid}>
            {addingHost ? (
              <>
                <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <label className={css.field}>
                    <span>{tt('dialog.alias')}</span>
                    <input value={newHost.alias} onChange={(e) => setNewHost((p) => ({ ...p, alias: e.target.value }))} placeholder="my-server" spellCheck={false} />
                  </label>
                  <label className={css.field}>
                    <span>{tt('dialog.host')}</span>
                    <input value={newHost.host} onChange={(e) => setNewHost((p) => ({ ...p, host: e.target.value }))} placeholder="1.2.3.4" spellCheck={false} />
                  </label>
                  <label className={css.field}>
                    <span>{tt('dialog.port')}</span>
                    <input value={newHost.port} onChange={(e) => setNewHost((p) => ({ ...p, port: e.target.value }))} inputMode="numeric" spellCheck={false} />
                  </label>
                  <label className={css.field}>
                    <span>{tt('dialog.user')}</span>
                    <input value={newHost.user} onChange={(e) => setNewHost((p) => ({ ...p, user: e.target.value }))} placeholder="root" spellCheck={false} />
                  </label>
                  <label className={css.field} style={{ gridColumn: '1 / -1' }}>
                    <span>{tt('dialog.password')}</span>
                    <input type="password" value={newHost.password} onChange={(e) => setNewHost((p) => ({ ...p, password: e.target.value }))} spellCheck={false} />
                    <span className={css.hostMeta}>{tt('dialog.passwordHint')}</span>
                  </label>
                </div>
                <div className={css.dialogActions} style={{ gridColumn: '1 / -1' }}>
                  <button type="button" className={css.button} onClick={() => setAddingHost(false)} disabled={savingHost}>{tt('create.cancel')}</button>
                  <button type="button" className={`${css.button} ${css.buttonPrimary}`} onClick={() => void saveHost()} disabled={savingHost}>
                    {savingHost ? tt('create.connecting') : tt('host.save')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <label className={css.field} style={{ gridColumn: '1 / -1' }}>
                  <span>{tt('create.host')}</span>
                  <select value={host} disabled={loading} onChange={(event) => setHost(event.target.value)}>
                    <option value="">{hosts.length === 0 ? tt('create.hostEmpty') : '—'}</option>
                    {hosts.map((item) => (
                      <option key={item.alias} value={item.alias}>{item.alias} ({item.user}@{item.host}:{item.port})</option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className={css.menuItem}
                  style={{ gridColumn: '1 / -1', padding: '5px 8px' }}
                  disabled={loading}
                  onClick={() => setAddingHost(true)}
                >
                  <span className={css.menuItemIcon}>＋</span>
                  <span>{tt('host.add')}</span>
                </button>
                <label className={css.field} style={{ gridColumn: '1 / -1' }}>
                  <span>{tt('create.dir')}</span>
                  <input value={dirPath} disabled={loading} onChange={(event) => setDirPath(event.target.value)} placeholder={tt('create.dirPlaceholder')} spellCheck={false} />
                </label>
                <div className={css.dialogActions} style={{ gridColumn: '1 / -1' }}>
                  <button type="button" className={css.button} data-test="remote-browse" disabled={busy || loading} onClick={() => void browse(host)}>
                    {loading ? tt('create.connecting') : tt('create.browse')}
                  </button>
                </div>
                <label className={css.field} style={{ gridColumn: '1 / -1' }}>
                  <span>{tt('create.titleLabel')}</span>
                  <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={tt('create.titlePlaceholder')} spellCheck={false} />
                </label>
              </>
            )}
            {!addingHost && (
              <div className={css.dialogActions} style={{ gridColumn: '1 / -1' }}>
                <button type="button" className={css.button} onClick={() => setChoice('menu')} disabled={busy || creating || loading}>{tt('create.cancel')}</button>
                <button type="button" className={`${css.button} ${css.buttonPrimary}`} disabled={busy || creating || loading} onClick={() => void createSsh()}>
                  {creating ? tt('create.connecting') : tt('create.submit')}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Local browse mode (Android always; any host whose directory
            picker serves the `browse` capability). The kernel's native
            chooser does not exist there, so the picker drives listing calls
            instead of pretending the missing capability is present. */}
        {choice === 'local-browsing' && (
          <div className={`${css.dialogGrid} ${css.localBrowser}`} data-test="local-browser">
            <div className={css.field}>
              <span className={css.localTitle}>
                <FolderIcon size={15} />
                <span>{tt('flow.localBrowse')}</span>
              </span>
              <div className={css.localPathRow}>
                <button
                  type="button"
                  className={css.localPathButton}
                  disabled={navLocked || localCrumbParent === undefined}
                  onClick={() => { if (localCrumbParent !== undefined) void browseLocal(localCrumbParent) }}
                >
                  <ChevronUpIcon size={14} />
                  <span>{tt('flow.localUp')}</span>
                </button>
                <input
                  className={css.localPathInput}
                  data-test="local-path"
                  value={localPathInput}
                  disabled={navLocked}
                  spellCheck={false}
                  placeholder="/storage/emulated/0/Documents"
                  onChange={(event) => setLocalPathInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void browseLocal(localPathInput.trim() === '' ? undefined : localPathInput.trim())
                    }
                  }}
                />
                <button
                  type="button"
                  className={css.localPathButton}
                  disabled={navLocked}
                  onClick={() => void browseLocal(localPathInput.trim() === '' ? undefined : localPathInput.trim())}
                >
                  <span>{tt('flow.localOpen')}</span>
                  <ArrowRightIcon size={14} />
                </button>
              </div>
              <span className={css.localHint}>{tt('flow.localPathHint')}</span>
            </div>

            {localRoots.length > 0 && (
              <div className={css.localChips}>
                {localRoots.map((root) => (
                  <button
                    key={`${root.kind}:${root.path}`}
                    type="button"
                    className={css.localChip}
                    disabled={navLocked}
                    title={root.path}
                    onClick={() => void browseLocal(root.path)}
                  >
                    <LocalRootIcon kind={root.kind} size={13} />
                    <span>{localRootLabel(root.kind)}</span>
                  </button>
                ))}
              </div>
            )}

            {localListing !== null && localListing.crumbs.length > 0 && (
              <div className={css.localCrumbs}>
                {localListing.crumbs.slice(-4).map((crumb, index) => (
                  <span key={`${crumb.path}:${crumb.name}`} className={css.localCrumbSeat}>
                    {index > 0 && <ChevronRightIcon size={10} className={css.localCrumbSep} />}
                    <button
                      type="button"
                      className={css.localCrumb}
                      disabled={navLocked}
                      title={crumb.path}
                      onClick={() => void browseLocal(crumb.path)}
                    >
                      {crumb.name === '' ? crumb.path : crumb.name}
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className={css.localList}>
              {loading && <div className={css.dialogInfo} role="status">{tt('flow.localLoading')}</div>}
              {!loading && localListing !== null && localListing.entries.length === 0 && (
                <div className={css.dialogInfo}>{tt('flow.localEmpty')}</div>
              )}
              {!loading && localListing?.entries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  data-entry-name={entry.name}
                  className={entry.name === createdName ? `${css.localRow} ${css.localRowCreated}` : css.localRow}
                  disabled={navLocked}
                  ref={(el) => {
                    if (el === null) rowRefs.current.delete(entry.name)
                    else rowRefs.current.set(entry.name, el)
                  }}
                  onClick={() => void browseLocal(entry.path)}
                >
                  <FolderIcon size={16} className={css.localRowIcon} />
                  <span className={css.localRowName}>{entry.name}</span>
                  <ChevronRightIcon size={12} className={css.localRowChevron} />
                </button>
              ))}
              {!loading && localListing?.truncated === true && (
                <div className={css.localHint}>{tt('flow.localTruncated')}</div>
              )}
            </div>

            {newFolderError !== null && (
              <div className={css.dialogFail} role="alert">{newFolderError}</div>
            )}

            <div className={css.localFooter}>
              {newFolderOpen ? (
                <>
                  <input
                    className={css.localNameInput}
                    data-test="local-new-name"
                    autoFocus
                    value={newFolderName}
                    disabled={newFolderBusy}
                    spellCheck={false}
                    placeholder={tt('flow.newFolderName')}
                    aria-label={tt('flow.newFolderName')}
                    onChange={(event) => {
                      setNewFolderName(event.target.value)
                      setNewFolderError(null)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void confirmNewFolder()
                      }
                      if (event.key === 'Escape') {
                        event.stopPropagation()
                        closeNewFolder()
                      }
                    }}
                  />
                  <button
                    type="button"
                    className={css.button}
                    disabled={newFolderBusy}
                    onClick={closeNewFolder}
                  >
                    {tt('create.cancel')}
                  </button>
                  <button
                    type="button"
                    className={`${css.button} ${css.buttonPrimary}`}
                    data-test="local-new-create"
                    disabled={newFolderBusy || newFolderName.trim() === ''}
                    onClick={() => void confirmNewFolder()}
                  >
                    {newFolderBusy ? tt('flow.newFolderCreating') : tt('flow.newFolderCreate')}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className={`${css.button} ${css.localNewFolder}`}
                    data-test="local-new-folder"
                    disabled={navLocked || localListing === null || props.createLocalDir === undefined}
                    onClick={openNewFolder}
                  >
                    <FolderPlusIcon size={14} />
                    <span>{tt('flow.newFolder')}</span>
                  </button>
                  <span className={css.localFooterSpacer} />
                  <button type="button" className={css.button} disabled={navLocked} onClick={() => setChoice('menu')}>
                    {tt('create.cancel')}
                  </button>
                  <button
                    type="button"
                    className={`${css.button} ${css.buttonPrimary}`}
                    data-test="local-use"
                    disabled={busy || navLocked || (localListing === null && localPathInput.trim() === '')}
                    onClick={useLocalDir}
                  >
                    <CheckIcon size={14} />
                    <span>{tt('flow.useThisDir')}</span>
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {/* The native picker is open (or its service is missing and the
            failure is being reported). Rendering this state explicitly is the
            point: without it the dropdown showed an EMPTY white strip while
            waiting — the symptom "点击后没有任何反应". */}
        {choice === 'picking-local' && (
          <div className={css.dialogGrid}>
            <div className={css.dialogInfo} role="status">{tt('flow.picking')}</div>
            <div className={css.dialogActions}>
              <button type="button" className={css.button} onClick={() => outcome.current.onCancel()}>
                {tt('create.cancel')}
              </button>
            </div>
          </div>
        )}

        {choice === 'browsing' && (
          <div className={css.dialogGrid} data-test="remote-browser" style={{ gridTemplateColumns: '1fr' }}>
            <div className={css.field} style={{ gridColumn: '1' }}>
              <span>{tt('create.browse')} · {host}</span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  type="button"
                  className={css.button}
                  data-test="remote-up"
                  disabled={loading || remoteNewFolderOpen || dirPath === '/'}
                  onClick={() => {
                    const parent = dirPath.split('/').slice(0, -1).join('/') || '/'
                    void browse(host, parent)
                  }}
                >
                  {tt('create.up')}
                </button>
                <span className={css.hostMeta} style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{tt('create.current')}{dirPath}</span>
              </div>
            </div>
            <div style={{ gridColumn: '1', maxHeight: 240, overflow: 'auto', border: '1px solid var(--aion-border, rgba(128,128,128,0.25))', borderRadius: 8, padding: 6 }}>
              {loading && <div className={css.dialogInfo}>{tt('create.connecting')}</div>}
              {dirEntries.filter((entry) => entry.type === 'dir').map((entry) => (
                <button
                  key={entry.name}
                  type="button"
                  data-entry-name={entry.name}
                  className={entry.name === remoteCreatedName ? `${css.hostRow} ${css.localRowCreated}` : css.hostRow}
                  disabled={loading || remoteNewFolderOpen || remoteNewFolderBusy}
                  ref={(el) => {
                    if (el === null) remoteRowRefs.current.delete(entry.name)
                    else remoteRowRefs.current.set(entry.name, el)
                  }}
                  style={{ width: '100%', textAlign: 'left', display: 'flex', gap: 6, alignItems: 'center', border: 'none', background: 'transparent', cursor: loading ? 'default' : 'pointer', padding: '4px 6px' }}
                  onClick={() => { void browse(host, `${dirPath.replace(/\/+$/, '')}/${entry.name}`) }}
                >
                  <FolderIcon size={16} />
                  <span className={css.hostAlias}>{entry.name}</span>
                </button>
              ))}
            </div>
            {remoteNewFolderError !== null && (
              <div className={css.dialogFail} role="alert">{remoteNewFolderError}</div>
            )}
            <div className={css.dialogActions} style={{ gridColumn: '1', flexWrap: 'wrap' }}>
              {remoteNewFolderOpen ? (
                <>
                  <input
                    className={css.localNameInput}
                    data-test="remote-new-name"
                    style={{ flex: '1 1 140px' }}
                    autoFocus
                    value={remoteNewFolderName}
                    disabled={remoteNewFolderBusy}
                    spellCheck={false}
                    placeholder={tt('flow.newFolderName')}
                    aria-label={tt('flow.newFolderName')}
                    onChange={(event) => {
                      setRemoteNewFolderName(event.target.value)
                      setRemoteNewFolderError(null)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void confirmRemoteNewFolder()
                      }
                      if (event.key === 'Escape') {
                        event.stopPropagation()
                        closeRemoteNewFolder()
                      }
                    }}
                  />
                  <button type="button" className={css.button} disabled={remoteNewFolderBusy} onClick={closeRemoteNewFolder}>
                    {tt('create.cancel')}
                  </button>
                  <button
                    type="button"
                    className={`${css.button} ${css.buttonPrimary}`}
                    data-test="remote-new-create"
                    disabled={remoteNewFolderBusy || remoteNewFolderName.trim() === ''}
                    onClick={() => void confirmRemoteNewFolder()}
                  >
                    {remoteNewFolderBusy ? tt('flow.newFolderCreating') : tt('flow.newFolderCreate')}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className={`${css.button} ${css.localNewFolder}`}
                    data-test="remote-new-folder"
                    disabled={loading || dirPath === '' || props.createRemoteDir === undefined}
                    onClick={openRemoteNewFolder}
                  >
                    <FolderPlusIcon size={14} />
                    <span>{tt('flow.newFolder')}</span>
                  </button>
                  <span className={css.localFooterSpacer} />
                  <button type="button" className={css.button} disabled={loading} onClick={() => setChoice('ssh')}>{tt('create.cancel')}</button>
                  <button type="button" className={`${css.button} ${css.buttonPrimary}`} disabled={loading} onClick={() => setChoice('ssh')}>
                    {tt('flow.useThisDir')}
                  </button>
                </>
              )}
            </div>
          </div>
        )}
    </div>,
    document.body,
  )
}