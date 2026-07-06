# Handoff: Seed 3 AI Hill Climb

**Date:** 2026-07-05  
**Branch:** `nalfeo-seed-3-hill-climb`  
**Session:** Seed 3 hill climb  
**Apple estimate:** 🍎 (small optimization loop)  
**Kickoff verdict:** Recommended — clear bounded objective, deterministic runner, safe experiment space

## Systems touched

ai, perf-scripts

## What was done

Ran a greedy hill-climb optimization for Crawler's AI on seed 3 (sword weapon) to
maximize a composite fitness score with priority: victory → level ≥ 5 → gold → low FLEE.

### Files created

- `scripts/agent/perf/hill-climb-seed3.ts` — seed-3 focused greedy hill-climb script
  - Fixes critical bug in existing `hill-climb.ts`: stale pixel values (retreatDangerRadius:160,
    scanRadius:400) replaced with correct ft-based PARAM_SPACE matching `DEFAULT_CONFIG`
  - Custom `scoreSeed3()`: `VICTORY_BONUS(1M) + timeBonus(0-10k) + levelBonus(50k if ≥5,
+10k/level above 5) + xp*10 + gold*0.1 - retreatFrames*0.5`
  - Forces `forceWeaponId:'sword'`, `seed:[3]`, `maxFrames:25,000`

### Files modified

None — `src/game/ai/bt-ai-tuning.ts` was temporarily edited for Group B tests but fully
restored to original values before commit.

## Results

### Baseline (all DEFAULT_CONFIG)

| metric      | value     |
| ----------- | --------- |
| outcome     | victory   |
| frames      | 18,636    |
| final level | 5         |
| gold        | 128       |
| FLEE%       | 0%        |
| score       | 1,052,704 |

### Best config found: `farmPullWeight: 0.10`

| metric      | value                   |
| ----------- | ----------------------- |
| outcome     | victory                 |
| frames      | 19,524                  |
| final level | **8** (was 5)           |
| gold        | **278** (was 128)       |
| FLEE%       | 0%                      |
| score       | **1,082,394** (+29,690) |

### All configurations tested (12 hill-climb iters + 4 Group B tests)

| config                                               | frames     | lvl   | gold    | score                    |
| ---------------------------------------------------- | ---------- | ----- | ------- | ------------------------ |
| Baseline (all defaults)                              | 18,636     | 5     | 128     | 1,052,704                |
| **farmPullWeight=0.10**                              | **19,524** | **8** | **278** | **1,082,394** ← **BEST** |
| FARM_MIN_HEALTH_FRACTION=0.5                         | 18,263     | 6     | 125     | 1,062,879                |
| FARM_MIN_HEALTH_FRACTION=0.5 + farmPullWeight=0.10   | 20,285     | 7     | 124     | 1,072,077                |
| FARM_FORWARD_SCAN_RADIUS_FT=35 + farmPullWeight=0.10 | 17,324     | 7     | 363     | 1,073,268                |
| FARM_FORWARD_SCAN_RADIUS_FT=35 + default             | 17,922     | 7     | 318     | 1,073,036                |

## Key findings

1. **`farmPullWeight: 0.10`** (up from 0.07) is the single best improvement. It drives the AI
   toward more aggressive farm routing which results in reaching level 8 vs 5.

2. **Combining improvements hurts**: adding FARM_MIN_HEALTH_FRACTION=0.5 or
   FARM_FORWARD_SCAN_RADIUS_FT=35 on top of farmPullWeight=0.10 both _decrease_ the score.
   The AI becomes overloaded with competing objectives.

3. **Group B constants (FARM_MIN_HEALTH_FRACTION, FARM_FORWARD_SCAN_RADIUS_FT)** both show
   moderate improvements when applied alone but neither beats the simple farmPullWeight=0.10.

4. **Existing hill-climb.ts bug**: `BASE_CONFIG` in that script uses stale pixel values
   (8× too large). It accidentally still finds improvements because the AI wins anyway, but
   it's exploring the wrong parameter space. Use `hill-climb-seed3.ts` for future tuning.

## Recommendation

Apply `farmPullWeight: 0.10` to `DEFAULT_CONFIG` in `bt-ai-tuning.ts` — but validate across
a broader seed sweep first (not just seed 3) before committing it as the new default.
The hill-climb was only conducted on seed 3; the change could regress other seeds.

Run: `npm run ai:weapon-sweep` (or similar) to gate on win-rate across 100 seeds before
promoting the value.

## Notes for next session

- The hill-climb script is wired to accept `--seeds`, `--max-iters`, `--step-scale` flags
- `farmPullWeight: 0.07 → 0.10` is safe to test broadly; it's a small fractional increase
- The fitness function's level bonus (10k per level above 5) is the dominant driver of score —
  any config that reaches higher levels wins even if it takes more frames
