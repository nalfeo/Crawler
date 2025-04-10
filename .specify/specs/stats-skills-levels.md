# Spec: Stats, Skills & Leveling System

## Context

Crawler has seven primary (core) stats a player allocates level-up points into
(Strength, Dexterity, Constitution, Intelligence, Wisdom, Charisma, Luck),
plus a derived layer of secondary/gameplay stats (armor, crit, dodge, move
speed, etc.) every other system reads. A separate "level by usage" skill
system layers weapon/defense/utility skills on top.

This spec reflects the **primary-stat system overhaul**
(`docs/knowledge/adr/2026-07-16-primary-stat-system-overhaul.md`), which:

- Unified the runtime stat snapshot onto `EffectiveStats` (deleting the older
  computed `Stats` component and its game-layer `statsSystem`).
- Redefined every primary stat's exact per-effective-point payoff (see
  Primary Stat Table below) and removed `weight` as a primary stat.
- Split physical vs magical offense into independent typed-primary
  multipliers (Strength → physical, Intelligence → magic) instead of a
  generic damage-percent secondary.
- Replaced positional `applyDamage` arguments with a fail-closed typed
  `DamageOptions` object.
- Made every spell's numeric outputs explicit `{base, scalesWithIntelligence}`
  fields.
- Added a fully-wired-but-currently-inert encumbrance system (equipment
  weight, body mass, Strength-scaled thresholds).
- **Removed mana entirely** — ability access is unlock + cooldown gated only,
  with no MP resource pool.

> **Units note (ADR 0023):** all spatial stats below are expressed in the
> engine's single internal unit — **feet** — not pixels. Pixels appear only
> in `src/engine` at render time.

## Requirements

### Level System

- XP threshold to reach level N: `floor(XP.BASE_PER_LEVEL * XP.SCALING_FACTOR^N)` (level starts at 0)
- `currentXp` is **lifetime XP** — threshold is cumulative
- `xpForLevel(n) = sum of thresholds 0..n-1` (precomputed on demand)
- On level-up, player receives `pointsPerLevel` stat points (default **3**, upgradeable later)
- All pending levels from a single XP gain are batched: player gets total points at once, one allocation screen
- Level-up sets `world.state = 'level_up'`; game pauses until points are spent
- `spendPoints(world, allocations)` (`src/game/systems/statsSystem.ts`) is the
  single entry point both the real `LevelUpUI` and headless/AI/lab callers
  use to commit an allocation — it validates against `unspentPoints` and
  `isAllocatablePrimaryStat`, then writes `world.stores.coreStatPoints`
- No level cap — `level` stored as JS number (world-level state, not typed array)

### Primary Stats

