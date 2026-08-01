# Floor 2 XP Pacing Fix: Level-10 at First Boss Gate

**Date:** 2026-08-01  
**Issue:** #2551  
**Branch:** `copilot/fix-2551`  
**Complexity:** 🍎🍎🍎

## Systems touched

headless-runner, loot-tables, floor2-manifest, xp-pacing, ai-types

## Problem

Floor 2 boss balance targets a **level-10 player**. Prior headless runs (seeds 1–3) hit
only level 8 before the 360 s quest-stall budget expired. The root cause was ambiguous:
timeout, AI competence, or genuine XP pacing gap.

## Root cause

Floor 2 had **no floor-level loot bonus**. Floor 1 applies `FLOOR_1` (+1 XP/kill →
2 XP total). Floor 2 used only `BASIC_MELEE` (1 XP/kill). Starting at level 5 (66 XP),
reaching level 10 (200 XP) requires 134 XP. At 1 XP/kill that means **134 kills before
the first boss**; at 2 XP/kill it drops to **~67 kills**, achievable before den unlock.

## Changes

| File                                               | Change                                                                                                                                                                                   |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/loot-tables.ts`                        | Added `FLOOR_2` loot table (`id: 'floor_2'`, +1 XP/kill bonus, matching FLOOR_1 pattern)                                                                                                 |
| `src/shared/data/floors/floor2.manifest.json`      | Wired `"floorLootTableId": "floor_2"`                                                                                                                                                    |
| `src/game/ai/types.ts`                             | Added `levelAtEncounterStart: number \| null` to `Floor2FamilyProgressMetrics`                                                                                                           |
| `src/game/ai/headless-runner.ts`                   | Added `floor2EncounterStartedLevel` Map; captures player level on first frame encounter.started=true; passes it through `collectFloor2Progression`                                       |
| `src/game/ai/headless-runner-cli.ts`               | Prints `lv${levelAtEncounterStart}` in CLI boss-line                                                                                                                                     |
| `tests/headless/floor2-boss-level-gate.test.ts`    | **New gate test**: seeds 1–3, maxFrames=100k, questStallFrames=50k; asserts `outcome != 'stalled'`, encounter started, `10 ≤ levelAtEncounterStart ≤ 13`, first encounter `≤ 900 000 ms` |
| `tests/headless/headless-runner-telemetry.test.ts` | Two new telemetry unit tests: null-before-encounter and capture-on-first-started-frame                                                                                                   |

## Gate test design decisions

- **Stall guard**: asserts `outcome != 'stalled'` before level check so navigation regressions give a clear error.
- **Level bounds**: `[10, 13]` — lower bound is the spec requirement; upper bound prevents overcorrection.
- **Timing bound on _first_ encounter only**: `Math.min(encounterStartedMs)` across all started families, not per-family, to avoid false failures on runs that complete all 4 dens (Win B path).
- **Extended stall budget** (50k frames ≈ 833 s): default 21 600 (360 s) was too tight for Floor 2's 200×200 map.

## Review

- Plan review: `gpt-5.4`, 5 concerns, all resolved (2 blocking: stall guard, upper bound).
- Code review round 1: `claude-sonnet-4.6`, 1 concern (timing bound applied to all encounters → fixed to first-only).
- Code review round 2: `claude-sonnet-4.6`, 0 concerns.
- Ledger: `docs/knowledge/review-ledgers/2026-08-01-floor2-boss-level-xp-pacing.review-ledger.json`

## Follow-up

- Tighten `MAX_LEVEL_AT_FIRST_BOSS` (currently 13) once CI measures more seeds; 11–12 is likely the real ceiling.
- The Floor 2 boss retune (#2551 blocker) may now proceed: the reference fight level is verified.
