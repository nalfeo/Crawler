# Session Handoff: Fix player-hurt throttle poison in EffectsVfx

## Date

2026-06-26

## Persona(s) adopted

Systems Engineer — single-layer (engine) bug fix in the VFX renderer with a
focused unit test. Shepherded PR #346 to merge on behalf of the wound-down
owning session.

## Routing verdict

✅ right persona — the work was a contained engine-layer logic fix plus test, no
cross-system coordination needed.

## Apples

Estimated: 🍎 x 2 <!-- declared before work began -->
Actual: 🍎 x 2 <!-- honest assessment at handoff time -->
Verdict: 🎯 Exact — one surgical source change threading a parameter, a finite
sentinel, and one new test file; merge/rebase shepherding was process overhead,
not added code complexity.

Hello kitties: 2/5 = 0.40 🎀

## What Was Done

Fixed a latent bug flagged by Copilot review on `src/engine/EffectsVfx.ts`.

- A queue-sourced `playerHurt` `VfxEvent` called
  `playerHurt(Number.POSITIVE_INFINITY)`, which stamped `lastPlayerHurtMs` with
  `+Infinity`. Every subsequent combat-derived player-hurt then evaluated
  `renderElapsedMs - Infinity === -Infinity < PLAYER_HURT_THROTTLE_MS`, so the
  throttle guard returned early forever and no player-hurt flash/shake fired
  again for the renderer's lifetime — a permanent break of the player-hurt
  feedback feature, reachable by any system pushing that documented
  `VfxEffectKind`.
- Fix: threaded the real `renderElapsedMs` from `update()` through
  `handleVfxEvent` so the queue path stamps a finite timestamp, and seeded
  `lastPlayerHurtMs` to a finite far-past sentinel (`-PLAYER_HURT_THROTTLE_MS`)
  so the first hurt still fires immediately. No `Date.now()` / `Math.random()`;
  change stays internal to the engine layer (no `src/game` or `src/labs`
  imports).
- Added `tests/unit/effects-vfx-throttle.test.ts` (3 tests): reproduces the
  throttle poison (RED against the old `+Infinity` path, GREEN after the fix),
  proves the throttle still suppresses rapid hits inside the window, and proves
  the first hurt fires from render time zero.

## What's Next

Nothing required for this fix. Optional future polish: the `vfx-events.ts` doc
note already says combat-derived kinds need not be queued — consider whether
`playerHurt` should remain in the generic `VfxEffectKind` union at all, since it
is the only kind that depends on the render clock.

## Blockers

The repo's `auto-resolve-review-threads` workflow is currently failing at 0s on
every branch (main included) — the run produces no jobs (App-token startup
failure, `secrets.APP_ID` / `APP_PRIVATE_KEY`). This is pre-existing org-infra
breakage, not specific to this PR. Worked around it by resolving the single
addressed thread via the GraphQL `resolveReviewThread` mutation as the PR owner.
Someone should repair the App-token step so future PRs auto-resolve.

## Branch State

- Branch: `nalfeo-particle-effects-investigation`
- All tests passing: yes
- PR created: yes — https://github.com/nalfeo/Crawler/pull/346 (auto-merge
  armed, squash)

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` not present this session — nothing to paste.

## Test Results

- `npm run verify`: typecheck ✅, lint ✅, format ✅, unit + integration ✅,
  build ✅. The headless Floor-1 gate's wall-time perf assertions tripped only
  because the machine was saturated running the full suite in parallel
  (documented as "a coarse blowup guard, not a precise SLA"); re-running
  `npx vitest run --project headless` in isolation passed 68/68.
- `bash scripts/agent/lab-gate-check.sh`: ✅ passed.
- New test file: 3/3 green after fix; the poison-repro case is RED against the
  pre-fix `+Infinity` code path.

## Key Decisions Made

- Used a finite `-PLAYER_HURT_THROTTLE_MS` sentinel instead of `-Infinity` so
  the throttle delta is always a real number and can never be re-poisoned, while
  still guaranteeing the first hurt fires (`renderElapsedMs >= 0`).
- Kept the fix surgical and inside the engine layer to satisfy the bridge
  pattern and ESLint layer rules.
