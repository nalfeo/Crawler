# Floor 1 Balance Pass — Session Handoff

**Date:** 2026-06-23  
**Apple estimate:** 🍎🍎🍎 (declared Medium)  
**Actual:** 🍎🍎🍎🍎 — root-cause investigation ran longer than expected  
**Verdict:** Incomplete — two confirmed fixes shipped, 8 remaining failures diagnosed

---

## What Was Done

### Fixes shipped

1. **DungeonGenerator wall-spawn fallback** (`src/core/map/generators/DungeonGenerator.ts`)
   - `Math.floor(bounds.x + bounds.width/2)` could land on a wall tile when overlapping
     corridors or rooms fill part of the spawn-room interior.
   - Added a spiral outward search from the computed center; stays within the interior
     region (`bounds.x+1` → `bounds.x+width-2`) until a passable tile is found.
   - Fixed seed 2: previously stuck forever (spawn on wall → A\* start invalid → zero movement).
     After fix: victory 130s lv4 15 kills.

2. **BT AI progress-goal suppression** (`src/game/ai/bt-ai-provider.ts`)
   - EXPLORE dwell watchdog would fire on a position-based target, clear the decision,
     but `planProgress()` immediately re-assigned the same unreachable target next frame
     → infinite loop.
   - Added `PROGRESS_SUPPRESS_FRAMES = 360` cooldown; all non-enemy position goals in
     `planProgress` are suppressed for 360 frames after the dwell watchdog fires.

3. **`tuning.json` floor1SuccessRate** updated from `0.8` → `0.95`.

---

## Current Baseline (seeds 1–20)

| Seed | Outcome | Game time | Lv  | Kills | Stuck on                                                             |
| ---- | ------- | --------- | --- | ----- | -------------------------------------------------------------------- |
| 1    | victory | 128s      | 5   | 22    | —                                                                    |
| 2    | victory | 130s      | 4   | 15    | —                                                                    |
| 3    | timeout | 102s      | 6   | 13    | shopkeeper-errand, boss-battle (sim very slow: ~300s wall/100s game) |
| 4    | victory | 155s      | 6   | 18    | —                                                                    |
| 5    | timeout | 330s      | 4   | 18    | shopkeeper-errand                                                    |
| 6    | timeout | 330s      | 6   | 15    | shopkeeper-errand, boss-battle                                       |
| 7    | death   | 142s      | 5   | 12    | — (all quests done, died after boss)                                 |
| 8    | victory | 149s      | 5   | 14    | —                                                                    |
| 9    | victory | 186s      | 6   | 23    | —                                                                    |
| 10   | death   | 139s      | 5   | 21    | boss-battle (died during staircase boss)                             |
| 11   | victory | 202s      | 5   | 20    | —                                                                    |
| 12   | victory | 189s      | 7   | 13    | —                                                                    |
| 13   | timeout | 330s      | 2   | 4     | boss-unlock (kill grind stuck)                                       |
| 14   | timeout | 330s      | 3   | 9     | shopkeeper-errand, boss-battle                                       |
| 15   | timeout | 330s      | 3   | 12    | shopkeeper-errand, boss-battle                                       |
| 16   | victory | 234s      | 6   | 14    | —                                                                    |
| 17   | victory | 176s      | 7   | 20    | —                                                                    |
| 18   | victory | 207s      | 6   | 10    | —                                                                    |
| 19   | timeout | 330s      | 5   | 9     | shopkeeper-errand                                                    |
| 20   | timeout | 330s      | 1   | 7     | tutorial (kill grind)                                                |

**Win rate: 10/20 = 50%** (target: 95%)

---

## Root Causes Remaining (10 failures)

### A — Kill-grind stuck: seeds 13, 20

- Seed 20: lv1, 7 kills in 330s. `floor1-tutorial` accepted but never completed (need 6 rats + 4 slimes).
- Seed 13: lv2, 4 kills in 330s. `floor1-boss-unlock` accepted but not completed.
- Both are low-kill-rate, not complete zero. Suspect: `findNearestQuestEnemy` fails to locate
  enemies or pathfinding degrades on certain map layouts.
- The BT suppression fix solved seed 2 (which was fully stuck at one tile) but these seeds
  are making _some_ progress — just very slowly.
