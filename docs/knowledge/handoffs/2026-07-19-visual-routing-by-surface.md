# Handoff: Route visual validation by affected surface

**Date:** 2026-07-19  
**Slug:** visual-routing-by-surface  
**Issue:** nalfeo/Crawler#1698 (closes), nalfeo/Crawler#1688 (prerequisite — implemented inline)  
**Estimate:** 3🍎 (actual: 3🍎)  
**Review ledger:** `docs/knowledge/review-ledgers/2026-07-19-visual-routing-by-surface.review-ledger.json`

## Systems touched

ci, e2e, devtools, sprites, tests

## What changed and why

Of 982 CI runs, 609 were non-visual yet consumed ~2,636 runner-minutes on Playwright E2E jobs.
This session adds surface-aware routing so CI only launches Playwright when the changed files
can actually affect a visual surface.

### Phase 1 — Surface classification (`scripts/agent/ci/detect-art-only.sh`)

Added `emit_visual_all()` function emitting 4 new boolean flags:

| Flag                     | Surface                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `visual_touched`         | Union of all three below                                                                |
| `game_visual_touched`    | src/core, src/engine, src/game, src/shared, src/labs, non-devtool tests/e2e             |
| `asset_visual_touched`   | public/assets/generated/\*\*, src/shared/data/sprite-catalog.json                       |
| `devtool_visual_touched` | src/devtools/\*\*, src/devtools-main.ts, devtools.html, sprite-workflow-sensors.test.ts |

**Key classification decisions:**

- Non-visual paths are explicitly allowlisted: .github/\*\*, scripts/\*\*, docs/\*\*, tests/unit/\*\*, etc.
- Unknown/unclassified paths → fail toward broader validation (`game_visual_touched=true`). This
  includes root config files (tsconfig.json, package.json) that are not provably non-visual.
- No-base-ref fail-safe → `emit_visual_all true true true true` (run everything, can't determine diff).
- Empty changeset fail-safe → `emit_visual_all false false false false` (nothing changed).

**Plan review fix (blocking):** `devtools.html` and `src/devtools-main.ts` were initially missing
from the devtools surface and the `gameplay_safe` allowlist. Both are now classified as
`devtool_visual_touched` (not `game_visual_touched`) and added to the allowlist.

**Code review fix:** The no-base-ref fail-safe was emitting `false false false false` (silently
dropping all visual jobs). Fixed to emit `true true true true` to match the schedule override intent.

Also added `src/devtools-main.ts` and `devtools.html` to the `gameplay_safe` allowlist since they
are browser-only DevTools entrypoints that the headless runner never imports.

### Phase 2 — Vitest sub-projects (`vitest.config.ts`)

Added three new targeted projects alongside the existing `e2e` project:

| Project        | Include                                                                  | Purpose                     |
| -------------- | ------------------------------------------------------------------------ | --------------------------- |
| `e2e-game`     | All e2e tests except sprite-workflow-sensors                             | Game/engine/UI visual suite |
| `e2e-assets`   | generated-door-overlay, harvestable-node-sprite, terrain-generated-tiles | Generated art smoke         |
| `e2e-devtools` | sprite-workflow-sensors.test.ts                                          | DevTools browser UI         |

Pre-existing `passWithNoTests: true` entries in `integration`, `sprites`, and `e2e` project configs
were removed — the option is not valid in `ProjectConfig` (root-level only). These errors were
invisible before because `vitest.config.ts` was not in `tsconfig.json`.

### Phase 3 — CI routing (`.github/workflows/ci.yml`)

Replaced single `test-e2e` job with three surface-targeted jobs:

```
test-e2e-game    → if: game_visual_touched == 'true'
test-e2e-assets  → if: asset_visual_touched == 'true'
test-e2e-devtools → if: devtool_visual_touched == 'true'
```

All three use `allow_skipped: true` in the merge gate so correctly-skipped jobs count as PASS.

Schedule runs override all visual flags to `true` for the hourly health sweep.

### Phase 4 — verify-fast compatibility

- Added `vitest.config.ts` to `tsconfig.json` includes (was missing, hiding type errors)
- Updated `verify-fast.sh` `is_supported_ts_path()` regex to include `vitest.config.ts`
- Updated `verify-fast-typecheck.test.ts` to use `commitlint.config.ts` as the "unsupported path"
  example (previously used `vitest.config.ts` which is now supported)

## Test coverage

46 deterministic bash test cases in `tests/unit/detect-change-scope.test.ts` covering all 9 scope
flags. New visual-routing cases include:

- Devtools-only change → `devtool_visual_touched=true, game_visual_touched=false`
- devtools.html and src/devtools-main.ts → `devtool_visual_touched` only (not game_visual)
- CI-only change → all visual flags false (no Playwright)
- Art + devtools mixed → both asset and devtool visual
- Game-only change → `game_visual_touched=true`

## Acceptance criteria status

- ✅ `visual_touched=false` launches no Playwright job
- ✅ Generated game art → e2e-assets (3-test smoke suite)
- ✅ Engine/UI changes → e2e-game (full game visual suite)
- ✅ Devtool/browser-only changes → e2e-devtools only
- ✅ Unknown/mixed changes → game_visual_touched=true (broader validation)
- ✅ Test-to-surface mapping deterministic and documented in detect-art-only.sh
- ✅ Merge-gate semantics correct (allow_skipped=true for all 3 jobs)
- ✅ No existing visual assertion deleted
