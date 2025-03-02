# Spec: Character Equipment System

## Context

Crawler's characters need a full equipment system befitting a dungeon crawler. Currently, the weapon system (`src/game/weaponSystem.ts`) uses a flat `WeaponConfig` per world — there's no concept of equippable items, gear slots, or stat modifiers from equipment. This spec introduces a slot-based equipment model that enables deep itemisation, build diversity, and future mechanics like slot disabling (e.g. losing a finger).

## Requirements

### Equipment Slots

Slots are defined in a **data-driven slot registry** — a plain array/map of slot definitions. Adding a new slot requires appending to the registry and updating any UI/layout/content that wants to expose it, but does not require changing core equip/unequip/stat logic.

#### V1 Slot Registry

| Slot ID     | Label      | Body Group | Notes                          |
| ----------- | ---------- | ---------- | ------------------------------ |
| `head`      | Head       | head       | Helmets, crowns, masks         |
| `face`      | Face       | head       | Goggles, face paint, masks     |
| `neck`      | Neck       | torso      | Amulets, necklaces, collars    |
| `shoulders` | Shoulders  | torso      | Pauldrons, epaulets            |
| `chest`     | Chest      | torso      | Armour, robes, harnesses       |
| `back`      | Back       | torso      | Cloaks, wings, backpacks       |
| `arms`      | Arms       | arms       | Bracers, vambraces             |
| `wrists`    | Wrists     | arms       | Wrist guards, bracelets        |
| `gloves`    | Gloves     | hands      | Gauntlets, gloves              |
| `mainHand`  | Main Hand  | hands      | Primary weapon                 |
| `offHand`   | Off Hand   | hands      | Shield, secondary weapon, tome |
| `ringLeft`  | Left Ring  | hands      | Ring                           |
| `ringRight` | Right Ring | hands      | Ring                           |
| `belt`      | Belt       | torso      | Belts, sashes                  |
| `legs`      | Legs       | legs       | Greaves, leggings, pants       |
| `feet`      | Feet       | legs       | Boots, sandals, greaves        |

```typescript
interface SlotDefinition {
  id: string; // unique slot key
  label: string; // display name
  bodyGroup: string; // grouping for UI layout and future mechanics
  /** Paper doll position hint (normalised 0–1 coords relative to doll bounds) */
  uiPosition: { x: number; y: number };
}

/** The slot registry — append-only. */
const SLOT_REGISTRY: SlotDefinition[] = [
  /* ...v1 slots above... */
];

/** Derived type from registry keys. Extensible by appending to SLOT_REGISTRY. */
type EquipmentSlotId = string; // validated against SLOT_REGISTRY at runtime
```

#### Adding Slots Later

To add new slots (e.g. `trinket1`, `earLeft`, `ammo`):

1. Append to `SLOT_REGISTRY`.
2. Existing `EquipmentState` is forward-compatible — new slots default to `null` (unequipped) and enabled.
3. No migration needed for existing item definitions — they reference only the slots they use.

### Multi-Slot Items

An item may declare it **occupies** multiple slots. When equipped:

- All occupied slots are filled by the same item reference.
- Unequipping frees all occupied slots.
- An item cannot be equipped if **any** of its required slots are already occupied (unless swapping).

Examples:

- Two-handed weapon → occupies `mainHand` + `offHand`.
- Full plate armour → occupies `chest` + `arms` + `shoulders`.
- Long gloves → occupies `gloves` + `wrists`.

### Slot Disabling (Deferred)

> **Deferred to a future spec.** Slot disabling (injuries, curses, mutations) is not part of v1. The `EquipmentState` type reserves a `disabledSlots` field for forward-compatibility, but `disableSlot`/`enableSlot` operations, forced unequip behaviour, and related tests are not implemented in v1.

### Stats

Equipment may grant bonuses to **primary stats** and/or **secondary stats**.

#### Primary Stats

| Stat ID        | Label        | Effect Summary                                                                                    |
| -------------- | ------------ | ------------------------------------------------------------------------------------------------- |
| `strength`     | Strength     | +1% physical damage per effective point (typed-primary multiplier; no armor, no flat damage)      |
| `dexterity`    | Dexterity    | +1% attack speed, +0.25% move speed, +0.25pp accuracy, +1/300 (~0.33pp) dodge per effective point |
| `constitution` | Constitution | +10 max HP per effective point                                                                    |
| `intelligence` | Intelligence | +1% magic strength per effective point (typed-primary multiplier for magic weapons/spells)        |
| `wisdom`       | Wisdom       | +0.5pp cooldown reduction per effective point (cap 80%)                                           |
| `charisma`     | Charisma     | Visible, intentionally zero gameplay effect; not allocatable                                      |
| `luck`         | Luck         | +0.25pp crit chance per effective point (cap 100%)                                                |

> `weight` is **not** a primary stat (removed by the primary-stat overhaul —
> see `docs/knowledge/adr/2026-07-16-primary-stat-system-overhaul.md`). Item
> mass is a **separate** required field, `EquipmentItemDef.weightLb` (see
> below), feeding the encumbrance system documented in the
> [Stats, Skills & Leveling spec](stats-skills-levels.md) — not a primary
> stat bonus.

#### Secondary Stats (derived / granted by items)

| Stat ID             | Label              | Notes                                     |
| ------------------- | ------------------ | ----------------------------------------- |
| `armor`             | Armor              | Flat damage reduction                     |
| `damageBonus`       | Damage Bonus       | Additive bonus to outgoing damage         |
| `damagePercent`     | Damage %           | Multiplicative outgoing-damage scaler     |
| `attackSpeed`       | Attack Speed       | Modifier to fire rate / swing cooldown    |
| `moveSpeed`         | Move Speed         | Movement speed modifier                   |
| `critChance`        | Crit Chance        | Percentage chance for critical hit        |
| `critMultiplier`    | Crit Multiplier    | Damage multiplier on critical hit         |
| `dodgeChance`       | Dodge Chance       | Percentage chance to evade an attack      |
| `hpRegen`           | HP Regen           | Health regenerated per second             |
| `xpBonus`           | XP Bonus           | Multiplier to XP gained                   |
| `cooldownReduction` | Cooldown Reduction | Percentage reduction on ability cooldowns |

Items declare stat bonuses as a flat map: `{ strength: 5, armor: 3, critChance: 0.02 }`.

### Base Stats vs Effective Stats

Stat computation uses two distinct layers to prevent double-counting:

- **`BaseStats`** store: Intrinsic character stats (set at creation, modified by level-ups/buffs — never by equipment).
- **`EffectiveStats`** store: Computed result = `BaseStats + Σ equipment bonuses`. This is what downstream systems read.

Recomputation always starts from `BaseStats` and sums all equipped item bonuses. Equipment bonuses are never written back into `BaseStats`.

### Stat Semantics & Stacking

Equipment item bonuses are **additive flat values** in v1. Multiplicative behavior is provided by explicitly fractional stats (for example `damagePercent`, `critChance`, and `cooldownReduction`) and by downstream formulas that consume them.