- **Next step**: probe event log for seed 20 to see AI state + kill timing. Check if it enters
  `ENGAGE` mode and misses enemies, or stays in `EXPLORE` most of the time.

### B — Shopkeeper errand stuck: seeds 5, 6, 14, 15, 19

- All completed `floor1-boss-unlock` (kill grind done) but never finished `floor1-shopkeeper-errand`.
- The errand involves: find fetch item (`questItemPos`) → return to shopkeeper → buy charm
  (costs `SHOPKEEPER_EQUIPMENT_COST` = `MERCHANTS_CHARM_COST` from tuning).
- Gold farming logic exists in `planProgress` (`shopStage === 'ready-to-buy'`) but takes
  too long at lv3-6 with 9-18 total kills.
- **Key unknowns**:
  - What is `MERCHANTS_CHARM_COST`? (grep in `src/shared/data/` or `tuning.json`)
  - How much gold do enemies drop per kill?
  - Is `questItemPos` reachable on these map layouts?
- **Likely fix**: Reduce `MERCHANTS_CHARM_COST` so the charm is affordable at lv3-4.
  Or increase gold drop per kill. Check `src/shared/loot-tables.ts` and `enemies.floor1.json`.

### C — Player deaths: seeds 7, 10

- **Seed 10**: died during `floor1-boss-battle` (staircase boss fight). Boss too strong for lv5 unequipped.
- **Seed 7**: completed ALL quests including `floor1-boss-battle` but still got `death` outcome.
  Likely died from ambient mobs while walking to the staircase after defeating the boss.
- **Likely fixes**:
  - Reduce staircase boss HP/damage in tuning or floor1 manifest.
  - Add a "retreat to heal" behavior when HP drops below threshold during boss fight.
  - Increase player `invincibilityMs` (currently 250ms — might be too short for boss hits).

### D — Slow simulation: seed 3

- Takes ~300s wall time to simulate 102s of game time (pathologically slow).
- The wall-time cap in batch tests masks this as a quick failure but the underlying game
  logic does eventually make progress (lv6, 13 kills at 102s).
- Stuck on shopkeeper-errand like group B — same underlying issue.
- Performance root cause unknown; possibly a pathfinding hot-path on this specific map.
- **Not a correctness fix** — will resolve itself if B is fixed and the player completes
  the floor more quickly.

---

## Files Modified This Session

| File                                          | Change                                               |
| --------------------------------------------- | ---------------------------------------------------- |
| `src/core/map/generators/DungeonGenerator.ts` | Spiral fallback when spawn center is a wall tile     |
| `src/game/ai/bt-ai-provider.ts`               | Progress-goal suppression (PROGRESS_SUPPRESS_FRAMES) |
| `src/shared/data/tuning.json`                 | `floor1SuccessRate` 0.8 → 0.95                       |

---

## Suggested Next Steps (priority order)

1. **Fix shopkeeper errand gold economy** (unblocks 5 seeds):
   - Find `MERCHANTS_CHARM_COST` and compare against gold drop rate per kill.
   - Reduce cost so a lv3-4 player can afford it within ~60s of farming.
   - Relevant files: `src/shared/data/tuning.json`, `src/shared/loot-tables.ts`,
     `src/game/floor1Scenario.ts` (search `MERCHANTS_CHARM_COST`).

2. **Probe seed 20 kill-grind stuck** (unblocks 2 seeds):
   - Run with `recordEvents: true` and examine AI state transitions.
   - Look for: does player stay in `EXPLORE` indefinitely? Is `findNearestQuestEnemy`
     returning null even when enemies are present?

3. **Fix player deaths during/after boss** (unblocks 2 seeds):
   - Check staircase boss stats in `floor1.manifest.json` (`bossVariants`).
   - Consider reducing boss HP by 20-30% or adding brief invincibility after boss kill.
   - For seed 7 (post-boss ambient death): the player may need a brief safe zone
     around the staircase.

4. After fixing B, re-run batch 1–20 to measure new pass rate.
5. Update `WINNING_SEEDS` in `tests/headless/floor1-completion.test.ts` with 2-3 more.
6. Write apple metrics JSON.
7. Unlock session lock.
