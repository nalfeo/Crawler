# Spec: Stats, Skills & Leveling System

## Context

Crawler currently has XP gems, a level-up curve in constants, and basic player stats
(health, speed, damage) hard-coded. Players need progression mechanics that create
meaningful build diversity, dopamine-hit level-ups, and the "barely surviving →
accidentally godlike" power curve that defines the genre.

The skill system is a distinct "level by usage" system separate from XP leveling.
Silly skills and synergies are a core design goal — deferred to v2 but the
architecture must accommodate them.

> **Current-code note:** this spec covers gameplay stat keys (`STAT_KEYS` in `src/shared/stats.ts`). The codebase also contains primary/secondary equipment stats (`StatId`) used by the equipment system; bridges between these surfaces are system-owned.

> **Units note (ADR 0023):** all spatial stats below are expressed in the engine's single internal unit — **feet** — not pixels. An earlier draft of this spec used pixels; values were divided by `PIXELS_PER_FOOT = 8` when the codebase unified on feet (see `docs/knowledge/adr/0023-feet-as-single-internal-spatial-unit.md`). Pixels appear only in `src/engine` at render time.

## Requirements

### Level System

- XP threshold to reach level N: `floor(XP.BASE_PER_LEVEL * XP.SCALING_FACTOR^N)` (level starts at 0)
- `currentXp` is **lifetime XP** — threshold is cumulative
- `xpForLevel(n) = sum of thresholds 0..n-1` (precomputed on demand)
- On level-up, player receives `pointsPerLevel` stat points (default **3**, upgradeable later)
- All pending levels from a single XP gain are batched: player gets total points at once, one allocation screen
- Level-up sets `world.state = 'level_up'`; game pauses until points are spent
- **v1 allocation:** In the absence of a real UI, the xp-curve-lab and tests use a
  `spendPoints(world, allocations)` helper to programmatically distribute points
- No level cap — `level` stored as JS number (world-level state, not typed array)

### Stats System

- **Base stats:** Fixed constants per stat (v1 — no character archetypes yet)
- **Point bonuses:** Accumulated from player spending stat points
- **Modifiers:** Named, stackable records from skills, floor effects (items deferred)
- **Final stats:** `clamp(min, base + pointBonus + additive) * multiplicative`
- **Primary-stat derivation:** allocated primary-stat points (Strength, Dexterity, …) also feed gameplay stats via `CORE_STAT_GAINS` and combat/secondary stats via `CORE_STAT_TO_SECONDARY` (`src/shared/stats.ts`). Effective fold: `STAT_BASE[key] + Σ(coreStatPoints[p] × CORE_STAT_GAINS[p][key]) + statPoints[key] + additive`, then multiplicative.
- Stats recomputed on **dirty flag**, not every frame
- Stats are the SINGLE source of truth consumed by all other systems

#### Stat List (v1)

| Stat              | Effect                                            | Base  | Point Increment   | Min |
| ----------------- | ------------------------------------------------- | ----- | ----------------- | --- |
| `maxHp`           | Maximum health                                    | 100   | +10               | 1   |
| `moveSpeed`       | Movement **feet**/frame                           | 0.375 | +0.0125           | 0   |
| `damage`          | Projectile damage                                 | 10    | +2                | 0   |
| `armor`           | Flat damage reduction                             | 0     | +1                | 0   |
| `attackSpeed`     | Fire rate multiplier                              | 1.0   | +0.05             | 0.1 |
| `pickupRange`     | XP gem magnet radius (**feet**)                   | 3.0   | +1.0              | 1.0 |
| `projectileCount` | Extra projectiles per shot                        | 0     | +1 (integer)      | 0   |
| `projectileSpeed` | Projectile velocity multiplier                    | 1.0   | +0.05             | 0.1 |
| `accuracy`        | Bonus hit-chance over weapon `baseAccuracy` (0–1) | 0     | +0.02 (reserved)¹ | 0   |

> ¹ `accuracy` is not allocated directly in the level-up UI — it is trained via **Dexterity** (`+0.01` per effective point) and weapon-type skills (`+0.03`/level). The `+0.02` point increment is reserved for a future direct-allocation path. Applied in `weaponSystem` as `effectiveAccuracy = clamp(0, 1, weapon.baseAccuracy + stats.accuracy)`.

> **Deferred to v2:** a dedicated `luck`/`area` **gameplay** stat key — no consumers exist yet. (The **primary** stat `luck` _is_ wired today: it raises `pickupRange` and crit chance via `CORE_STAT_GAINS` / `CORE_STAT_TO_SECONDARY` in `src/shared/stats.ts`.)

**HP behavior on maxHp change:** `currentHp += delta` (preserve absolute HP, not percentage).
Cap: `currentHp = min(currentHp, maxHp)`.

**Armor formula:** `damageTaken = max(1, incomingDamage - armor)`

**Attack speed formula:** `effectiveCooldownMs = baseCooldownMs / max(0.1, stats.attackSpeed)`