| Stat                | Unit / Type   | Clamp Range   | Notes                           |
| ------------------- | ------------- | ------------- | ------------------------------- |
| `strength` etc.     | Flat integer  | [0, ∞)        | Primary stats; floor at 0       |
| `armor`             | Flat integer  | [0, ∞)        | Damage reduction points         |
| `damageBonus`       | Flat number   | (-∞, ∞)       | Can be negative (cursed items)  |
| `damagePercent`     | Decimal       | [0, ∞)        | Multiplicative damage scalar    |
| `attackSpeed`       | Flat number   | Added to base | Higher = faster; floor at 0.1   |
| `moveSpeed`         | Flat number   | Added to base | Higher = faster; floor at 0     |
| `critChance`        | Decimal [0–1] | [0, 1]        | Clamped percentage              |
| `critMultiplier`    | Decimal       | [1, ∞)        | Additive to base 1.0; floor 1.0 |
| `dodgeChance`       | Decimal [0–1] | [0, 0.75]     | Hard cap at 75%                 |
| `hpRegen`           | HP/sec        | [0, ∞)        | Floor at 0                      |
| `xpBonus`           | Decimal       | [0, ∞)        | Additive percentage; 0.1 = +10% |
| `cooldownReduction` | Decimal [0–1] | [0, 0.80]     | Hard cap at 80%                 |

Primary stats can derive secondary stats via the shared stat pipeline (e.g. strength contributes to `damagePercent`; luck contributes to `critChance` and `pickupRange`).

### V1 Stat Formulas (Downstream Integration)

These formulas define how `EffectiveStats` modify existing systems:

```
// Weapon cooldown system (weaponSystem.ts)
effectiveFireRateMs = baseCooldownMs * (1 - cooldownReduction)

// Damage choke point (apply-damage.ts)
outgoingDamage     = max(0, (baseDamage + damageBonus) * (1 + damagePercent))
isCrit             = world.rng.next() < critChance   // uses SeededRandom
critDamage         = outgoingDamage * critMultiplier

// Damage system (healthSystem.ts)
incomingDamage     = max(1, rawDamage - armor)        // minimum 1 damage
isDodged           = world.rng.next() < dodgeChance   // uses SeededRandom

// Movement (playerInputSystem.ts)
effectiveSpeed     = max(0, baseSpeed + moveSpeed)

// Health regen
hpPerFrame         = hpRegen * (deltaMs / 1000)

// XP collection
effectiveXp        = baseXpValue * (1 + xpBonus)
```

**Integration points** (existing systems to update):

- `weaponSystem.ts` → read `EffectiveStats` for `cooldownReduction`
- `abilitySystem.ts` → read `cooldownReduction` for effective ability cooldown windows (snapshotted per active cooldown)
- `apply-damage.ts` → read `damageBonus`, `damagePercent`, `critChance`, `critMultiplier`
- `healthSystem.ts` → read `armor`, `dodgeChance`, `hpRegen`
- `playerInputSystem.ts` → read `moveSpeed`
- XP collection (when implemented) → read `xpBonus`
- `BroadcastScore` → read `charisma` bonus (future)

Stats are read live from `EffectiveStats` by default; the explicit exception is ability cooldown windows, where `abilitySystem` snapshots the computed cooldown duration at cast time to keep HUD and gating semantics aligned for that window. Projectiles still snapshot spawn-time base damage, but `apply-damage.ts` reads live `damageBonus`/`damagePercent`/crit stats at hit time.

### Default Base Stats

Entities must be initialized with `initializeBaseStats(world, entity, defaults)` before using the stat system. Default values:

```typescript
const DEFAULT_BASE_STATS: Record<StatId, number> = {
  // Primary (all start at 1 — effective value = base(1) + allocated + gear)
  strength: 1,
  dexterity: 1,
  constitution: 1,
  intelligence: 1,
  wisdom: 1,
  charisma: 1,
  luck: 1,
  // Secondary
  armor: 0,
  damageBonus: 0,
  damagePercent: 0,
  attackSpeed: 0,
  moveSpeed: 0,
  critChance: 0.05,
  critMultiplier: 1.5,
  dodgeChance: 0,
  hpRegen: 0,
  xpBonus: 0,
  cooldownReduction: 0,
  maxHp: 160, // + 10 per effective Constitution point (base CON=1 -> 170 HP)
  accuracy: 0,
  // Inert snapshot fields (no current derivation/consumer)
  pickupRange: 0,
  projectileSpeed: 0,
  projectileCount: 0,
};
```

These defaults ensure typed-array zero-init for most stats is safe, with the exception of `critMultiplier` (base 1.5) and `critChance` (base 0.05) which must be explicitly set via `initializeBaseStats`.

### Equipment Item Definition

```typescript
interface EquipmentItemDef {
  /** Unique item definition ID (shared across copies of the same item) */
  id: string;
  /** Display name */
  name: string;
  /** Slots this item occupies when equipped (first slot is "primary"). Must be non-empty, no duplicates. */
  slots: EquipmentSlotId[];
  /** Stat bonuses granted while equipped */
  statBonuses: Partial<Record<StatId, number>>;
  /** Item mass in pounds — REQUIRED. Every shipped def currently sets 0 (encumbrance is
   *  wired but inert until real item weights land). Deduped by equipment instance for
   *  multi-slot items — see core/effective-stats.ts#computeEquippedWeightLb. */
  weightLb: number;
  /** Item rarity tier */
  rarity: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
  /** Optional tags for synergy / crafting systems */
  tags?: string[];
  /** Equip requirements — all must pass for equip to succeed */
  requirements?: EquipRequirement[];
}
```

### Equip Requirements (Dynamic Rules)

Items can declare **requirements** that are evaluated at equip time. If any requirement fails, equip is denied and the reason is returned.

```typescript
type EquipRequirement =
  | { type: 'minLevel'; value: number } // reserved in v1 (currently no-op until level component wiring exists)
  | { type: 'maxLevel'; value: number } // reserved in v1 (currently no-op until level component wiring exists)
  | { type: 'minStat'; stat: StatId; value: number } // base stat must be ≥ value
  | { type: 'hasTag'; tag: string } // entity must have tag (e.g. 'male', 'undead', 'class:mage')
  | { type: 'notTag'; tag: string } // entity must NOT have tag
  | { type: 'custom'; id: string }; // lookup in custom requirement registry
```

#### Examples

```typescript
// Reserved for future level-component wiring
{ type: 'minLevel', value: 5 }

// Requires 10 strength
{ type: 'minStat', stat: 'strength', value: 10 }

// Not equippable by males
{ type: 'notTag', tag: 'male' }

// Only for mage class
{ type: 'hasTag', tag: 'class:mage' }
```

#### Custom Requirements

The `custom` requirement type looks up a predicate function in a **requirement registry** (`Map<string, (world, entity, itemDef) => boolean>`). This allows game-specific rules that can't be expressed as simple data (e.g. "only if you've completed quest X", "only during a full moon floor").

The requirement registry is extensible — new predicates can be registered at runtime without modifying the equipment system.