Every primary stat's **effective value** is `base(1) + allocated level-up
points + equipment bonuses`. Every per-point rate below applies against that
full effective value — so even a stat with **zero** allocated points still
contributes its baseline rate once (effective = 1), and equipping gear that
grants a primary-stat bonus pays off identically to allocating a point.

| Primary        | Allocatable | Per-effective-point payoff                                                                                                                     |
| -------------- | :---------: | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `strength`     |     ✅      | +1% physical damage (typed-primary multiplier — see Damage Scaling). No armor, no flat damage, no generic secondary.                           |
| `dexterity`    |     ✅      | +1% attack-speed bonus; +0.25% move-speed bonus (multiplicative, applied before encumbrance); +0.25pp accuracy; +1/300 (≈0.333pp) dodge chance |
| `constitution` |     ✅      | +10 max HP                                                                                                                                     |
| `intelligence` |     ✅      | +1% magic strength (typed-primary multiplier). Every magical ability output that `scalesWithIntelligence` gets this same rate.                 |
| `wisdom`       |     ✅      | +0.5pp cooldown reduction (cap 80%)                                                                                                            |
| `charisma`     |    ❌ no    | Visible, intentionally **zero** gameplay effect. Not allocatable — `spendPoints`/the level-up UI reject it.                                    |
| `luck`         |     ✅      | +0.25pp crit chance (total crit chance capped at 100%)                                                                                         |

`weight` is **not** a primary stat (removed by the overhaul — see
`docs/knowledge/adr/2026-07-10-core-stat-scaling-weight-placeholder.md`,
superseded). The ECS `Weight` component (body mass, used by
knockback/drop physics) is unrelated and unaffected.

Rates/caps live in `src/shared/stats.ts`: `CORE_STAT_TO_SECONDARY` (Dex/Con/
Wis/Luck → secondary fields), `STR_PHYSICAL_DAMAGE_RATE` /
`INT_MAGIC_STRENGTH_RATE` (both `0.01`, the typed-primary rate), and
`STAT_CLAMPS` (caps).

### EffectiveStats — the sole runtime stat snapshot

- **One derivation, one store.** `computeEffectiveStatsFromLoadout(base,
coreStatPoints, uniqueEquippedBonuses, activeModifiers)` in
  `src/core/effective-stats.ts` is the single pure formula: base → fold core
  points into their typed primary field → fold equipment `statBonuses` → fold
  active ability/skill modifiers (`foldLegacyStatModifier`) → derive
  secondaries from the now-complete effective primaries
  (`CORE_STAT_TO_SECONDARY`) → clamp (`STAT_CLAMPS`).
- **`core/systems/statSystem.ts`** is the only per-frame recompute. It always
  recomputes (no dirty-flag gating) for every `[Equipment, BaseStats,
EffectiveStats]` entity (in practice only ever the player), prunes expired
  `world.statModifiers` first, and syncs `Health.max/current` by delta so a
  Constitution change heals/damages by exactly the HP delta (never resets
  current HP to full, never lets repeated ticks creep max HP).
- `equipmentSystem.initializeBaseStats` seeds `Health.max/current` to the
  freshly-derived `effectiveStats.maxHp` at spawn (base CON=1 → 160 + 10×1 =
  170 HP, replacing survivability removed with Strength armor).
- There is **no separate `Stats` component/store** — `stores.stats` does not
  exist. Legacy `StatModifier`/`CatalogEffect` targets (`StatKey` —
  `maxHp`/`moveSpeed`/`damage`/`armor`/`attackSpeed`/`pickupRange`/
  `projectileCount`/`projectileSpeed`/`accuracy`) fold directly into
  `EffectiveStats` via `foldLegacyStatModifier`: additive `damage` → flat
  `damageBonus`; multiplicative `damage` → generic `damagePercent`; every
  other key folds additively into its same-named field regardless of `op`.

#### Secondary (derived/gameplay) stat list

| Stat                                                | Effect                                              | Base | Notes                                                                                                       |
| --------------------------------------------------- | --------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------- |
| `maxHp`                                             | Maximum health                                      | 160  | + 10 × effective Constitution                                                                               |
| `moveSpeed`                                         | Move-speed bonus fraction (0 = no bonus)            | 0    | + 0.0025 × effective Dexterity; folds before status/encumbrance                                             |
| `armor`                                             | Flat damage reduction                               | 0    | Legacy-modifier target only (no primary derives it)                                                         |
| `damageBonus`                                       | Flat additive damage                                | 0    | Legacy `damage`+`add` modifiers only                                                                        |
| `damagePercent`                                     | Generic multiplicative damage                       | 0    | Legacy `damage`+`multiply` modifiers only                                                                   |
| `attackSpeed`                                       | Attack-speed bonus fraction (0 = no bonus)          | 0    | + 0.01 × effective Dexterity; clamp `> -1` (floor `-0.9`)                                                   |
| `critChance`                                        | Chance to critically strike (player→enemy only)     | 0.05 | + 0.0025 × effective Luck; cap 1.0                                                                          |
| `critMultiplier`                                    | Damage multiplier on a crit                         | 1.5  | —                                                                                                           |
| `dodgeChance`                                       | Chance to fully avoid an incoming hit (player only) | 0    | + (1/300) × effective Dexterity; cap 0.75                                                                   |
| `cooldownReduction`                                 | Fractional cooldown reduction                       | 0    | + 0.005 × effective Wisdom; cap 0.8                                                                         |
| `accuracy`                                          | Bonus hit-chance over a weapon's `baseAccuracy`     | 0    | + 0.0025 × effective Dexterity; also trained by weapon-type skills                                          |
| `hpRegen`, `xpBonus`                                | Reserved secondary stats                            | 0    | No current derivation or consumer                                                                           |
| `pickupRange`, `projectileSpeed`, `projectileCount` | Inert snapshot fields                               | 0    | Kept so legacy modifiers/registries have a valid target; nothing currently derives or reads non-zero values |

**HP behavior on maxHp change:** `Health.current += delta` (preserve absolute
HP, not percentage), never resets to full. Cap: `current = min(current, max)`.

**Armor formula:** `damageTaken = max(1, incomingDamage - armor)` (unchanged).

### Damage Scaling (typed, fail-closed)

`applyDamage(world, target, amount, x, y, options: DamageOptions)` —
`src/core/apply-damage.ts` — is the single choke point for all damage.
`DamageOptions`:

```typescript
interface DamageOptions {
  origin: 'player' | 'enemy' | 'environment';
  affinity: 'physical' | 'magic' | 'unscaled';
  scaleWithPrimary: boolean; // apply the typed-primary multiplier?
  canCrit: boolean; // roll a crit?
  weaponGoreFactor?: number;
  sourceX?: number;
  sourceY?: number;
  sourceEid?: number;
}
```

- **Fail-closed:** numeric zero decodes to `origin: 'environment'`,
  `affinity: 'unscaled'`, `scaleWithPrimary: false`, `canCrit: false` — an
  untagged/fresh/recycled entity can never accidentally scale or crit.
- **Only `origin === 'player'` damage against an `Enemy` target** (never a
  `Player` target) gets the generic offense step, the optional typed-primary
  multiplier, and the optional crit roll:
  `finalAmount = (base + damageBonus) × (1 + damagePercent) ×
