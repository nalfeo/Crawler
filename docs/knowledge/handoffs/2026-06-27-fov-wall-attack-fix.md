# Handoff — FOV Wall-Attack + Unreachable-Loot Fix

**Date:** 2026-06-27
**Session:** fov-wall-attack-fix
**Persona:** Systems Engineer
**Apple estimate:** 🍎🍎🍎🍎 | **Actual:** 🍎🍎🍎🍎 | **Verdict:** 🎯 exact

## What Was Done

Fixed the seed-42 boss-fight report: the AI player (1) attacked enemies through
walls, and (2) got stuck trying to collect loot stranded behind the still-locked
boss door. No attack — melee arc, melee/ranged auto-aim, or boss-priority — now
crosses a wall, and the AI no longer commits to loot it cannot path to.

## Diagnostic Answers (for the report)

- **Is FOV on? Is it too lenient?** FOV is **on** and **correct**. `fovSystem`
  runs every sim step (headless `simulation-step.ts`, visual `MainGameScene.ts`)
  and the rot-js shadowcaster passes its "should not see through walls" test. FOV
  was **not** the cause.
- **Does the AI-runner respect FOV?** Yes — for exploration (seen-fog frontier)
  and for **enemy** targeting (door-aware A\* reachability). The bug was in two
  places FOV/LOS was **not** consulted: weapon **melee** + **boss-priority**
  targeting bypassed line of sight, and **loot** goal selection ignored
  reachability entirely (only a ~180-frame dwell watchdog eventually caught it —
  the "gets stuck for a bit").

## Root Causes (four gaps, none in FOV)

1. **Melee target selection bypassed LOS.** `weaponSystem`'s melee path called
   `getNearestEnemyTarget(..., ignoreFov=true)` — the follow-up ADR 0018
   explicitly deferred. The boss fight is exactly that deferred failure mode.
2. **Melee damage resolution had no LOS check.** `meleeSwingSystem` applied arc
   damage from blade geometry alone, so the swing arc damaged anything behind a
   thin wall — and symmetrically let enemy swings hit the player through walls.
3. **Boss-priority targeting had no LOS gate.** `findBossTargetInRange` (used by
   **both** melee and ranged) targeted a permanently-aggroed boss within range
   with no sight check; `fireTarget = bossTarget ?? target` then shot/swung
   through the wall at it — a hole ADR 0018's ranged fix left open.
4. **AI loot goals ignored reachability.** `findNearestLoot` / `findNearestGold`
   picked by Euclidean distance + blacklist only (unlike the enemy finders, which
   gate on A\* reachability). Loot behind the locked boss door became a `COLLECT`
   goal and the AI wiggled until the dwell watchdog abandoned it.

## The Fix

1. **`meleeSwingSystem` (core)** — null-guarded LOS gate inside the per-target hit
   loop: skip the hit when `world.floorMap && !hasLineOfSight(px,py,tx,ty)`. The
   airtight, symmetric backstop; no-op when `floorMap` is null (unit fixtures).
2. **`weaponSystem` (game)** — melee targeting `getNearestEnemyTarget(...,true)` →
   `false`; added the `isVisible || hasLineOfSight` gate inside
   `findBossTargetInRange` (closes the boss-through-wall hole for melee **and**
   ranged).
3. **`bt-ai-provider` (game/ai)** — renamed `isEnemyReachable` → `isTargetReachable`
   (+ `enemyReachableCache` → `targetReachableCache`, 20-frame TTL); rewrote
   `findNearestLoot` and `findNearestGold` to collect → sort by distance → return
   the nearest **collectable** (already-adjacent OR door-aware-A*-reachable),
   sticky target gated the same way. Door-aware A* already treats a locked boss
   door as a wall, so loot is excluded while locked and re-included on unlock — no
   door special-casing.

## Files Changed

| File                                                | Change                                                     |
| --------------------------------------------------- | ---------------------------------------------------------- |
| `src/core/systems/meleeSwingSystem.ts`              | + LOS gate per hit (symmetric backstop)                    |
| `src/game/weaponSystem.ts`                          | Melee targeting `true`→`false`; LOS gate in boss targeting |
| `src/game/ai/bt-ai-provider.ts`                     | Loot/gold reachability gate; `isEnemyReachable` rename     |
| `tests/ecs/melee-returning-system-coverage.test.ts` | +3 melee LOS cases (blocked, clear, symmetric)             |
| `tests/game/weapon-system-coverage.test.ts`         | +3 (melee-through-wall, melee clear-LOS, boss-LOS ranged)  |
| `tests/game/behavior-tree-ai.test.ts`               | +3 loot reachability (sealed, reachable, sticky-drop)      |
| `docs/knowledge/adr/0023-...md`                     | New ADR (cross-layer core + game)                          |

## Validation

- `npm run verify:fast` ✓ (typecheck + lint + 616 unit tests)
- `npm run verify` ✓ (format, coverage, integration, **headless Floor 1 gate —
  44 tests, no seed regression**, build)
- `bash scripts/agent/lab-gate-check.sh` ✓ (no new ECS system; existing labs
  cover the touched systems)

## Notes for Next Agent

- The melee LOS gate keys on the **owner** position as the swing origin (falls
  back to the swing's stored position when the owner has no `Position`).
- `enemyAISystem`'s ranged shooters still have **no** LOS gate (noted as a
  follow-up in the 2026-06-25 weapon-fov handoff and still open) — a candidate for
  symmetry, since `hasLineOfSight` is now used on both the player melee and ranged
  sides.
- No `files/guard-telemetry.jsonl` present this session, so no guard-telemetry
  section to paste.

## Apples

Estimated 🍎🍎🍎🍎, actual 🍎🍎🍎🍎 (exact). Three layers (core melee
resolution, game weapon targeting, game/ai goal selection), a cross-layer ADR,
and 9 new regression tests across three suites — but it reused existing
deterministic primitives (`hasLineOfSight` from ADR 0018, door-aware A\* /
`isTargetReachable` from ADR 0021) rather than building new machinery, landing
squarely at the Large estimate.

## Systems touched

ai-pathfinding