### Equipment Instance

Each equipped item gets a unique **instance ID** (monotonic counter per world) so that two copies of the same item definition (e.g. two identical rings) are tracked independently.

```typescript
type EquipmentInstanceId = number;

interface EquipmentInstance {
  instanceId: EquipmentInstanceId;
  def: EquipmentItemDef;
}
```

### Equipment State per Entity

```typescript
interface EquipmentState {
  /** Map of slot → equipped instance ID (or null) */
  equipped: Record<EquipmentSlotId, EquipmentInstanceId | null>;
  /** Registry of instance ID → full instance (source of truth for stats/slots) */
  instances: Map<EquipmentInstanceId, EquipmentInstance>;
  /** Set of currently disabled slot IDs */
  disabledSlots: Set<EquipmentSlotId>;
}
```

### Core Operations

| Operation                          | Preconditions                                  | Effects                                                  |
| ---------------------------------- | ---------------------------------------------- | -------------------------------------------------------- |
| `equip(world, entity, itemDef)`    | All required slots free, all requirements pass | Sets item in all slots, recalculates stats               |
| `unequip(world, entity, slotId)`   | Slot has an item                               | Frees all slots the item occupies, recalcs stats         |
| `getEffectiveStats(world, entity)` | —                                              | Returns sum of base stats + all equipment bonuses        |
| `canEquip(world, entity, itemDef)` | —                                              | Returns `CanEquipResult` — checks slots AND requirements |

All operations take `world: GameWorld` as the first argument (required to access the WeakMap side-map and typed-array stores).

### Result Types

```typescript
type EquipResult =
  | { ok: true; instanceId: EquipmentInstanceId }
  | { ok: false; reasons: EquipFailureReason[] };

type EquipFailureReason =
  | { type: 'invalidDef'; message: string } // empty slots, duplicate slots, bad stat values
  | { type: 'unknownSlot'; slotId: string }
  | { type: 'occupiedSlot'; slotId: string }
  | { type: 'requirementFailed'; requirement: EquipRequirement; message: string };

type UnequipResult = { ok: true; item: EquipmentInstance } | { ok: false; reason: string };

type CanEquipResult = {
  allowed: boolean;
  reasons: EquipFailureReason[];
};
```

**Reason ordering** (deterministic): invalidDef → unknownSlot → occupiedSlot → requirementFailed.

### Constraints

- An entity can only equip one item per slot.
- `equip` is **atomic**: it either fully succeeds (all slots filled, stats updated) or fails with no state change. It returns `ok: false` if any required slot is occupied, **or if any equip requirement fails**.
- A **swap** helper may be added later but is not required in v1 — caller unequips first.
- Stats are **recomputed** on every equip/unequip, not cached lazily, to keep determinism simple.
- **Forced unequip** (from future slot disabling) is deferred — see Slot Disabling section.

### Validation Rules

- `itemDef.slots` must be non-empty.
- `itemDef.slots` must not contain duplicate slot IDs.
- Unknown slot IDs (not in `SLOT_REGISTRY`) are rejected at equip time.
- Unknown stat IDs in `statBonuses` are rejected at equip time.
- Non-finite stat values (`NaN`, `Infinity`, `-Infinity`) are rejected at equip time.
- Primary stat bonuses must be integers (fractional values are rejected).

### Stat Aggregation Rule

> Stat aggregation iterates **unique equipped instance IDs**, not slots. Each equipped item contributes its bonuses exactly once, regardless of how many slots it occupies. Multi-slot items are never double-counted.

### Requirement Evaluation

- **`minStat` requirements check current `EffectiveStats`** (including bonuses from already-equipped gear), **excluding** the candidate item's own bonuses. The item being equipped does not bootstrap itself.
- **`minLevel` / `maxLevel` are schema-valid but currently no-op** until level-component wiring lands in the equipment layer.
- **`hasTag` / `notTag`** refer to **entity tags** — a lightweight string set stored per entity in the equipment side-map (e.g. `'male'`, `'undead'`, `'class:mage'`). Entity tags are set at character creation and may be modified by game events. They are distinct from item `tags` (which are for crafting/synergy).
- **Custom predicates** must be pure and deterministic — they receive `(world, entity, itemDef)` and must not use `Math.random()`, `Date.now()`, or mutable globals. The custom requirement registry is scoped per `GameWorld` to prevent test bleed.

### When Equipment Can Change

Equipment changes (equip/unequip) are permitted **only in safe rooms** (`world.state === 'safe_room'`) and in labs. Mid-combat equipment changes are not allowed in v1. The `equip`/`unequip` functions enforce this by checking `world.state` (with a `force` override for lab/test use).

## Floor 2 Generated Equipment Contract

> **Status:** Normative contract for the Floor 2 equipment epic; runtime
> implementation belongs to downstream slices. The shipped numeric
> `EquipmentInstance` above remains the legacy behavior until its feature flag and
> migration path are enabled. See ADR 0065 and
> `docs/knowledge/epics/floor-2-equipment/PLAN.md`.

### Authority and scope

This section is authoritative for generated identity, resolution, ownership,
rewards, economy transactions, deterministic AI consumption, feature flags, and
migration. The weapon-specific frozen snapshot is authoritative in
`weapon-system.md`. Epic counts, stable base IDs, the 37-node DAG, and release
flags remain authoritative in the canonical PLAN.

Unique equipment is not a fourth rarity and is not part of this epic. It is
tracked separately in <https://github.com/nalfeo/Crawler/issues/1274>.

### Versioned identity and single ownership

The first generated schema is `floor2-equipment-instance/v1`.

```typescript
type GeneratedEquipmentInstanceId = `gei:v1:${string}:${number}`;
type GeneratedEquipmentRarity = 'common' | 'uncommon' | 'rare';
type EquipmentFingerprintV1 = `sha256:${string}`;

interface GeneratedEquipmentInstanceV1 {
  readonly schemaVersion: 'floor2-equipment-instance/v1';
  readonly instanceId: GeneratedEquipmentInstanceId;
  readonly contentRevision: number;
  readonly baseId: string;
  readonly itemLevel: number;
  readonly rarity: GeneratedEquipmentRarity;
  readonly enhancementLevel: 0 | 1 | 2 | 3 | 4 | 5;
  readonly resolvedEffects: readonly ResolvedEquipmentEffectV1[];
  readonly frozen: FrozenEquipmentFieldsV1;
  readonly fingerprint: EquipmentFingerprintV1;
}
```

- `instanceId` is allocated deterministically from an immutable run key plus a
  monotonically increasing per-run ordinal. It never uses wall-clock time and
  never changes when the item moves between floors or containers.
- The generated registry is the only owner of full instance records. The bag,
  equipped slots, reward bundles, boss chests, Quartermaster stock, other shop
  stock, and carryover store `instanceId` references only.
- An instance has exactly one ownership container at a time. Multiple equipped
  slots may reference one multi-slot instance; those references count as one
  equipped owner. Any other duplicate ownership is invalid.
- Transfers validate source ownership, destination capacity, and registry
  presence before committing. Failure returns a typed reason and changes nothing.