[scaleWithPrimary ? typedPrimaryMultiplier : 1]`, then
  `[canCrit ? critRoll(critChance, critMultiplier) : finalAmount]`.
- **Typed-primary multiplier** (`computeTypedPrimaryMultiplier`,
  `src/shared/stats.ts`): `physical → 1 + effectiveStrength × 0.01`,
  `magic → 1 + effectiveIntelligence × 0.01`, `unscaled → 1`. Strength never
  affects magic damage; Intelligence never affects physical damage.
- **Player dodge** is independent of `options` — gated only on the target
  being `Player` with `EffectiveStats`, rolled against `dodgeChance`.
- **Persisted `DamageMeta`** (`src/core/damage-meta.ts`, an ECS store)
  carries this metadata onto delayed damage-bearing entities (player
  projectiles, `AreaDamage` explosions from traps/AoE-on-impact) so a single
  collision-resolution system can handle multiple weapon types generically.
  Melee swings, beams, and instant weapon/spell hits tag inline at the one
  dispatch choke point (`weaponSystem.dispatchAttackInner`, `affinity` keyed
  off `WeaponType.MAGIC`). Recycled entity IDs are cleared automatically by
  the existing generic `clearEntityStores` sweep.
- **Corpse-burst and spawner early-return ordering are unchanged** — a
  death-lingering corpse bursts on any hit before any scaling/crit/RNG runs.

### Spell / Magical Ability Output Scaling

Every magical ability's numeric output (damage, healing, duration, radius,
knockback, slow, etc.) is authored inline as `{ base, scalesWithIntelligence:
boolean }` in its `CatalogEffect` (`src/shared/progression-effects.ts`,
`src/game/abilities/registry.ts`), so each field explicitly declares whether
it scales — no ability quietly inherits scaling by accident.

- Resolved once through `resolveScalableOutput(output, effectiveIntelligence)`
  = `scalesWithIntelligence ? base × (1 + effectiveIntelligence × 0.01) :
