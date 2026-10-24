/**
 * Runtime platform facts shared by the SSH key and local-picker surfaces.
 *
 * Node running inside the Android app still reports `process.platform ===
 * 'linux'`, so the app injects `ANDROID_DATA` (and optionally
 * `DSH_ANDROID_USER_DATA`) to make the distinction explicit. The build.prop
 * probe keeps older/standalone runtimes working without the extra env.
 *
 * @module dsh-hardssh/platform
 */

import { existsSync } from 'node:fs'

/** True when this process runs inside the Android app runtime. */
export function isAndroidRuntime(): boolean {
  return process.env.ANDROID_DATA !== undefined
    || process.env.DSH_ANDROID_USER_DATA !== undefined
    || existsSync('/system/build.prop')
}

/**
 * The app-visible user-data root injected by the Android shell
 * (`/storage/emulated/0/Documents/dshdata` or the app-external fallback).
 * Undefined on desktop or when the probe could not resolve a public root.
 */
export function androidUserDataRoot(): string | undefined {
  const value = process.env.DSH_ANDROID_USER_DATA?.trim()
  return value === undefined || value === '' ? undefined : value
}