- `baseId` is immutable provenance. Consumers execute and display `frozen`
  fields; they must not re-resolve behavior from a later catalog revision.
- `contentRevision` starts at zero. A legal enhancement atomically replaces the
  immutable record under the same `instanceId`, increments the revision by one,
  and recomputes the frozen fields and fingerprint. No other transform may mutate
  resolved content.

The fingerprint is lowercase SHA-256 over UTF-8 canonical JSON containing every
field above except `fingerprint`. Object keys are lexicographically sorted,
arrays retain their defined order, finite numbers use their normalized decimal
form, and no `undefined` value is permitted. Ownership container, merchant price,
UI selection, and achievement claim state are excluded so a transfer does not
change item identity or content.

### Deterministic resolution pipeline

Generation resolves in this exact order:

1. **Base template** - load one immutable normalized base by stable `baseId`.
2. **Item level** - validate a positive integer and apply the base's level curve.
3. **Inherent scaling** - resolve inherent damage for weapons and inherent armor
   for armor; non-inherent modifiers are not introduced here.
4. **Rarity scalar and budget** - multiply inherent damage/armor by the rarity
   scalar and allocate the exact effect-unit budget below.
5. **Enhancement +N** - multiply post-rarity inherent damage/armor by
   `1 + (0.05 * N)`.
6. **Affixes/effects** - select legal effects using only `SeededRandom`, consuming
   exactly the rarity budget.
7. **Freeze** - write final stats, display name, art key, grants,
   `ActiveWeaponSnapshot` when applicable, and fingerprint.

No intermediate stage rounds. Freeze applies the existing normalization rule for
each stat; non-negative integral damage/armor rounds once to nearest integer with
an exact `.5` rounded upward. The RNG draw order is part of the generation
version. Loading, rendering, equipping, scoring, claiming, or transferring an
instance consumes no generation draws.

| Rarity   | Inherent scalar | Required effect units |
| -------- | --------------: | --------------------: |
| Common   |            1.00 |                     0 |
| Uncommon |            1.05 |  exactly 1 minor unit |
| Rare     |            1.10 |       exactly 2 units |

- A Rare item may use two legal one-unit effects or one legal two-unit effect.
- Common receives no modifier effect. Inherent weapon damage and inherent armor
  are base properties, not modifier units.
- Duplicate or mutually exclusive effects are illegal. If the eligible pool
  cannot spend the exact budget, generation fails explicitly; it must not
  downgrade rarity, leave budget unspent, or reroll through an unbounded loop.
- Rarities above Rare are invalid for every Floor 2 generation source in this
  epic, even though the legacy `EquipmentItemDef` union contains higher values.

Enhancement is bounded and separate from the rarity effect budget:

- all newly generated reward, chest, drop, and shop instances start at `+0`;
- `N` is an integer from 0 through 5, so the maximum enhancement contribution is
  +25% post-rarity inherent damage/armor;
- enhancement does not change rarity, item level, effect count, effect magnitude,
  art, or prior random choices;
- only a claimed, registry-owned instance with inherent damage or armor is legal;
- cost consumption plus immutable-record replacement is one atomic transaction;
  an invalid target, insufficient cost, or freeze/fingerprint failure changes
  neither resources nor the instance.

### Static definitions, frozen weapons, and grants

Static equipment and `WeaponDef` registries are immutable templates. A
weapon-bearing instance captures `ActiveWeaponSnapshotV1` only at step 7 after all
level, inherent, rarity, enhancement, and effect resolution. Equipped runtime
selection uses the instance ID and its snapshot; it never mutates the static
definition. The snapshot fields and fingerprint contract are in
`weapon-system.md`.

Equipment ability and passive grants are source-owned:

```typescript
type EquipmentGrantSourceId = `equipment:${GeneratedEquipmentInstanceId}:${number}`;
```

- `effectOrdinal` is the stable zero-based position in `resolvedEffects`.
- Grant state maps each ability/passive ID to a set of source IDs. Equipping adds
  each source idempotently; unequipping removes only the exact originating source.
- An ability or passive remains granted while any equipment or non-equipment
  source remains.
- `ACTIVE_ABILITY_SLOT_LIMIT` in `src/shared/abilities.ts` remains authoritative
  at **10**. Equipment does not create extra active slots. A newly granted active
  ability may remain known but inactive when all ten slots are occupied.

### Achievement reward resolution and claims

Achievement equipment rewards use a versioned immutable reward bundle:

- Unlock commits the achievement ID, generated registry records, and bundle
  references in one transaction. Resolution uses the unlock's deterministic
  context exactly once. Failure commits none of those fields and surfaces an
  explicit error for deterministic retry.
- Loading, catalog updates, panel opening, and claim do not regenerate bundle
  contents.
- Claim validates every destination and transfer first, transfers the complete
  bundle, then marks the achievement claimed. Any failure leaves ownership,
  inventory, registry, and claim state unchanged. Repeated successful claims are
  rejected as `alreadyClaimed`.
- Floor 1 loot boxes have a 0% equipment outcome, including during a Floor 1 ->
  Floor 2 carryover.
- Floor 2 Common, Uncommon, and Rare boxes have respectively 25%, 50%, and 75%
  equipment affinity. Affinity is the chance that the box's eligible reward slot
  resolves to equipment of the same rarity; the complementary outcome uses the
  existing non-equipment reward table.
- Floor 2 ships exactly 30 floor-local achievements: 10 Common-tier, 10
  Uncommon-tier, and 10 Rare-tier. It additionally ships exactly 6
  current-run-global achievements.
- Current-run-global unlock, resolved bundle, and claim state carry across floor
  transitions in the same run and reset only when a new run is created. Floor-local
  achievement evaluation does not continue outside its owning floor.

### Settlement stock, boss chest, and shared purchase

- Every Floor 2 settlement contains exactly one Quartermaster plus a seeded
  selection of one or two non-Quartermaster shops.
- Equipment stock is generated once for that shop/settlement state and remains
  frozen. Stock rarity is Common or Uncommon only.
- A stock item's level is selected from
  `max(1, playerLevel - 1)..playerLevel + 1` at stock generation. Later player
  levels do not mutate or reroll existing stock.
- The Floor 2 boss chest chooses equipment rarity with the exact table 85%
  Uncommon / 15% Rare. The seeded roll is made once when chest contents resolve.
- All player and AI callers use one shared
  `purchaseEquipment(world, buyerEid, shopId, stockEntryId)` transaction. It
  validates stock identity, funds, destination capacity, generated-registry
  ownership, and feature flags before mutation. Success deducts the price,
  removes exactly one stock reference, and transfers exactly that instance.
  Failure changes nothing. Direct bag, gold, or stock mutation is forbidden.

### Normalized launch catalog

The launch catalog contains at least 70 normalized bases:

- exactly 50 weapon bases, with exactly 5 bases in each stable family:
  `blade`, `axe`, `bludgeon`, `polearm`, `bow`, `firearm`, `thrown`,
  `magic-focus`, `beam`, and `trap`;