base` — the **same** `INT_MAGIC_STRENGTH_RATE` a magic weapon's typed
  multiplier uses, so a magic weapon and a spell apply byte-identical
  post-gear scaling (`tests/unit/magic-scaling-parity.test.ts`).
  `resolveScalableOutputRounded` additionally rounds to the nearest integer
  (damage/heal/duration-style outputs).
- A spell's damage packet applies `applyDamage` with `affinity: 'magic'`,
  `scaleWithPrimary: false` (the INT scaling already happened in
  `resolveScalableOutput`, avoiding double-scaling), `canCrit: true`.
- A magic **weapon**'s packet (fireball wand, laser) uses `scaleWithPrimary:
true` instead — its raw base damage has not yet been INT-scaled, so
  `applyDamage` applies the typed multiplier itself.
- Life-drain heals resolve from their own authored `{base,
scalesWithIntelligence}`, independent of the damage dealt that frame.

### Weapon Cadence & Movement Formulas

- **Weapon fire cadence:** `applyAttackSpeedAndCooldownReduction(
baseCooldownMs, attackSpeedBonus, cooldownReduction) = baseCooldownMs / (1 +
max(-0.9, attackSpeedBonus)) × (1 - cooldownReduction)`, rounded once at the
  end (no early rounding between the two factors). `attackSpeedBonus` is
  guarded to stay `> -1` via the `-0.9` floor so the division can never blow
  up or flip sign.
- **Ability cooldowns** keep the separate, pre-existing
  `applyCooldownReduction(baseDuration, reduction) = baseDuration × (1 -
reduction)` — no attack-speed factor, preserving prior snapshot semantics.
- **Move speed:** `computeMoveSpeed(world, eid, baseSpeed) = baseSpeed × (1 +
moveSpeedBonus) × statusMultiplier × encumbranceMultiplier` — Dexterity/
  equipment/modifier bonus and status effects (haste/slow) fold in first;
  encumbrance is always the last factor applied.

### Encumbrance (wired, currently inert)

- **Pure math** (`src/shared/encumbrance.ts`): thresholds = body weight + 40
  / 80 / 120 lb + 5 lb per effective Strength point. Bands (inclusive upper
  boundary): `unburdened` (×1.0) ≤ first threshold; `encumbered` (×0.85) ≤
  second; `heavy` (×0.70) ≤ third; `overloaded` (×0.70) above the third.
- **ECS snapshot** (`src/core/encumbrance.ts`,
  `getEntityEncumbranceSnapshot`): total mass = ECS `Weight.value` (body mass)
  - deduped equipped-item weight. `computeEquippedWeightLb`
    (`src/core/effective-stats.ts`) dedupes by equipment **instance**, so a
    two-handed item occupying 2 slots counts its `weightLb` once, not twice.
- **`EquipmentItemDef.weightLb`** is a **required** field on every equipment
  definition. Every shipped item explicitly sets `weightLb: 0` — encumbrance
  is fully wired but always resolves to the unburdened (×1) band in real play
  today, pending future non-zero item weights.
- **`EquipmentUI`** displays equipped weight, total mass, and the current
  band, sourced from the same `getEntityEncumbranceSnapshot` the movement
  pipeline reads — the two can never disagree.

### Mana — removed entirely

There is **no mana/MP resource** in Crawler. Ability access (spells) is
gated purely by unlock progression (`world.featureUnlocks.spells`,
`memorizeSpell`) and per-ability cooldown — never a second resource pool.
`world.playerMp`/`playerMaxMp`, `shared/mana.ts`, `manaSystem`, `mpCost` (on
every ability), the HUD mana bar, the mana-flask consumable, and the
mana-lab are all deleted (superseded ADR 0019). A recursive deterministic
source scan (`tests/unit/no-mana-remains.test.ts`) guards the codebase
against regression.

### Skill System

- Skills are data-driven definitions in a skill registry
- **Player-only in v1** — enemies do not have skills
- **Skills level up by USAGE** — tracked via usage events emitted to `world.skillUsageEvents`
- Valid usage must be combat-relevant (hits landed, not shots fired; damage dealt; dodge near threat)
- Usage events are processed by `skillSystem` and cleared each frame
- A skill's `perLevelBonus`/milestone `MilestoneEffect` still targets a
  legacy `StatKey` (e.g. `{ damage: 2 }`) — these fold into `EffectiveStats`
  via `foldLegacyStatModifier` exactly like ability/floor modifiers (see
  EffectiveStats section above), NOT a separate skill-stat pipeline.

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
- `statSystem` (the per-frame EffectiveStats recompute) → **`src/core/systems/`**
  (no longer a game-layer system — see EffectiveStats section)
- `spendPoints` / `addStatModifier` / `removeStatModifiers` (allocation APIs,
  no computational system) → `src/game/systems/statsSystem.ts`
- `skillSystem` → `src/game/systems/`
- Skill registry data → `src/game/skills/`
- Math helpers (XP threshold formula, stat rate constants, damage/output
  scaling formulas, encumbrance bands) → `src/shared/` (pure, importable everywhere)

### ECS Components & Stores

```typescript
// Component tags
export const BaseStats = {}; // entity has authored base primary stats
export const EffectiveStats = {}; // entity has the derived runtime snapshot (SOLE stat store)
export const DamageMeta = {}; // entity persists fail-closed damage-scaling metadata
export const SkillHolder = {}; // entity has skills (player-only v1)
// NOTE: there is no `Stats` tag/store — deleted by the overhaul.

