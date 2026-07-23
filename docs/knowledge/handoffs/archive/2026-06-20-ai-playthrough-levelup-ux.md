# Handoff — AI playthrough uses the level-up UX

**Date:** 2026-06-20
**Branch / PR:** `copilot/build-level-up-ux`
**Persona:** Producer (multi-layer: game + engine + lab)

## Apples

**Estimate:** 🍎🍎🍎 (3, Medium) · **Actual:** 🍎🍎🍎 (3) · verdict **🎯 exact**

Reason: cross-layer wiring (game → engine → lab) plus a UI state-machine driver
and two test files — no new ECS system or ADR, so squarely Medium.

## Systems touched

ai-combat-balance

## Goal

Make the **in-browser AI playthrough** (AI Runner Lab) go through the _real_
level-up stat-allocation modal (the UX added in `84ec4de`) instead of bypassing
it by auto-spending points before the modal can open. The **headless runner**
keeps direct allocation (it has no DOM/modal — bypass is unavoidable and
intentional there).

## Problem

The level-up UX freezes the sim and opens `LevelUpUI` when
`world.state === 'level_up'` and `unspentPoints > 0`. The AI Runner Lab ran
`autoAllocateStatPoints` as a post-system every frame, which spent the points
immediately — so `unspentPoints` was `0` by the time the scene checked, the modal
never opened, and the AI never exercised the shipped UX.

## What shipped

1. **`src/game/ai/auto-progression.ts`** — extracted the pure decision
   `computeAutoStatAllocation(world, playerEid, available)` from
   `autoAllocateStatPoints` (which now just calls it + `spendPoints`). Same
   survival-tiered spend order (armor→5, maxHp→6, armor→11, dump rest into maxHp),
   now clamped by an explicit `available` and side-effect-free.
2. **`src/engine/LevelUpUI.ts`** — added `autoResolve(allocations)` that drives
   the real allocation reducers point-by-point (`incrementStat`) then `confirm`s,
   firing the same `onConfirm` → `allocateStatPoints` path a clicking player hits.
3. **`src/engine/scenes/MainGameScene.ts`** — added optional
   `autoLevelUpAllocator` scene option + `driveAutoLevelUp()`: while the modal is
   open and an allocator is wired, hold it visible for `LEVEL_UP_AUTO_HOLD_FRAMES`
   (24 render frames ≈ 0.4s, independent of sim speed since the modal freeze skips
   the fixed-step) then auto-confirm with the allocator's chosen points. Omitted
   for human play.
4. **`src/labs/ai-runner-lab/index.ts`** — removed `autoAllocateStatPoints` from
   the post-system driver and set `autoLevelUpAllocator: computeAutoStatAllocation`
   so the lab AI drives the modal. Boss-reward/shop/stair auto-driving unchanged.
5. **Tests:** `tests/unit/auto-stat-allocation.test.ts` (8 — heuristic + clamps +
   purity) and `tests/unit/ai-level-up-ux-wiring.test.ts` (3 — guards the
   cross-layer wiring and that the bypass cannot return).

## Validation

- `npm run typecheck`, lint, format — green.
- Full unit project: **1355 tests pass** (incl. 11 new).
- Headless Floor 1 completion gate (`npm run test:headless`): **4 pass** — AI
  progression parity intact.
- `npm run verify`: green incl. production build (`vite build`) and lab gate.

## Known gaps / notes

- **Browser smoke test skipped (environment-blocked):** the Playwright MCP
  Chrome profile (`/root/.cache/ms-playwright/mcp-chrome`) had a stale,
  root-owned lock the runner shell couldn't clear, so I couldn't visually confirm
  the modal opening mid-run. Logic is covered by unit tests + the headless gate +
  a clean build. A follow-up could add an e2e (`?lab=ai-runner`) that asserts
  `__aiRunnerDebug().worldState` transits `level_up → playing` and `level`
  increments.
- **Pre-existing integration failures (unrelated):** `tests/integration/{batch-cli,
generate-one,judge-budget-cache,judge-pipeline}` fail in this sandbox because
  they need external VLM/image-gen providers. Confirmed failing on base `84ec4de`
  with my changes stashed. They're non-blocking in `verify.sh` ("No integration
  tests yet").
