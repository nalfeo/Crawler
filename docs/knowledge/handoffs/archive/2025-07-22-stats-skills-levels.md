# Handoff: Stats / Skills / Levels System

**Date:** 2025-07-22
**Branch:** `nalfeo/bootstrap-crawler-prototype`
**Commit:** `03c4f6e`
**Tests:** 149 passing · 0 failing · `npm run verify:fast` ✅

---

## What Was Done

Full implementation of the stats, skills, and leveling system as specced in `.specify/specs/stats-skills-levels.md`.

### New Files

| File                              | Purpose                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------- |
| `src/shared/stats.ts`             | STAT_KEYS, StatKey, STAT_BASE/INCREMENT/MIN tables                               |
| `src/shared/xpMath.ts`            | Pure XP math: threshold, required, levelForXp                                    |
| `src/shared/skills.ts`            | Shared types: PlayerLevel, StatModifier, SkillState, SkillUsageEvent             |
| `src/game/skills/types.ts`        | Game-specific skill interfaces: SkillDefinition, SkillMilestone, MilestoneEffect |
| `src/game/skills/registry.ts`     | 3 skill definitions: swordsmanship, iron-skin, sprint                            |
| `src/game/systems/levelSystem.ts` | XP → level → unspentPoints pipeline                                              |
| `src/game/systems/statsSystem.ts` | Dirty-flag stat recomputation + spendPoints/addStatModifier helpers              |
| `src/game/systems/skillSystem.ts` | Usage event processing → skill level-ups + milestones                            |
| `src/labs/stats-lab/index.ts`     | Interactive stat allocation lab                                                  |
| `src/labs/xp-curve-lab/index.ts`  | XP curve visualization/tuning lab                                                |
| `src/labs/skill-lab/index.ts`     | Skill progression sandbox lab                                                    |

### Modified Files

- `src/core/components.ts` — Added `Stats`, `SkillHolder` tag components + `stats`/`statPoints` stores
- `src/core/world.ts` — Extended GameWorld with playerLevel, statModifiers, playerSkills, skillUsageEvents, statsDirty
- `src/core/systems/damageSystem.ts` — Armor reduction for player, XP gem accumulation, swordsmanship usage events
- `src/core/systems/playerInputSystem.ts` — Reads `stats.moveSpeed` when Stats component present
- `src/game/weaponSystem.ts` — Reads `stats.damage`/`attackSpeed`/`projectileCount`; multi-projectile spread
- `src/lab-main.ts` — Imports 3 new labs
- `src/shared/index.ts` — Re-exports from skills.ts

---

## Architecture Decisions

### Layer Fix: shared/skills.ts

During implementation, `world.ts` (core layer) needed `PlayerLevel`, `StatModifier`, `SkillState`, `SkillUsageEvent` types. These were originally in `src/game/skills/types.ts` which violates the `src/core/ → src/shared/ only` ESLint layer rule. **Solution:** Moved these 4 interfaces + constants to `src/shared/skills.ts`. The game-specific types (SkillDefinition, SkillMilestone, MilestoneEffect) remain in `src/game/skills/types.ts` which re-exports the shared types.

### Skill ID Coupling (v1 Limitation)

In `damageSystem.ts`, the skill ID `'swordsmanship'` is hardcoded when emitting usage events for projectile hits. This is fine for v1 but will need a proper weapon→skill mapping table when more weapons/skills exist.

### Auto-Initialization of Skills

Skills are initialized lazily: `world.playerSkills` starts empty. The first usage event for an unknown skill ID is silently ignored. Labs and tests must pre-initialize skill state before firing usage events:

```ts
world.playerSkills.set('swordsmanship', {
  level: 0,
  usage: 0,
  itemBonus: 0,
  triggeredMilestones: new Set(),
});
```

The player entity initialization path (in `levelSystem`) does NOT auto-populate playerSkills. This should be addressed when a proper skill unlock/loadout system is built.

---

## System Formulas (Authoritative)

### XP / Leveling

- `xpThresholdForLevel(n) = floor(10 * 1.15^n)`
- `xpRequiredForLevel(n) = sum of thresholds 0..n-1`
- Batch level-up: all missed levels processed in one pass
- `pointsPerLevel = 3` (default, upgradeable)

### Stat Computation

- `raw = base + (points * increment) + sum(additive modifiers)`
- `final = max(STAT_MIN, raw) * (1 + sum(multiplicative modifier values))`
- Dirty flag: statsSystem skips if `world.statsDirty === false`
- Armor: `damageTaken = max(1, incoming - armor)` in damageSystem

### Skill Leveling

- Skills level via usage events (not XP)
- Natural cap: 15 | Hard cap: 20 (with itemBonus)
- Milestones fire at levels 5, 10, 15, 20 — exactly once (tracked in `triggeredMilestones` Set)

---

## Test Coverage (New)

- `tests/unit/xp-math.test.ts` — 10 tests
- `tests/game/level-system.test.ts` — 7 tests
- `tests/game/stats-system.test.ts` — 10 tests
- `tests/game/skill-system.test.ts` — 8 tests
- `tests/game/skill-registry.test.ts` — 9 tests
- `tests/property/stats-properties.test.ts` — 6 property-based tests (fast-check)

---

## What's Next

### Deferred (from spec)

- Silly skills, crafting synergies — intentionally deferred
- Skill auto-initialization on player spawn
- Weapon → skill mapping (remove hardcoded 'swordsmanship' in damageSystem)
- UI for stat point allocation and skill progress display
- `aura` milestone effect: placeholder only — full DPS aura system deferred

### Upcoming Systems

- Floor system (procedural floor generation, wave spawning)
- Loot system (item drops, loot tables, crafting)
- AI integration (Ollama / The Director voice)
- Broadcast Score meter
- HUD (health, XP, level, Broadcast Score, skills)

---

## Known Gotchas

- `world.stores.stats[stat][eid]` returns `number | undefined` in strict TS — always use `?? fallback`
- `fc.float()` in fast-check requires 32-bit-safe bounds — use `fc.double()` for general float ranges
- bitecs entity IDs are NOT guaranteed to be 0-indexed in tests — always capture and use the returned entity ID rather than hardcoding `[0]`