// Stores — all Float32Array unless noted
baseStats: Record<StatId, Float32Array>; // authored base values (DEFAULT_BASE_STATS)
effectiveStats: Record<StatId, Float32Array>; // the SOLE runtime snapshot every system reads
coreStatPoints: Record<PrimaryStatId, Float32Array>; // allocated level-up points, per primary
damageMeta: {
  origin: Uint8Array; // 0 environment / 1 player / 2 enemy
  affinity: Uint8Array; // 0 unscaled / 1 physical / 2 magic
  scaleWithPrimary: Uint8Array; // 0/1
  canCrit: Uint8Array; // 0/1
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

**`clearEntityStores` zeroes every typed array (including `damageMeta`) for
recycled EIDs** — a recycled entity can never leak a previous entity's
damage-scaling metadata (it decodes fail-closed from zero).

### Modifier Records

Modifiers are stored as a world-level list (not ECS), player-only in v1:

```typescript
interface StatModifier {
  sourceType: 'skill' | 'floor' | 'buff' | 'ability';
  sourceId: string;           // e.g. 'swordsmanship' or 'fire-floor'
  stat: StatKey;              // legacy target key — folds into EffectiveStats
  op: 'add' | 'multiply';
  value: number;
  expiresFrame?: number;      // undefined = permanent until explicitly removed
}

world.statModifiers: StatModifier[];
```

Expired modifiers are filtered out by `core/systems/statSystem.ts` before
computing (every frame — there is no dirty flag anymore, `statSystem` always
recomputes).

### Stat Key Type

```typescript
// Primary (allocatable, except charisma) stats:
export const PRIMARY_STATS = [
  'strength',
  'dexterity',
  'constitution',
  'intelligence',
  'wisdom',
  'charisma',
  'luck',
] as const;

// Secondary (derived/gameplay) stats:
export const SECONDARY_STATS = [
  'armor',
  'damageBonus',
  'damagePercent',
  'attackSpeed',
  'moveSpeed',
  'critChance',
  'critMultiplier',
  'dodgeChance',
  'hpRegen',
  'xpBonus',
  'cooldownReduction',
  'maxHp',
  'accuracy',
  'pickupRange',
  'projectileSpeed',
  'projectileCount', // inert snapshot fields
] as const;

// Legacy StatModifier/CatalogEffect target keys (fold into EffectiveStats):
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
  perLevelBonus: Partial<Record<StatKey, number>>; // added each level (folds into EffectiveStats)
  milestones: SkillMilestone[];
  flavorText?: string;
}

type UsageMetric = 'hits_landed' | 'damage_dealt' | 'distance_dodged_near_threat' | 'weapon_fired';

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

core/systems/statSystem(world)  — the ONLY per-frame EffectiveStats recompute
  ├─ prunes expired world.statModifiers (no dirty-flag gating — always recomputes)
  ├─ for [Equipment, BaseStats, EffectiveStats] entities (player only in practice):
  │    calls computeEffectiveStatsFromLoadout(base, coreStatPoints, equippedBonuses, activeModifiers)
  ├─ captures prevMaxHp before recompute, syncs Health.max/current by delta (floor 1)
  └─ writes: effectiveStats store

game/systems/statsSystem.ts (allocation APIs only — NOT a (world)=>void system)
  ├─ spendPoints(world, allocations): validates unspentPoints + isAllocatablePrimaryStat, writes coreStatPoints
  ├─ addStatModifier(world, modifier): pushes to world.statModifiers
  └─ removeStatModifiers(world, sourceType, sourceId): filters world.statModifiers

skillSystem(world)
  ├─ reads: world.skillUsageEvents (then clears them)
  ├─ accumulates usage per skill in world.playerSkills
  ├─ level-ups: check thresholds, clamp to min(naturalCap + itemBonus, hardCap)
  ├─ on level-up: push StatModifier to world.statModifiers (folds into EffectiveStats next statSystem tick)
  └─ on milestone first-reach: fire effect, add to triggeredMilestones
```

### Integration Points

- `weaponSystem` reads `effectiveStats.attackSpeed`/`cooldownReduction`
  (cadence), `effectiveStats.accuracy`, `effectiveStats.strength`/
  `intelligence` (typed-primary multiplier at damage resolution), tags
  `DamageMeta` at its one dispatch choke point
- `core/movement-speed.ts#computeMoveSpeed` reads `effectiveStats.moveSpeed`,
  status effects, and `core/encumbrance.ts`'s multiplier
- `core/systems/statSystem.ts` reads `effectiveStats.maxHp` for the HP-delta
  sync; `equipmentSystem.initializeBaseStats` seeds spawn HP to it
- `core/apply-damage.ts` reads `effectiveStats.damageBonus`/`damagePercent`/
  `critChance`/`critMultiplier`/`dodgeChance`/`strength`/`intelligence`
  (gated by `DamageOptions`, see Damage Scaling above); emits skill usage events
- `xpPickupSystem` reads `effectiveStats.pickupRange` for gem magnet radius (inert; always 0)
- `game/systems/progressionEffects.ts` reads `effectiveStats.intelligence` for
  every spell's `resolveScalableOutput` call
- `EquipmentUI` reads `core/encumbrance.ts#getEntityEncumbranceSnapshot` for
  its equipped-weight/total-mass/band display

## Test Plan

### Unit Tests (tests/unit/)

- `stats-core-formulas.test.ts`: `computeTypedPrimaryMultiplier` STR/INT
  affinity separation, `applyAttackSpeedAndCooldownReduction` exact formula/
  clamp/no-early-rounding, `resolveScalableOutput(Rounded)`,
  `foldLegacyStatModifier` mapping table
- `magic-scaling-parity.test.ts`: magic weapon vs spell apply the identical
  effective-Intelligence rate
- `encumbrance.test.ts` (`tests/ecs/`): pure band/threshold math, multi-slot
  weight dedupe, ECS boundary crossings, movement-order (encumbrance last)
- `no-mana-remains.test.ts`, `no-legacy-stats-store-remains.test.ts`:
  deterministic repo-wide scans guarding mana/`stores.stats` regressions
- `xp-math.test.ts`: `xpForLevel(n)` formula correctness, threshold cumulative vs per-level
- `auto-stat-allocation.test.ts`: default AI allocator sequence + offense
  STR/INT branching by active weapon type

### Unit Tests (tests/game/, tests/ecs/)

- `stats-system.test.ts`: EffectiveStats derivation, `spendPoints`/
  `addStatModifier`/`removeStatModifiers` folding, non-allocatable Charisma,
  clamp enforcement, expired-modifier pruning
- `effective-stats.test.ts`: base+allocated+gear composition, Luck/Dexterity/
  Wisdom secondary derivation, Strength/Intelligence typed-only payoff
- `level-system.test.ts`: XP threshold calc, level-up detection, multi-level-up batching, unspentPoints accumulation
- `skill-system.test.ts`: Usage tracking, level-up on threshold, natural cap at 15, hard cap at 20, milestones fire once, itemBonus raises effective cap
- `skill-registry.test.ts`: No duplicate IDs, categories valid, thresholds strictly increasing, threshold length == hardCap, all milestones at valid levels

### Property-Based Tests (tests/property/)

- `stats-properties.test.ts`: every EffectiveStats field respects its
  configured clamp under arbitrary allocation; a positive additive legacy
  modifier never decreases its folded field
- Skill level never exceeds `min(naturalCap + itemBonus, hardCap)` regardless of usage
- XP thresholds are strictly increasing

### Labs

- `stats-lab`: allocate core stat points, add temporary legacy modifiers, see
  EffectiveStats derive live (core `statSystem`)
- `stat-lab`: equip/unequip gear (including `weightLb`), see EffectiveStats
  and encumbrance recompute
- `level-up-lab`: drives the real `LevelUpUI` allocation overlay against a
  synthetic world, confirming through `spendPoints` + core `statSystem`
- `xp-curve-lab`: Visualize XP-per-level curve, tweak BASE_PER_LEVEL & SCALING_FACTOR live, projected time-to-level at various kill rates, overlay floor duration windows
- `skill-lab`: Browse skill catalog, simulate usage, see level-ups and milestone fires
- `abilities-lab`: exercise every ability (active/passive/spell) against
  configurable enemy scenarios — no MP gating, unlock + cooldown only

## Constitutional Compliance

| Principle                   | Compliance                                                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| §1 Agent = Model + Harness  | Skill registry is TS data, not LLM-generated at runtime                                                                            |
| §2 Lab-Gated Development    | Labs cover stats/level-up/equipment/abilities/skills/xp-curve; mana-lab deleted (no mana)                                          |
| §3 Deterministic CI         | All tests deterministic, no LLM-as-judge                                                                                           |
| §4 Deterministic Game Logic | Stat/damage/output math is pure functions of input; no `Date.now()`/`Math.random()`; usage events are frame-ordered                |
| §5 ECS-Phaser Bridge        | Core stat/damage systems in `src/core/`, allocation APIs + skills in `src/game/`, no Phaser imports; math helpers in `src/shared/` |
| §6 AI Content During Load   | Skill flavor text is static data                                                                                                   |
| §9 Coverage Requirements    | Target 90%+ for all new game systems                                                                                               |
| §10 Hashimoto's Loop        | Tests cover edge cases surfaced by antagonistic review                                                                             |
