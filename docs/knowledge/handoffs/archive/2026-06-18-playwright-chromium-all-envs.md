# Handoff: Playwright Chromium installed in all environments

**Date:** 2026-06-18  
**Complexity:** 🍎

## What was done

Fixed the E2E visual regression tests so they work in every environment (local dev,
CI unit-test job, e2e job, agent preflight) — not just the dedicated `test-e2e` CI job.

## Root cause

`playwright` was already a devDependency but the Chromium **binary** is a separate
download that `npm install`/`npm ci` does not perform automatically. The only place
it was installed was the `test-e2e` CI job via an explicit `npx playwright install
chromium --with-deps` step. Running `npm test` (which includes the `e2e` vitest
project) anywhere else caused:

1. `browserType.launch: Executable doesn't exist` — Chromium binary missing.
2. `TypeError: Cannot read properties of undefined (reading 'close')` — `browser`
   was never assigned, so `afterAll`'s `browser.close()` crashed.

## Changes

| File                                    | Change                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                          | Added `"postinstall": "playwright install chromium"` — runs after every `npm install`/`npm ci`                                              |
| `scripts/agent/preflight.sh`            | Added `npx playwright install chromium` step after `npm ci`                                                                                 |
| `.github/actions/setup-node/action.yml` | Added Playwright browser cache (`~/.cache/ms-playwright`) keyed off `package-lock.json`; installs browsers on cache miss with `--with-deps` |
| `.github/workflows/ci.yml`              | Removed now-redundant explicit install step from `test-e2e` job (handled by `setup-node`)                                                   |
| `tests/e2e/minimap-overlay.test.ts`     | Changed `browser.close()` → `browser?.close()` defensive guard                                                                              |

## Verification

All 5 E2E visual regression tests now pass locally:

```
✓ renders safe-room floor tiles (teal) in the map content area
✓ renders stone-wall tiles around the room perimeter
✓ shows a mix of terrain colours (not pure void) across the map area
✓ overlay closes cleanly when M is pressed a second time
✓ paints non-void terrain inside the radar dial
```

## Notes for next agent

- The Playwright browser cache in CI is keyed to `package-lock.json`, so it
  invalidates automatically when playwright is upgraded.
- `postinstall` uses `playwright install chromium` (no `--with-deps`) to stay
  cross-platform; `setup-node` uses `--with-deps` for bare Linux CI runners.