- at least 20 non-weapon bases distributed across existing equipment slots.

A normalized base is one stable base ID, one template, and one base art key.
Levels, rarities, enhancements, affixes, rolled names, and generated copies never
increase the base count. Base IDs are append-only and may not be renamed or
recycled.

### Deterministic AI evaluation and maintenance

AI equipment choice is based on deterministic expected run value (ERV) computed
from frozen instances, the current loadout, remaining deterministic encounter
fixtures, displacement cost, purchase cost, and a committed evaluator config.
It never samples a realized combat roll while comparing items. Equal scores
break ties by fingerprint and then instance ID.

An equipment-maintenance route is optional, not a higher-priority safety or
critical-progression goal:

- it may enter only when no safety override or critical progression objective is
  active and a reachable candidate has positive ERV after cost;
- entering latches one shop/stock target; ordinary score noise cannot change the
  target until the named minimum-latch duration expires;
- a separate lower release threshold provides hysteresis, and completion,
  invalidation, or failed purchase starts a named cooldown before reevaluation;
- H1 owns the committed numeric latch, threshold, and cooldown tuning, but these
  enter/latch/release/cooldown transitions are mandatory;
- travel must call the existing `planObjectiveRoute`; purchase and equip must call
  public shared APIs. Teleporting, direct inventory/equipment mutation, or a
  second route planner is forbidden.

### Feature flags and compatibility

All flags default false and apply only to Floor 2:

| Flag                           | Required enabled dependencies         |
| ------------------------------ | ------------------------------------- |
| `floor2EquipmentRegistry`      | none                                  |
| `floor2EquipmentCatalog`       | registry                              |
| `floor2EquipmentRewards`       | registry, catalog                     |
| `floor2EquipmentEconomy`       | registry, catalog                     |
| `floor2EquipmentUx`            | registry, catalog                     |
| `floor2EquipmentWorld`         | registry, catalog                     |
| `floor2EquipmentAiMaintenance` | registry, catalog, economy, UX, world |

- Enabling a flag without its dependency closure is a configuration error, not a
  request to auto-enable dependencies.
- Disabling a consumer stops new generation and mutation through that consumer.
  It does not delete, rewrite, downgrade, or reroll persisted v1 records.
- Floor 1 remains on the legacy static-item path and exposes no generated
  equipment boxes, stock, drops, affordances, or AI maintenance regardless of
  Floor 2 flag values.
- Legacy world-local numeric `EquipmentInstance` records are v0. A supported v0
  -> v1 migration is deterministic, idempotent, preserves equipped slot
  occupancy, and performs no random generation. Legacy copies that lack resolved
  provenance remain on the legacy path unless an explicit mapping exists.
- Saves and carryover reject unknown future generated schema versions with a
  typed compatibility error. They never treat an unknown version as v1 and never
  fall back to rerolling from `baseId`.
- Feature-off and older-consumer paths must round-trip recognized v1 records
  opaquely so temporarily disabling a slice does not destroy future-compatible
  state.

## Scope & Future Work

**In scope (v1):**

- Data-driven slot registry (16 v1 slots, easily extensible)
- Multi-slot items with atomic equip/unequip
- Equip requirements (level, stat, tag, custom predicate)
- `canEquip` query for UI/tooltip gating
- Flat additive stat bonuses with clamping
- Base/effective stat separation
- Side-map state with entity cleanup

**Explicitly deferred:**

- Slot disabling (injuries, curses, mutations)
- Additional slot types (trinket/ammo/earring — add to registry when needed)
- Weapon swap sets (mainHand2/offHand2)
- Primary stat → secondary stat derivation formulas
- Swap helper (auto-unequip-then-equip)
- Inventory/drop system (forced unequip returns item via result value)
- Multiplicative stat stacking
- Set bonuses / synergy effects
- Serialization / save-load of equipment state

## Design

### Layer Placement

| Artifact                               | Location                              |
| -------------------------------------- | ------------------------------------- |
| Slot registry + `SlotDefinition`       | `src/shared/equipment-slots.ts`       |
| `EquipmentSlotId` type                 | `src/shared/equipment-slots.ts`       |
| `EquipmentItemDef`, `EquipRequirement` | `src/shared/equipment-types.ts`       |
| `StatId` type + stat tables            | `src/shared/stats.ts`                 |
| `Equipment` component tag              | `src/core/components.ts`              |
| Equipment store (typed arrays)         | `src/core/components.ts` (stores)     |
| Equipment logic (pure fns)             | `src/core/systems/equipmentSystem.ts` |
| Equip requirement evaluator            | `src/core/systems/equipmentSystem.ts` |
| Custom requirement registry            | `src/core/systems/equipmentSystem.ts` |
| Stat aggregation system                | `src/core/systems/statSystem.ts`      |
| Equipment lab                          | `src/labs/equipment-lab/`             |

### ECS Integration

- A new **`Equipment`** tag component marks an entity as having equipment.
- Equipment state is stored in a **side map** (`WeakMap<GameWorld, Map<number, EquipmentState>>`) following the same pattern as `weaponSystem.ts`, keeping ECS components slim.
- A new **`BaseStats`** tag component + typed-array store holds intrinsic stat values per entity (never modified by equipment).
- A new **`EffectiveStats`** tag component + typed-array store holds computed stat values (base + equipment).
- **Entity tags** stored as `WeakMap<GameWorld, Map<number, Set<string>>>` for the `hasTag`/`notTag` requirement system.
- The **`statSystem`** runs after `equipmentSystem` each frame (or on-demand after equip/unequip) to aggregate base stats + equipment bonuses into the `EffectiveStats` store.
- **Entity cleanup**: When an entity is destroyed or its `Equipment` component is removed, the side-map entry and entity tags entry are deleted to prevent stale state on entity ID reuse.

#### World Factory Integration Steps

1. Add `BaseStats` and `EffectiveStats` tags to `src/core/components.ts`.
2. Add typed-array stores for all stat fields in `createComponentStores()`.
3. Wire `BaseStats` and `EffectiveStats` stores via `wireStore()` in `createGameWorld()`.
4. Export new components from `src/core/components.ts`.
5. Update `ComponentStores` type (auto-derived from `createComponentStores` return).

### Data Flow

```
equip/unequip called
  → update EquipmentState side-map (equipped slots + instance registry)
  → recompute effective stats (BaseStats + Σ equipment bonuses, with clamping)
  → write into EffectiveStats typed-array store
  → downstream systems (weapon, health, movement) read EffectiveStats store
```

### Multi-Slot Logic

When equipping an item with `slots: ['mainHand', 'offHand']`:

1. Check ALL slots are free AND enabled.
2. Generate a unique equipment instance ID.
3. Write that ID into every slot in `equipped`.
4. On unequip of any one slot, resolve the instance ID → find all slots sharing it → clear all.

### Determinism

- No `Math.random()` — equipment operations are fully deterministic.
- No `Date.now()` — stat recomputation is immediate and frame-independent.
- Same equipment actions in same order produce identical stat outcomes.

### Paper Doll UI

