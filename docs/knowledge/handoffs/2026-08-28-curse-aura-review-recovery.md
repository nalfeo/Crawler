# Session Handoff: Curse aura review recovery

## Date

2026-08-28

## Persona

`Reviewer → QA Engineer`

## Systems touched

weapons, vfx, enemies

## Apples

3🍎 estimated, 3🍎 actual (exact) — review recovery required a fresh independent
grade of the current PR diff and a deterministic E2E synchronization repair.

## What Was Done

- Made `mainSceneProbe.advanceSimulationFrames()` wait through two browser
  animation frames after queueing the real scene's simulation work. Status-aura
  state reads and screenshots now occur after `MainGameScene.update()` consumes
  the queued step.
- Corrected the status-aura ADR: Curse's tuning is a data-driven simulation
  behavior change with no new simulation system, and the live status-effect
  channels are `speed`, `attackSpeed`, and `hpRegen`.
- Started a fresh independent grade packet at the repaired head; its result is
  recorded in the existing 3🍎 review ledger before publishing.

## Verification

- `npm run test:e2e -- status-effect-aura-main-scene.test.ts` ✅
- `npx prettier --check tests/e2e/helpers/main-scene-probe.ts docs/knowledge/adr/2026-08-27-status-effect-aura-and-curse-trigger-ring.md` ✅
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-08-27-curse-range-status-visuals.review-ledger.json` ✅ before the grade refresh
- `npm run verify:fast` was blocked before checks because the session cannot
  resolve `origin/main`; retry with `GITHUB_BASE_SHA=26279e29b437b48040ef6914aa17461b8af14eb2`.

## Recommended Next Steps

- Keep the fresh independent-grade entry tied to the repaired commit when
  publishing this recovery.
