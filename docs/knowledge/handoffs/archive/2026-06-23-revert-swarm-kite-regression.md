# Session Handoff: Revert Swarm-Kite Regression (Floor 1 Gate)

## Date

2026-06-23

## Persona(s) adopted

Game Designer (AI behavior debugging + headless regression gate).

## Apples

Estimated: 🍎🍎 (2)
Actual: 🍎🍎 (2)
Verdict: 🎯 Exact — bounded to root-causing one regression and reverting one file.

Hello kitties: 2/5 = 0.40 🎀

## Systems touched

ai-combat-balance

## Problem

The canonical Floor 1 headless completion gate
(`tests/headless/floor1-completion.test.ts`, seed 15) was **failing**:

- `outcome = "timeout"` at 330.0s game-time, level 5, 13 kills
- `floor1-shopkeeper-errand` never completed (also `floor1-boss-battle`)

The user's standing invariant was re-stated up front and respected:

> **You may not change drop pickup ranges.** The crawler must "loot the corpse"
> by getting very close. Ranged users must kite mobs through pickups.

No pickup-range constant was touched (`pickupRange` in `src/shared/stats.ts`,
`PICKUP_RADIUS_SQ` in `returningProjectileSystem.ts`, manifest
`pickupRangeBonus` — all unchanged).

## Root Cause

Commit **28bfac4** _"feat(ai): swarm separation kite, melee focus-dive, ranged
LoS reposition"_ (the branch HEAD, only `src/game/ai/bt-ai-provider.ts`)
regressed the canonical seed-15 clear on **three** axes:

1. **Correctness** — `MELEE_HOLD_FRACTION` was pushed `0.5 → 0.9`, holding the
   melee orbit at ~36px from a 40px-reach enemy. Combined with the new boids
   separation push, the player poked the swarm edge and barely landed hits. The
   event summary showed it permanently stuck on
   _"Hunting the swarm for charm gold (5g to go) — Kiting enemy at ~59px"_: it
   could never farm the 5 gold the shopkeeper errand's buy-gear step requires,
   so progression stalled (85% of the run in ENGAGE, 43% wiggle, 26% stuck).
2. **Performance** — the new per-frame work (double `computeSwarmSeparation`
   enemy queries, `playerHealthFraction` query, LoS checks) cut throughput ~6x
   when the player engages closely: **6.8s → 42s wall** for seed 15. That blows
   the gate's 30s `beforeAll` hook budget even on an otherwise-correct clear.
3. **Stability** — the kite became chaotically non-monotonic in the hold
   fraction: 0.5 ✓, 0.6 ✓, **0.7 ✗ (3 kills)**, 0.8 ✓, **0.9 ✗**. A fragile
   attractor where the player locks into a no-kill orbit.

## Fix

Reverted `src/game/ai/bt-ai-provider.ts` to its pre-28bfac4 state (the documented
canonical the gate was built around). No tests depended on the new features (the
commit added none), so the revert is clean.

Restored canonical seed 15: **VICTORY 252.9s, 22 kills, 6.8s wall, all 4 quests.**

## What's Next

The reverted features (Reynolds separation steering, melee focus-dive, ranged
line-of-sight reposition) are sound ideas but were shipped together and broke the
gate. Reintroduce them **deliberately and incrementally, keeping the headless
gate green and the seed-15 wall time within budget after each step**:

- Keep `MELEE_HOLD_FRACTION` aggressive enough to farm kills; let the separation
  steering (not the hold radius) own swarm safety.
- Budget the per-frame cost: cache/share the single enemy query instead of
  re-querying twice per kite frame; gate LoS raycasts behind ranged-only paths.
- Add a wall-time/perf assertion or a second canonical seed before re-landing the
  kite changes so a perf regression is caught at the gate.

## Blockers

None.

## Branch State

- Branch: `copilot/resume-routing-combat-behaviors`
- All tests passing: yes
- PR: open

## Test Results

- ✅ `npm run test -- tests/headless/floor1-completion.test.ts` (4/4, 8.2s)
- ✅ `npm run test -- tests/game/` (282/282)
- ✅ `npm run verify:fast`
- ✅ `bash scripts/agent/lab-gate-check.sh`

## Key Decisions Made

- Chose a clean revert of the single regressing commit over re-tuning a single
  constant: the failure was multi-axis (correctness + perf + stability), and the
  hold-fraction response was chaotically non-monotonic, so a marginal tuning
  value would be an overfit to seed 15 rather than a real fix.
- Did not touch any drop pickup-range constants (explicit user invariant).