The equipment screen uses a classic **paper doll** layout — a character silhouette surrounded by slot boxes.

#### Layout

```
                 [Head]
          [Face]        [Neck]
        [Shoulders]
  [Back]  [Chest]   [Arms]
          [Belt]    [Wrists]
[MainHand] [  ]  [OffHand]
          [Gloves]
  [RingL]         [RingR]
          [Legs]
          [Feet]
```

- Centre: character silhouette (sprite or placeholder outline).
- Surrounding: slot boxes positioned to match body location.
- Each slot box shows the equipped item icon (or an empty slot icon with the slot label).

#### Slot Box States

| State    | Visual                                                   |
| -------- | -------------------------------------------------------- |
| Empty    | Dimmed outline + slot label text                         |
| Equipped | Item icon + rarity-coloured border                       |
| Hover    | Tooltip with item name, stats, requirements              |
| Invalid  | Red flash when attempting to equip a blocked/failed item |

#### Interactions

- **Click equipped slot** → unequip item (returns to inventory/stash).
- **Click empty slot** → opens filtered item list showing only items valid for that slot.
- **Hover slot** → tooltip shows: item name, rarity, stat bonuses, equip requirements (met/unmet).
- **Drag-drop** (stretch goal) → drag item from inventory to slot. Deferred for v1; click-based flow is sufficient.

#### Stat Panel

Adjacent to the paper doll, a **stat panel** displays:

- All primary stats (base → effective with green/red diff).
- Key secondary stats (armor, crit, dodge, etc.).
- Updates live on equip/unequip.

#### Layer Placement

| Artifact                  | Location                                                  |
| ------------------------- | --------------------------------------------------------- |
| Paper doll rendering      | `src/labs/equipment-lab/index.ts`                         |
| Slot layout config (data) | `src/shared/equipment-slots.ts` (position hints per slot) |
| Equipment UI state bridge | `src/engine/InventoryUI.ts`                               |

The UI layer reads from `EquipmentState` (via the ECS bridge) and calls `equip`/`unequip`/`canEquip` operations. No game logic in the rendering layer.

## Test Plan

### Unit Tests (`tests/ecs/equipment.test.ts`)

1. **Equip single-slot item** — verify slot occupied, stats applied.
2. **Equip multi-slot item** — verify all slots occupied, stats applied.
3. **Unequip single-slot item** — verify slot freed, stats removed.
4. **Unequip multi-slot item** — verify all slots freed via any one slot.
5. **Equip fails on occupied slot** — returns false, state unchanged (atomic).
6. **Equip multi-slot fails partially blocked** — one required slot occupied, all slots unchanged.
7. **Stat aggregation** — equip multiple items, verify sum is correct with clamping.
8. **Stat aggregation after partial unequip** — verify recalculation.
9. **Base stats never modified by equipment** — equip/unequip cycle, base stats unchanged.
10. **Recompute idempotent** — recompute multiple times, no double-counting.
11. **All slots can be equipped independently** — 16 items, 16 slots.
12. **Duplicate item definitions** — two rings with same `itemDef.id`, unequip one, other remains.
13. **Invalid item def (empty slots)** — equip rejected.
14. **Invalid item def (duplicate slots)** — equip rejected.
15. **Entity cleanup** — remove Equipment component, verify side-map entry cleared.
16. **Equip/unequip determinism** — same sequence, same outcome (seeded world).
17. **Level requirements are currently reserved** — `minLevel`/`maxLevel` parse but remain no-op until level-component wiring is added.
18. **Equip fails on minStat requirement** — entity strength too low, equip denied.
19. **Equip fails on notTag requirement** — entity has excluded tag, equip denied.
20. **Equip succeeds with all requirements met** — level, stat, and tag checks pass.
21. **canEquip returns reasons** — multiple failed requirements, all reasons listed.
22. **Custom requirement predicate** — registered predicate denies equip, verify denial.
23. **New slot added to registry** — item targeting new slot can be equipped.
24. **Unknown slot rejected** — item referencing unregistered slot fails validation.
25. **Multi-slot item stats not double-counted** — two-handed weapon in mainHand+offHand grants bonuses exactly once.
26. **NaN/Infinity stat values rejected** — equip denied with invalidDef reason.
27. **Equip denied outside safe room** — equip returns `ok: false` when `world.state !== 'safe_room'` (without `force`).
28. **Entity tag requirements** — `hasTag` checks entity tag set, not item tags.

### Property-Based Tests (`tests/ecs/equipment.property.test.ts`)

Using `fast-check`:

- **Invariant**: equipped item count ≤ slot count (one per slot).
- **Invariant**: `getEffectiveStats` = base stats + Σ equipped bonuses with clamping (no drift).
- **Invariant**: equipping then unequipping returns effective stats to base values.
- **Invariant**: stat values respect their clamp ranges after any sequence of operations.

### Lab (`src/labs/equipment-lab/`)

Visual sandbox showing:

- **Paper doll** with all 16 slot boxes positioned around a character silhouette.
- Click-to-equip / click-to-unequip flow.
- Live stat panel (base vs effective with diffs).
- Multi-slot item demonstrations (two-handed weapon, full plate).
- Requirement gating demo (level-locked item, stat-gated item).

## Constitutional Compliance

| Principle                    | Compliance                                                                 |
| ---------------------------- | -------------------------------------------------------------------------- |
| **Lab-Gated Development**    | Equipment lab required before shipping. CI-enforced.                       |
| **Deterministic Game Logic** | No `Math.random()` or `Date.now()`. Pure functions only.                   |
| **ECS-Phaser Bridge**        | Equipment logic in `src/core/`, types in `src/shared/`. No Phaser imports. |
| **Coverage Requirements**    | `src/core/` and `src/shared/` target 90%+ line coverage.                   |
| **Conventional Commits**     | `feat: add equipment system`, `lab: equipment-lab`, etc.                   |

---

## Floor 2 Generated Equipment Contract

> **Authority:** `docs/knowledge/adr/0065-versioned-frozen-floor2-equipment-instances.md`
> **Implementation:** `src/game/generated-equipment-registry.ts`, `src/shared/generated-equipment-types.ts`

Floor 2 introduces procedurally generated equipment instances whose identity, stats, and
display properties are created at floor-load time and must survive floor transitions and
save/load cycles. This section describes how generated equipment coexists with the Floor 1
system above.

### Identity

Each generated instance carries a stable `GeneratedEquipmentInstanceId` of the form
`gei:v1:<runKey>:<ordinal>`, where:

- `runKey` is derived deterministically from the world seed (never wall-clock time).
- `ordinal` is a non-negative integer, monotonically increasing per run.

This is distinct from the numeric `EquipmentInstanceId` used by the Floor 1 system.

### Instance Schema (v1)

```typescript
interface GeneratedEquipmentInstanceV1 {
  schemaVersion: 'floor2-equipment-instance/v1';
  instanceId: GeneratedEquipmentInstanceId;
  contentRevision: number; // 0 for new, incremented on enhancement
  baseId: string; // catalog reference
  itemLevel: number; // positive integer
  rarity: 'common' | 'uncommon' | 'rare';
  enhancementLevel: 0 | 1 | 2 | 3 | 4 | 5;
  resolvedEffects: ResolvedEquipmentEffectV1[];
  frozen: FrozenEquipmentFieldsV1;
  fingerprint: EquipmentFingerprintV1; // sha256:<64 hex>
}
```

