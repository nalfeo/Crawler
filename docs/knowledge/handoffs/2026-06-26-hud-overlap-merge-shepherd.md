# 2026-06-26 HUD overlap guard — merge shepherd

## Session summary

Took ownership of PR #331 ("Add HUD overlap visual regression guard …") to drive it
to a merged-and-passing state. The PR was BLOCKED by a failing `E2E Visual Regression`
check (the `Merge gate` and `ci` aggregate checks failed only as a consequence) plus an
unresolved Copilot review comment about undocumented production layout changes.

Persona: **Producer** (multi-layer task — labs + engine + e2e + docs).

## Root cause of the E2E failure

The newly-added mobile ability-bar guard
(`tests/e2e/hud-overlap-visual.test.ts` → "ability bar stays visible with
`ABILITY_BAR_MAX_SCALE` cap applied") asserted `abilityBandRatio > 0.1` but measured
**0**.

`HudAbilityBar.sync()` early-returns and hides every slot unless
`world.featureUnlocks.spells === true` (`src/engine/HudAbilityBar.ts:94`). The
`hud-lab` builds its world with `createGameWorld({ seed: 1 })` and **never unlocked
spells**, so the ability bar was permanently invisible in the lab — the guard sampled an
empty band. The guard logic was correct; the lab harness simply never rendered the thing
it guards.

> Local red herring: the first local e2e run timed out at `waitForFunction(__hudProbe.ready())`.
> That was a cold Vite dep-prebundle (Phaser) exceeding the 30s load timeout on a cold
> cache, compounded by a stale lab server squatting on port 5299 — not a code defect. With
> a warm cache the suite runs in ~6s.

## Fix

`src/labs/hud-lab/index.ts` (lab-only change — the guard was NOT weakened):

- Unlock `world.featureUnlocks.spells` and equip the Floor 1 reward spells
  (`FLOOR1_BOSS_REWARD_SPELL_IDS`) on the lab player via a `makeLabAbilityState()`
  helper, so the bottom-center ability bar renders.
- Added a `spellsUnlocked` setting (default true) + a `Spells unlocked (ability bar)`
  lil-gui toggle; kept the unlock/ability-state in sync each frame so toggling works and
  survives scene restarts.
- Updated the lab header + `registerLab` description to mention the ability bar.

Measured after fix (800×450 mobile viewport): `abilityBandRatio ≈ 0.63` (needs > 0.1),
`midGapRatio = 0.0` (needs < 0.31). Both guard assertions pass with wide margins.

## Decision on the production layout changes (review comment 3479056406)

**Kept all of them** — they are the intentional "reduce mobile HUD overlap pressure" fixes
(commit `21c609e`), not scope creep:

- `HudUI.ts` `ABILITY_BAR_MAX_SCALE = 1.2` — now exercised end-to-end by the mobile
  ability-bar e2e guard (after this lab fix).
- `MainGameScene.ts` `MOBILE_CORNER_BUTTON_MAX_SCALE = 1.4`, `INTERACTION_HINT_MAX_SCALE = 1.25`,
  and the interaction-hint anchor move to `GAME.HEIGHT - INTERACTION_HINT_BOTTOM_MARGIN` (12px) —
  these live outside `hud-lab`, so they stay covered by source-assertion unit tests
  (`tests/unit/main-game-scene-mobile-ui.test.ts`, `tests/unit/hud-ui-layout.test.ts`).

Updated the PR description to document the lab change + a coverage-mapping note, and replied
to / resolved the review thread.

## Verification

- `npm run typecheck` ✅ · `npm run lint` ✅
- `npm run verify:fast` ✅
- Full unit suite (`vitest --project unit`): **1994 passed** ✅ (incl. the PR's two new
  source-assertion tests)
- Full e2e suite (`npm run test:e2e`): **16 passed** ✅ (hud-overlap guard now green)
- `scripts/agent/lab-gate-check.sh` ✅

## CI / merge status

- Branch was 0 behind / 5 ahead of `origin/main` — already up-to-date, no rebase needed.
- All commits are conventional-commit formatted (`commit-lint` already green).
- Auto-merge (squash) remains armed; re-armed after pushing the fix.

## Apples

- Estimated: 🍎🍎 (2). Actual: 🍎🍎 (2) — 🎯 exact. Single-file lab fix, but the
  root-cause diagnosis (spells-unlock gating), local reproduction, full verification, PR-body
  - review handling, and merge coordination land it squarely at 2.

## Next steps for future sessions

- A dedicated mobile-scene lab (or headless coverage) could let the visual guard exercise
  the `MainGameScene` corner-button / interaction-hint caps directly, rather than relying on
  source-assertion unit tests.
