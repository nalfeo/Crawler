# Handoff: Core Stats Level-Up System

**Date:** 2026-06-22  
**Persona:** Producer (Game Designer + Systems Engineer)  
**Apple estimate declared:** 🍎🍎🍎 | **Actual:** 🍎🍎🍎 | **Verdict:** Accurate

## Systems touched

inventory

## What was done

Replaced the level-up allocation system's direct STAT_KEYS (maxHp, damage, armor, …)
with core PRIMARY_STATS allocation per the design requirement: players raise
Strength, Dexterity, Intelligence, Constitution, Luck, Charisma (+ Wisdom) at level-up;
those stats then **derive** the gameplay stats via a new `CORE_STAT_GAINS` table.

## Files changed

| File                                 | Change                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `src/shared/stats.ts`                | Added `CORE_STAT_GAINS` and `CORE_STAT_BASE`                                                   |
| `src/shared/stat-display.ts`         | Added `PRIMARY_STAT_DISPLAY` + `formatCoreStatGains`                                           |
| `src/shared/level-up-allocation.ts`  | Draft now uses `PrimaryStatId` instead of `StatKey`                                            |
| `src/core/components.ts`             | `statPoints` store removed; `coreStatPoints` (primary stat fields) added                       |
| `src/game/systems/statsSystem.ts`    | Derives STAT_KEYS from `coreStatPoints × CORE_STAT_GAINS`; `spendPoints` takes `PrimaryStatId` |
| `src/engine/LevelUpUI.ts`            | Renders PRIMARY_STATS rows with derived-gains description                                      |
| `src/engine/scenes/MainGameScene.ts` | Passes `coreStatPoints` as `currentStats` when opening LevelUpUI                               |
| `src/game/ai/auto-progression.ts`    | Auto-allocation now uses `strength` (→ armor) + `constitution` (→ maxHp)                       |
| `src/shared/index.ts`                | Exports `CORE_STAT_GAINS`, `CORE_STAT_BASE`                                                    |
| `src/labs/level-up-lab/index.ts`     | Updated to use `coreStatPoints`                                                                |
| `src/labs/stats-lab/index.ts`        | Rewritten to show core stats + derived stats two-table layout                                  |
| All affected tests                   | Updated; 587 pass                                                                              |

## CORE_STAT_GAINS table

```
strength:     { damage: 2, armor: 1 }
dexterity:    { attackSpeed: 0.05, moveSpeed: 0.1 }
constitution: { maxHp: 10 }
intelligence: { projectileSpeed: 0.05 }
wisdom:       {}  ← reserved (mana/CDR future)
charisma:     {}  ← reserved (XP bonus/NPC future)
luck:         { pickupRange: 4 }
```

## Derivation formula (statsSystem)

```
STAT_KEYS[key] = STAT_BASE[key]
               + Σ(coreStatPoints[p] × CORE_STAT_GAINS[p][key])
               + Σ additive modifiers
               clamped to STAT_MIN,
               × (1 + Σ multiply modifiers)
```

Skill/buff `StatModifier` still targets STAT_KEYS directly — unchanged.

## Known gaps / future work

- **Wisdom** and **Charisma** show `"(no effect yet)"` in the UI; need hooking
  up to mana pool and XP bonus respectively once those systems land.
- Equipment bonuses still go through `statModifiers` on STAT_KEYS — could
  alternatively express them as core-stat bonuses for a more unified model.
- The `SECONDARY_STATS` (critChance, dodgeChance, …) and `baseStats`/`effectiveStats`
  ECS stores exist but are not yet wired into any combat system.