`frozen` contains the consumer-visible computed values (display name, art key, stat
bonuses) written at the end of the resolution pipeline. Consumers **must** use `frozen`
fields; they must not re-resolve behavior from a later catalog revision.

### Registry

The generated equipment registry (`src/game/generated-equipment-registry.ts`) is the
**single source of truth** for full generated instance records. All other containers
(bag, equipped slots, reward bundles, shop stock, carryover) store `instanceId`
references only.

The registry is:

- **World-scoped** — each `GameWorld` has its own isolated registry (WeakMap storage).
- **Feature-flagged** — registration is gated by `world.floor2EquipmentFlags.floor2EquipmentRegistry`; lookups and hydration are always permitted.
- **Immutable after registration** — stored records are deeply frozen; content changes require a full replacement with an incremented `contentRevision`.

### Fingerprinting

Each instance carries a SHA-256 fingerprint of its canonical JSON (keys sorted
lexicographically, no `undefined`, ownership/container fields excluded). The fingerprint
is recomputed during registration and hydration; a mismatch indicates tuning drift and
causes the record to be rejected.

### Coexistence with Floor 1

The generated registry is an additive layer. It does **not** modify `EquipmentState`,
`EquipmentInstance`, or the Floor 1 equip/unequip logic. Future slices will bridge
generated instances into the equip system via an adapter (ADR 0065 DEC-008).

### Rarity and Effect Budget

| Rarity   | Effect budget | Notes                                  |
| -------- | ------------- | -------------------------------------- |
| common   | 0 units       | No affixes                             |
| uncommon | 1 unit        | One minor (1-unit) affix               |
| rare     | 2 units       | Two 1-unit affixes or one 2-unit affix |

Rarities above Rare are not valid Floor 2 generation outcomes.

---

## Unique Equipment

> **Authority:** `docs/knowledge/adr/0066-unique-equipment-schema-and-acquisition.md`
> **Roster:** `.specify/specs/unique-equipment-roster.md`
> **Status:** Normative design contract; runtime implementation is planned
> independently of the Floor 2 equipment epic's 37-node DAG.

Unique equipment is a separate authored-singleton tier. Unlike Common, Uncommon,
and Rare generated instances (which are created by the procedural resolution
pipeline and stored in the generated-equipment registry), Unique items have
hand-crafted identities, bespoke mechanics that cannot be expressed as ordinary
effect-unit budget entries, and deterministic authored acquisition sources.

### Relationship to Generated Instances

- Unique equipment does **not** use `GeneratedEquipmentRarity` and is never
  produced by the Floor 2 generated-instance resolution pipeline.
- Uniques are not stored in the generated-equipment registry
  (`GeneratedEquipmentRegistry`). They have no `instanceId`, no `contentRevision`,
  no `fingerprint`, and no `resolvedEffects` affix list.
- The existing `GeneratedEquipmentRarity = 'common' | 'uncommon' | 'rare'` type
  remains unchanged; adding `'unique'` to that union is explicitly rejected
  (ADR 0066 § Alternatives Considered).

### Unique Equipment Def Schema (v1)

```typescript
type UniqueEquipmentId = `unique:${string}`;
type UniqueArtKey = string; // resolved from the dedicated art production wave

interface UniqueBurnCompensation {
  readonly type: 'gold';
  readonly amount: number; // positive integer
}

interface UniqueCraftingCompensation {
  readonly type: 'crafting-fragment';
  readonly fragmentId: string;
  readonly count: number; // positive integer
}

type UniqueCompensation = UniqueBurnCompensation | UniqueCraftingCompensation;

type UniqueDuplicateRule =
  | { readonly type: 'burn'; readonly compensation: UniqueCompensation }
  | { readonly type: 'disallow' }
  | {
      readonly type: 'convert-upgrade';
      readonly upgradeLevel: number;
      readonly maxUpgradeLevel: number;
      /**
       * Outcome when a duplicate is acquired and the existing copy is already
       * at `maxUpgradeLevel`. Must be declared for every `convert-upgrade` item.
       * 'burn' applies the item's burn compensation; 'disallow' blocks the slot
       * and falls back to a generated Rare (same as the disallow rule).
       */
      readonly atCapRule: 'burn' | 'disallow';
    };

type UniqueAcquisitionSource =
  | { readonly type: 'boss-drop'; readonly bossId: string; readonly floor: number }
  | { readonly type: 'quest-reward'; readonly questId: string }
  | { readonly type: 'achievement-reward'; readonly achievementId: string }
  | {
      readonly type: 'merchant-exclusive';
      readonly merchantId: string;
      readonly condition: string;
    };

type UniqueEligibilityPrereq =
  | { readonly type: 'quest-completed'; readonly questId: string }
  | { readonly type: 'achievement-completed'; readonly achievementId: string }
  | { readonly type: 'npc-dialogue-state'; readonly npcId: string; readonly stateKey: string };

/**
 * One ability or passive grant provided by a Unique while it is equipped.
 * `ordinal` is a stable 0-based index assigned at authoring time and never
 * reassigned; it forms the stable component of the source ID
 * `unique:<uniqueId>:<abilityOrdinal>` used by the DEC-006 grant model.
 */
interface UniqueGrant {
  readonly ordinal: number; // stable; never reassigned after first authoring
  readonly type: 'active-ability' | 'passive';
  readonly grantId: string; // human-readable key unique within this def, e.g. 'shield-pulse'
}

interface UniqueEquipmentDef {
  readonly schemaVersion: 'unique-equipment-def/v1';
  readonly uniqueId: UniqueEquipmentId;
  readonly displayName: string;
  readonly slot: EquipmentSlotId | readonly EquipmentSlotId[];
  readonly lore: string; // one to three sentences; shown on first acquire
  readonly spriteKey: UniqueArtKey; // dedicated authored sprite
  readonly iconKey: UniqueArtKey; // dedicated authored icon
  readonly vfxKey: UniqueArtKey | null; // optional bespoke VFX
  readonly acquisitionSource: UniqueAcquisitionSource;
  readonly duplicateRule: UniqueDuplicateRule;
  readonly upgradeLevel: number; // catalog baseline; 0 for non-convert-upgrade items
  readonly maxUpgradeLevel: number; // 0 for non-convert-upgrade items
  readonly eligibilityPrereqs: readonly UniqueEligibilityPrereq[];
  readonly questId: string | null;
  readonly achievementId: string | null;
  /**
   * Ordered list of ability/passive grants this Unique provides while equipped.
   * Each entry's `ordinal` is stable and forms the `<abilityOrdinal>` segment of
   * the grant source ID `unique:<uniqueId>:<abilityOrdinal>`.
   * Empty for Uniques that have no ability/passive grants.
   */
  readonly grants: readonly UniqueGrant[];
}
```

