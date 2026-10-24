#!/usr/bin/env node
/**
 * Load the built host entry exactly the way Node ESM does at runtime.
 *
 * Unit tests run through Vite's CJS interop, which turns named imports into
 * property access and therefore cannot catch a named-export mismatch in a
 * CommonJS dependency (ssh2's `utils` — broken in 0.2.8). This script imports
 * the real `lib/index.js` in a plain Node process and fails the build when the
 * entry cannot be instantiated.
 */
import { fileURLToPath } from 'node:url'

const entry = new URL('../lib/index.js', import.meta.url)
const mod = await import(entry.href)

if (typeof mod.apply !== 'function' && typeof mod.default !== 'function') {
  throw new Error(`${fileURLToPath(entry)} loaded but exports neither apply nor default`)
}

console.log(`plugin entry loads: ${fileURLToPath(entry)}`)
