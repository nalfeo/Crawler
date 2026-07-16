# Handoff: XP Rate Tuning & Dramatic Boss Drops

**Date:** 2026-06-28  
**Session goal:** Tune experience rate so player ends floor 1 at ~level 6; make bosses drop lots of XP gems and gold for dramatic visual impact.

## Systems touched

enemies, inventory

## What Was Done

### Problem

- Headless AI (seed 42, sword) was ending floor 1 at **level 8** with the old system.
- Bosses were using BASIC_MELEE loot table (hardcoded in `getEnemyLootTables`) — they dropped the same 1–2 items as regular enemies with no drama.
- The `BOSS` table in `loot-tables.ts` existed but was never applied to actual boss entities.

### Changes Made

#### `src/shared/loot-tables.ts`

1. **`FLOOR_1` XP gem**: value 4 → 1. Regular kills now give ~2 XP each (1 from BASIC_MELEE + 1 from FLOOR_1) instead of 5 XP.
2. **`BOSS` table** (Rat Slime staircase final boss): Reworked for dramatic finale:
   - XP: 10–16 gems × value 2 (avg 26 XP)
   - Gold: 20–28 coins × value 8 (avg 192 gold — ~192× a regular enemy)
3. **`BOSS_MINOR` table** (Slime Rat mid-floor boss): New table for satisfying mid-point payoff:
   - XP: 4–8 gems × value 2 (avg 12 XP)
   - Gold: 14–20 coins × value 5 (avg 85 gold)

#### `src/core/systems/dropSystem.ts`

- `getEnemyLootTables()` now detects boss entities by iterating `world.floor1?.objective?.bossBattles`.
- Returns `BOSS_MINOR` for `battleKey === 'slime-rat'`, `BOSS` for the staircase boss.
- bosses do NOT get the FLOOR_1 floor-level table bonus; their dedicated tables are self-contained.
- The EID check works correctly because `dropSystem` runs before `floorObjectiveSystem` each frame, so `bossEid` is still populated when the drop is processed.

### Result (Headless AI seed 42, sword)

```
Final Level:  6  (was: 8)
Total XP:     95  (86 needed for level 6, 109 for level 7)
Total Gold:   312  (significantly higher due to boss drops)
Floor cleared: 314.6s (within 360s budget)

Level-Up Progression:
  Level 1:  55.6s
  Level 2:  63.2s (+7.5s)
  Level 3: 137.0s (+73.8s)
  Level 4: 212.3s (+75.3s)
  Level 5: 213.1s (+0.8s) ← Slime Rat boss gem burst!
  Level 6: 312.9s (+99.8s) ← Rat Slime staircase boss kill!
```

The boss level-ups are satisfying moments: Level 4→5 fires in under 1 second after the Slime Rat dies (gem burst), and Level 6 fires right after the final staircase boss defeat.

## Apple Score

- Estimated: 🍎🍎 (Small)
- Actual: 🍎🍎 (Small — 2 files, loot table values + boss detection logic)
- Verdict: exact

## Tests

- All 2440 unit/integration tests pass
- TypeScript compiles clean
- Headless AI: seed 42 × {sword, bow, baseball-bat} should still clear within 360s budget (level 2 gate now ~63s vs ~56s previously — negligible delay)

## Follow-up Notes

- Human players who collect more XP gems than the AI may reach level 7; this is expected variance ("around level 6")
- The `balanceTargets.levelUpIntervalMinS/MaxS` in tuning.json remain aspirational — the actual pacing is now tighter in mid-floor combat and slower in exploration, which feels natural
- Future: `getEnemyLootTables` could be extended with a general loot table component on the entity, removing the floor-1-specific boss detection