### Singleton Ownership Model

A player either owns a specific Unique or they do not. Ownership state is stored
in the player's persistent equipment state as:

```typescript
interface PlayerUniqueEquipmentState {
  /** Sorted, deduplicated list of all acquired Uniques. */
  ownedUniques: UniqueEquipmentId[];
  /** Equipped Unique per slot (null means no Unique in that slot). */
  equippedUniques: Partial<Record<EquipmentSlotId, UniqueEquipmentId>>;
  /**
   * Per-player mutable upgrade level for `convert-upgrade` Uniques.
   * Key is present only for items with `maxUpgradeLevel > 0`.
   * The `UniqueEquipmentDef.upgradeLevel` field is immutable catalog data;
   * this map is the authoritative per-save upgrade state.
   */
  upgradeLevels: Partial<Record<UniqueEquipmentId, number>>;
}
```

- There is no per-copy instance numbering, no copy counter, and no registry record.
- For `convert-upgrade` items, the per-player upgrade level is stored in
  `upgradeLevels[id]` within `PlayerUniqueEquipmentState`. The catalog-level
  `UniqueEquipmentDef.upgradeLevel` is read-only authoring data and must not
  be mutated at runtime.
- Multiple equipped slots may reference one multi-slot Unique; those references
  count as one owner.
- A Unique cannot be equipped in a slot already occupied by a generated instance,
  and vice versa. Equip validation must check both ownership surfaces.

### Acquisition and Duplicate Policy

Acquisition is validated at offer time **and** revalidated atomically at delivery/claim/purchase:

- `boss-drop`: The loot resolver checks `ownedUniques` at floor-load to drive
  stock generation. At the moment the player actually receives the drop (claim),
  ownership is revalidated atomically; if the player acquired the same Unique
  from another source between floor-load and claim, the duplicate rule is applied
  at claim time. If the rule is `disallow`, the slot resolves to a fallback
  generated Rare instance instead.
- `quest-reward` and `achievement-reward`: The grant function checks `ownedUniques`
  before granting. If the rule is `burn` and the item is already owned, the
  compensation is applied instead. If the rule is `disallow` the grant is silently
  skipped (the quest/achievement still completes; only the item reward is replaced).
  In both cases, ownership revalidation occurs atomically at the claim/grant call
  site, not only at offer presentation.
- `merchant-exclusive`: Stock generation checks `ownedUniques` at stock-resolve
  time. The purchase transaction also revalidates ownership atomically at purchase
  commit; any ownership change between stock generation and purchase applies the
  `disallow` or `burn` rule at purchase time.

For `convert-upgrade` rules: if the player owns the item at `upgradeLevels[id] < maxUpgradeLevel`,
the existing copy is upgraded by one level in `upgradeLevels` and no new copy is created.
If the player owns the item at `upgradeLevels[id] === maxUpgradeLevel` (at the upgrade cap),
the `atCapRule` declared in the `UniqueDuplicateRule` governs the outcome: `burn` applies the
item's declared compensation, and `disallow` blocks the acquisition slot (same fallback-Rare
behavior as the `disallow` rule). This at-cap outcome applies at every acquisition source.

### Ability and Passive Grants

Unique-granted abilities use source IDs of the form:

```
unique:<uniqueId>:<abilityOrdinal>
```

This extends the DEC-006 source-owned grant model (ADR 0065). The grant is active
while the Unique is equipped; unequip removes only sources matching the Unique's
`uniqueId`. Because a Unique cannot be equipped twice simultaneously, duplicate
grant stacking from the same Unique is not possible by design.

The existing active-ability slot limit remains the authority.

### Save, Migration, and Carryover

- **Save format**: `PlayerUniqueEquipmentState` is serialized alongside the
  generated-instance registry. It is initialized to `{ ownedUniques: [],
  equippedUniques: {}, upgradeLevels: {} }` for saves predating Unique support.
- **Forward compatibility**: Unknown `UniqueEquipmentId` values in `ownedUniques`
  are retained verbatim on load. No migration discards or rerolls known Uniques.
- **Migration**: A save that contains a `uniqueId` that no longer exists in the
  `UniqueEquipmentDef` catalog is preserved in `ownedUniques` but cannot be
  displayed or equipped (treated as an unknown Unique with a placeholder name in
  UI). Unknown equipped Uniques are cleared from `equippedUniques` on load.
- **Carryover**: `ownedUniques`, `equippedUniques`, and `upgradeLevels` carry across
  floor transitions in the same carryover payload as the generated-instance registry.
  Uniques do not reset between floors.

### Compatibility with Inventory, Rewards, Shops, and Chests

- **Inventory/bag**: The bag stores `UniqueEquipmentId` references in a parallel
  `uniqueSlot` list, separate from generated `instanceId` references. A Unique
  occupies one bag slot **only when it is unequipped**; equipping a Unique moves
  it from the bag into an equipment slot and frees the bag slot. Each owned Unique
  ID has exactly one current location — either the bag (`uniqueSlot`) or an
  equipment slot (`equippedUniques`) — never both. Equipped items do not consume
  bag capacity.
- **Reward bundles**: An achievement or quest reward bundle may contain a
  `UniqueEquipmentId` alongside generated instance IDs. Claim is atomic (all or
  nothing) per ADR 0065 DEC-007.
- **Shops**: A `merchant-exclusive` Unique appears in a shop's stock as a special
  entry type distinct from generated stock entries. Standard shop purchase
  transaction flow applies, with ownership pre-checked before stock generation.
- **Chests and boss drops**: Boss-drop Uniques appear in a named loot slot that is
  separate from generated-instance loot rolls. A fallback generated Rare fills the
  slot when the `disallow` rule prevents the Unique from appearing.

### Director Presentation and Lore

The `lore` field is displayed as a Director commentary card when a Unique is first
acquired (whether from a quest, achievement, or boss drop). The card format matches
existing Director presentation for notable events.

Uniques linked to a `questId` or `achievementId` may also receive a short Director
hint when the player first enters the floor on which the acquisition source is
reachable (if the player does not yet own the item).

### Art Requirements

Every Unique requires dedicated authored art outside the Floor 2 generated-art
pipeline. Generated art (`sprites:run` wave output) must not be reused for Unique
slots. Required per item:

- **Sprite** (`spriteKey`): a 32×32 px authored sprite distinct from any generated
  equipment family.
- **Icon** (`iconKey`): a 20×20 px icon for inventory and tooltip display.
- **VFX** (`vfxKey`, optional): a non-looping particle or overlay effect for the
  bespoke mechanic (if the mechanic has an observable trigger moment).

Art direction for each Unique is documented in the per-item brief in
`.specify/specs/unique-equipment-roster.md`. Unique art is human-authored outside
the procedural generation pipeline; the authored files are ingested via
`sprites:checkin` after creation and approval. The generation pipeline
(`sprites:run`, `sprites:enqueue`) must **not** be used for Unique art slots —
only for procedurally generated equipment family sprites. Unique sprites must be
approved before the item can be wired into runtime.
