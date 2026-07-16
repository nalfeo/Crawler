# Session Handoff: AI runner opportunistic farming/gathering/dodging on seed 42

## Date

2026-06-28

## Persona(s) adopted

Producer → Gameplay/AI tuning. Multi-layer task (behavior-tree constants, headless gate, win-rate sweep) so defaulted to Producer.

## Routing verdict

✅ right persona — single AI-tuning surface, no need to split.

## Apples

Estimated: 🍎 x 3
Actual: 🍎 x 3
Verdict: 🎯 Exact — enabling the layer was easy; the forward-cone rewrite over-engaged squishy seeds and needed a health gate + several dial-back cycles to keep the gate green.

Hello kitties: 3/5 = 0.60 🎀

## Systems touched

ai-combat-balance

## What Was Done

Seed 42's parallel opportunistic layer (Collect/Dodge/Farm) was effectively dead: dodge 0, collect 85, farm 0 frames. Brought it alive **during quest-objective navigation**:

- `buildOpportunisticFarm` rewritten — now fires in EXPLORE _with_ a target (quest nav), pulling toward enemies in a **forward cone** (`FARM_FORWARD_DOT_MIN` within `FARM_FORWARD_SCAN_RADIUS_FT=28`), never backward. Added `FARM_MIN_HEALTH_FRACTION=0.6` health gate so hurt runners beeline the objective instead of over-engaging (fixed a seed-13 death).
- Constants: `farmPullWeight` 0→0.07, `opportunisticGrabRadius` 15→18, `PATH_CORRIDOR_HALF_WIDTH_FT` 5→7, dodge radius 12→14 / closing 0.1875→0.15, quest-detour 20→26 ft & 0.5→0.6 fraction.
- Rewrote stale unit test to assert forward-cone semantics (fires ahead, dormant behind, off at weight 0).

Seed 42: dodge 1852 / collect 134 / farm 1706 (was 0/85/0); kills 127→154, victory held. Sword sweep 1–30 held 23/30 (77%), bow 53→63%. Headless gate 68/68 green (clean run, 186s).

## What's Next

Win-rate is 77% sword / 63% bow, below the 90% target — opportunistic behavior is now visibly working but didn't raise the rate. A future session could push toward 90% (timeouts dominate fails; gate on rate, not seeds).

## Blockers

Browsers unavailable (no chrome) so visual watch was impossible; verified deterministically via probe + headless instead.

## Branch State

- Branch: `nalfeo-ai-runner-opportunistic-behavior`
- All tests passing: yes (verify full green)
- PR created: yes

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` does not exist — no section.

## Test Results

`npm run verify` — all 8 steps pass, build clean. `npm run test:headless` 68/68 on clean run (wall-time guard flakes only under CPU contention).

## Key Decisions Made

Health-gated, forward-cone farm pull keeps opportunism on-path without reintroducing the over-engagement that historically blew the floor-clear budget. Tuned to win-RATE, not cherry-picked seeds.
