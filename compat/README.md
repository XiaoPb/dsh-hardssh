# DSH compatibility sets

Each `dsh-*.json` here is one **coherent** set of `@deepseek-ai/*` versions to run
the plugin against. `scripts/compat/apply-set.mjs` applies a set to an ephemeral
checkout (devDependencies + a generated `overrides` block in `pnpm-workspace.yaml`,
since pnpm 11 no longer reads `pnpm.overrides` from package.json), which is exactly
what `.github/workflows/compat.yml` does per matrix leg.

Rules:

- A set is added only with evidence that `pnpm typecheck`, the test suite, the
  build and `npm pack` all pass against it.
- The declared `peerDependencies` range in `packages/dsh-hardssh/package.json`
  must not be wider than the sets that pass.
- `verified-incompatible-*.json` records a set that was tried and failed, so the
  failure is not re-litigated from scratch. It is NOT part of the CI matrix.

## Current state

| Set | Result |
|---|---|
| `dsh-0.1.5-rc.1.json` | ✅ passes (production-verified baseline) |
| `dsh-0.1.5-rc.2.json` | ✅ passes |
| `dsh-0.1.6-alpha.1.json` | ✅ passes |
| `dsh-0.1.6-alpha.2.json` | ✅ passes (current 0.1.6 line; components that do not publish `0.1.6-alpha.x` stay on `0.1.5-rc.2` — currently only `dsh-code-runtime`) |
| `dsh-0.2.1-rc.3.json` | ✅ passes (shipped Desktop build; `dsh-client-runtime` stays `0.1.1-rc.2`, `dsh-code-runtime` `0.1.5-rc.3`, `dsh-invariants` `0.2.0-rc.2`, the newest lines those packages publish) |
| `verified-incompatible-dsh-0.1.5-alpha.1.json` | ❌ `pnpm typecheck` fails |

### Why `0.1.5-alpha.*` stays unsupported

`@deepseek-ai/dsh-client-ui-slots@0.1.5-alpha.1` does not declare the `main`
slot, so the workspace manager panel registration is a type error:

```
Type '"main"' is not assignable to type
  '"root" | "conversation.session" | … | "sidebar.right.tab.menu.item"'
```

The center panel would therefore have nowhere to mount on that line; supporting
it would require a degraded slot-registration shim, which is not worth the
complexity for a pre-rc line. The supported range starts at `0.1.5-rc.1`.

### Range widening notes

- The declared peer range
  `>=0.1.5-rc.1 <0.1.7 || >=0.1.6-alpha.1 || >=0.2.1-rc.1`
  matches every passing set (including the shipped `0.2.1-rc.3`) plus stable
  `0.1.6`/`0.2.x`, and excludes `0.1.5-alpha.*`. The extra arms are required
  because semver only matches a prerelease candidate when some comparator shares
  its major.minor.patch tuple and carries a prerelease — a bare
  `>=0.1.5-rc.1 <0.1.7` silently excludes `0.1.6-alpha.x`, and without
  `>=0.2.1-rc.1` it silently excludes `0.2.1-rc.x` too.

Re-checking a set (or bumping the range) is a deliberate, evidence-backed
change: run the matrix locally before widening anything.

### The `0.2.1` line (shipped Desktop)

`dsh-0.2.1-rc.3.json` is the component line shipped by the current Desktop build
(`runtime/primary-runtime/runtime.json` → `desktopVersion: 0.2.1-rc.3`). It passes
`pnpm typecheck`, the default suite, the complete suite, the build and
`npm pack --dry-run`.

Two API changes were needed for it:

- `settings/updated(ns, next)` became `settings/document-updated(ns, revision)`.
  The drift watcher now detects `SettingsForms` (`describe`) and re-reads the
  section through `describe()`; 0.1.x keeps the old event and `get()` path.
- `SidebarRightGuideEntry` and `SubprocessHandle` gained required `id` / `control`
  members. Both are provided in a cross-version shape (0.1.5 ignores the extra
  field/member).

The browser half still takes its `ClientContext` type from
`@deepseek-ai/dsh-client-runtime`; that package stays on `0.1.1-rc.2` in the
0.2.1 set and is imported type-only (no runtime dependency).