**Projectile count usage:** `totalProjectiles = 1 + floor(stats.projectileCount)`

**Multiple multipliers:** Stacked multiplicative modifiers add as percentages, then apply once:
`multiplier = 1.0 + sum(modifier.multiply values)`

### Skill System

- Skills are data-driven definitions in a skill registry
- **Player-only in v1** — enemies do not have skills
- **Skills level up by USAGE** — tracked via usage events emitted to `world.skillUsageEvents`
- Valid usage must be combat-relevant (hits landed, not shots fired; damage dealt; dodge near threat)
- Usage events are processed by skillSystem and cleared each frame

#### Skill Leveling

- Skills track a `usage` counter incremented by events
- Usage thresholds are strictly increasing and defined per skill (length = `hardCap`)
- **Natural cap: 15** — usage alone cannot exceed this
- **Hard cap: 20** — `itemBonus` (stub for future items) can push from 15 → 20
- Skill level = number of thresholds crossed, clamped to `min(naturalCap + itemBonus, hardCap)`
- **Milestones at 5, 10, 15, 20** — triggered **once** when level first reaches that value,
  tracked in `triggeredMilestones: Set<number>` per skill state
- Between milestones: each level adds the skill's per-level stat bonus

#### Skill Categories (v1)

| Category  | Theme                 | Examples                                    |
| --------- | --------------------- | ------------------------------------------- |
| `combat`  | Direct damage/weapons | Swordsmanship, Marksmanship, Heavy Ordnance |
| `defense` | Survival/tanking      | Iron Skin, Dodge Roll, Second Wind          |
| `utility` | Movement/QoL          | Sprint, Magnet Hands, Lucky Star            |

> **Deferred to v2:** `crafting` category, `silly` skills, synergy system

## Design

### Layer Placement

- `levelSystem` → `src/game/systems/` (reads XP constants, game state)
- `statsSystem` → `src/game/systems/` (reads skill/modifier data)
- `skillSystem` → `src/game/systems/`
- Skill registry data → `src/game/skills/`
- Math helpers (XP threshold formula) → `src/shared/` (pure, importable everywhere)

### ECS Components & Stores

```typescript
// New component tags
export const Stats = {}; // entity has computed stats
export const SkillHolder = {}; // entity has skills (player-only v1)

// New stores — all Float32Array unless noted
stats: {
  (maxHp,
    moveSpeed,
    damage,
    armor,
    attackSpeed,
    pickupRange,
    projectileCount,
    projectileSpeed,
    accuracy);
}
statPoints: {
  // accumulated point bonuses per stat (same fields as stats)
  (maxHp,
    moveSpeed,
    damage,
    armor,
    attackSpeed,
    pickupRange,
    projectileCount,
    projectileSpeed,
    accuracy);
}
```

**Level state** is stored at the world level (not ECS) because it's player-singleton:

```typescript
world.playerLevel: {
  xp: number;           // lifetime XP (JS number — no float precision loss)
  level: number;        // current level (JS number — no cap)
  unspentPoints: number;
  pointsPerLevel: number; // default 3
}
```

**clearEntityStores must zero `stats` and `statPoints` arrays** for recycled EIDs.

### Modifier Records

Modifiers are stored as a world-level list (not ECS), player-only in v1:

```typescript
interface StatModifier {
  sourceType: 'skill' | 'floor' | 'buff' | 'ability';
  sourceId: string;           // e.g. 'swordsmanship' or 'fire-floor'
  stat: StatKey;
  op: 'add' | 'multiply';
  value: number;
  expiresFrame?: number;      // undefined = permanent until explicitly removed
}

world.statModifiers: StatModifier[];
```

Expired modifiers are filtered out by statsSystem before computing.
Dirty flag is set whenever modifiers are added/removed or stat points change.

### Stat Key Type

```typescript
export const STAT_KEYS = [
  'maxHp',
  'moveSpeed',
  'damage',
  'armor',
  'attackSpeed',
  'pickupRange',
  'projectileCount',
  'projectileSpeed',
  'accuracy',
] as const;
export type StatKey = (typeof STAT_KEYS)[number];
```

### Skill Data (world-level registry)

```typescript
interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  category: 'combat' | 'defense' | 'utility';
  usageMetric: UsageMetric;
  usageThresholds: number[]; // strictly increasing, length = SKILL_HARD_CAP (20)
  perLevelBonus: Partial<Record<StatKey, number>>; // added each level
  milestones: SkillMilestone[];
  flavorText?: string;
}

type UsageMetric = 'hits_landed' | 'damage_dealt' | 'distance_dodged_near_threat';

interface SkillMilestone {
  level: 5 | 10 | 15 | 20;
  name: string;
  description: string;
  effect: MilestoneEffect;
}

type MilestoneEffect =
  | { type: 'stat_add'; stat: StatKey; value: number }
  | { type: 'stat_multiply'; stat: StatKey; value: number }
  | { type: 'extra_projectile'; count: number }
  | { type: 'aura'; radius: number; dpsPercentOfDamage: number };
```

