# 2026-07-31 Fix workflow extension and add extension health check

## Summary

The `workflow` canvas extension was silently failing to load (13/14 extensions running),
disappearing from the UI with no user-facing error. Root cause: `yaml-reader.mjs` used
`createRequire` anchored at the worktree's `package.json`, which has no `node_modules` —
`yaml` and `zod` were unreachable in a git worktree environment.

Additionally, `registry-ids.mjs` (workflow) and `cli-bundle.mjs` (theme-equipment-review)
both used `await import('esbuild')` — bare ESM dynamic imports that are equally unreachable
in the extension sandbox.

## Fix

1. **Created `.github/extensions/shared/node-modules-resolver.mjs`** — shared helper that
   detects git worktrees by reading the `.git` file, follows the `gitdir:` pointer 3 levels
   up to the main checkout root, and returns a `createRequire` anchored at the main
   `package.json`. Used by all four affected files.

2. **Fixed `workflow/lib/yaml-reader.mjs`** — replaced `createRequire(worktreeRoot/package.json)`
   with `createRepoRequire()` from the shared helper.

3. **Fixed `workflow/lib/workflow-model.mjs`** — same pattern, also removed the inline
   duplicate `resolveNodeModules()` function.

4. **Fixed `workflow/lib/registry-ids.mjs`** — replaced `await import('esbuild')` with
   `_require('esbuild')` via the shared helper.

5. **Fixed `theme-equipment-review/lib/cli-bundle.mjs`** — replaced `await import('esbuild')`
   fallback with `_require('esbuild')` via the shared helper.

6. **Added `scripts/agent/health/check-extensions.mjs`** — lint guard that scans all non-test
   `.mjs` files under `.github/extensions/` for bare-specifier ESM imports not in
   `['node:', '@github/copilot-sdk']`. Exits 0 if clean, 1 if violations found.
   Wired into `package.json` as `check:extensions` and appended to `health:check`.

## Systems touched

extensions, tooling

## Files touched

- `.github/extensions/shared/node-modules-resolver.mjs` (new)
- `.github/extensions/workflow/lib/yaml-reader.mjs`
- `.github/extensions/workflow/lib/workflow-model.mjs`
- `.github/extensions/workflow/lib/registry-ids.mjs`
- `.github/extensions/theme-equipment-review/lib/cli-bundle.mjs`
- `scripts/agent/health/check-extensions.mjs` (new)
- `package.json` (added `check:extensions` script + wired into `health:check`)

## Verification

- `extensions_reload` → 14/14 extensions ready (was 13/14)
- `node scripts/agent/health/check-extensions.mjs` → ✅ 106 files checked, 0 violations
- `node --test` on `yaml-reader.test.mjs`, `workflow-model.test.mjs`, `registry-ids.test.mjs`,
  `cli-bundle.test.mjs` → 38/38 pass

## Unresolved issues

None.

## Recommended next steps

- The `check:extensions` guard catches NEW bare-import violations going forward. Any new
  extension file that imports a third-party package must use `createRepoRequire` from
  `.github/extensions/shared/node-modules-resolver.mjs`.
- If a new extension needs a third-party package that is NOT in the repo's `node_modules`,
  it cannot be used in a worktree context — open an issue to add it to `package.json`.