### Player Skill State

```typescript
// world.playerSkills: Map<string, SkillState>
interface SkillState {
  level: number; // 0–20
  usage: number; // lifetime usage counter
  itemBonus: number; // stub: bonus levels from items, 0 in v1
  triggeredMilestones: Set<number>; // which milestone levels have fired
}
```

### Usage Events

```typescript
// world.skillUsageEvents: SkillUsageEvent[] — cleared each frame after skillSystem runs
interface SkillUsageEvent {
  holderEid?: number;
  skillId: string;
  metric: UsageMetric;
  amount: number;
}
```

Usage emitters:

- `damageSystem` currently emits `hits_landed` for player projectile hits
- `damage_dealt` and `distance_dodged_near_threat` emitters are planned follow-up integrations

### System Architecture

```
levelSystem(world)
  ├─ reads: world.playerLevel, xpGem pickups
  ├─ accumulates XP, computes threshold crossings
  ├─ on level-up: adds pointsPerLevel to unspentPoints, sets world.state='level_up'
  └─ batches multi-level gains (single allocation screen)

statsSystem(world)
  ├─ runs only when dirty flag set
  ├─ filters expired modifiers from world.statModifiers
  ├─ for each stat: base + statPoints store + additive modifiers
  ├─ applies multiplicative modifiers as: total = additive_sum * (1 + sum_of_multiplies)
  ├─ clamps to per-stat minimums
  └─ writes: stats store for player eid

skillSystem(world)
  ├─ reads: world.skillUsageEvents (then clears them)
  ├─ accumulates usage per skill in world.playerSkills
  ├─ level-ups: check thresholds, clamp to min(naturalCap + itemBonus, hardCap)
  ├─ on level-up: push StatModifier to world.statModifiers, set dirty flag
  └─ on milestone first-reach: fire effect, add to triggeredMilestones, set dirty flag
```

### Integration Points

- `weaponSystem` reads `stats.damage`, `stats.attackSpeed`, `stats.projectileCount`, `stats.accuracy` (player eid)
- `movementSystem` reads `stats.moveSpeed` (player eid)
- `healthSystem` reads `stats.maxHp` for HP cap; handles delta on maxHp change
- `damageSystem` reads `stats.armor`; emits skill usage events
- `xpPickupSystem` reads `stats.pickupRange` for gem magnet radius
- `Damage.amount` on projectiles = `stats.damage` copied at spawn time

## Test Plan

### Unit Tests (tests/game/)

- `level-system.test.ts`: XP threshold calc, level-up detection, multi-level-up batching, unspentPoints accumulation
- `stats-system.test.ts`: Base stat computation, additive stacking, multiplicative stacking, order independence, per-stat minimums, dirty flag skips recompute, expired modifiers removed
- `skill-system.test.ts`: Usage tracking, level-up on threshold, natural cap at 15, hard cap at 20, milestones fire once, itemBonus raises effective cap

### Unit Tests (tests/unit/)

- `xp-math.test.ts`: `xpForLevel(n)` formula correctness, threshold cumulative vs per-level
- `stat-key.test.ts`: STAT_KEYS exhaustive, StatKey assignable

### Unit Tests (tests/game/)

- `skill-registry.test.ts`: No duplicate IDs, categories valid, thresholds strictly increasing, threshold length == hardCap, all milestones at valid levels

### Property-Based Tests (tests/property/)

- Stats always respect per-stat minimums regardless of modifier stacking
- Modifier stacking result is order-independent (commutativity)
- Skill level never exceeds `min(naturalCap + itemBonus, hardCap)` regardless of usage
- XP thresholds are strictly increasing

### Labs

- `stats-lab`: Tune base stats, add/remove modifiers, see computed final values live
- `xp-curve-lab`: Visualize XP-per-level curve, tweak BASE_PER_LEVEL & SCALING_FACTOR live, projected time-to-level at various kill rates, overlay floor duration windows
- `skill-lab`: Browse skill catalog, simulate usage, see level-ups and milestone fires

## Constitutional Compliance

| Principle                   | Compliance                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------- |
| §1 Agent = Model + Harness  | Skill registry is TS data, not LLM-generated at runtime                                 |
| §2 Lab-Gated Development    | 3 labs: stats-lab, xp-curve-lab, skill-lab                                              |
| §3 Deterministic CI         | All tests deterministic, no LLM-as-judge                                                |
| §4 Deterministic Game Logic | XP/level math is pure functions of input; no Date.now(); usage events are frame-ordered |
| §5 ECS-Phaser Bridge        | All 3 systems in src/game/, no Phaser imports; math helpers in src/shared/              |
| §6 AI Content During Load   | Skill flavor text is static data                                                        |
| §9 Coverage Requirements    | Target 90%+ for all new game systems                                                    |
| §10 Hashimoto's Loop        | Tests cover edge cases surfaced by antagonistic review                                  |
