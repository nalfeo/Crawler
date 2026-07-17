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

| Principle                         | Compliance                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| **Lab-Gated Development**         | Equipment lab required before shipping. CI-enforced.                               |
| **Deterministic Game Logic**      | No `Math.random()` or `Date.now()`. Pure functions only.                           |
| **ECS-Phaser Bridge**             | Equipment logic in `src/core/`, types in `src/shared/`. No Phaser imports.         |
| **Coverage Requirements**         | `src/core/` and `src/shared/` target 90%+ line coverage.                           |
| **Conventional Commits**          | `feat: add equipment system`, `lab: equipment-lab`, etc.                           |
| **Rapid Five-Level Build Growth** | Floor 2 item stats must be tuned so representative builds meet the 1.7×–2.3× gate. |

---

## Floor 2 Generated Equipment Contract (A1 Implementation Lock)

> This section locks the implementation contracts for Floor 2 generated equipment.
> It is normative for all downstream implementation slices (B1–C2).
> Authority: ADR 0065 (`docs/knowledge/adr/0065-versioned-frozen-floor2-equipment-instances.md`).

### Instance Identity and Registry

- **One versioned generated-equipment registry** spans all Floor 2 equipment consumers.
  Every generated instance is assigned a stable UUID at creation and stored exactly once in
  the registry.
- **Containers** (bag slots, equipped slots, reward bundles, boss chests, Quartermaster stock,
  floor-carryover manifests) store only the instance ID — never the full record.
- No consumer may define a parallel item shape or store a subset of resolved fields.
- The registry schema is versioned. Unknown future versions fail closed; supported migration
  is deterministic and idempotent.

### Resolution Order (immutable after freeze)

Generated instances are resolved exactly once in this sequence:

1. Base template selection (static `EquipmentItemDef`)
2. Item level (floor zone band)
3. Inherent scaling (rarity scalar applied to base stats)
4. Rarity: Common (1.00×, 0 effect units), Uncommon (1.05×, 1 minor unit), Rare (1.10×, 2 units)
5. Enhancement: +0..+5, adds 5% post-rarity inherent damage or armor per step
6. Affixes and effect-unit budget allocated from rarity
7. **Freeze:** stats, name, art handle, weapon snapshot (if applicable), and fingerprint

The only permitted post-freeze content operation is an atomic enhancement revision
(step 5 incremented by one); it never rerolls prior choices.

### Fingerprinting

- Fingerprints are versioned SHA-256 digests of canonical immutable instance fields.
- Excluded from fingerprint: ownership container, merchant price, claim state.
- Fingerprint mismatch signals a bug (stale clone or field omission) — not an expected
  upgrade path.

### Weapon Snapshots

Weapon-bearing instances freeze an `ActiveWeaponSnapshotV1` record after full instance
resolution (see `weapon-system.md` for the snapshot contract). Runtime weapon-firing selects
the snapshot by equipped instance ID rather than reading or mutating the global
static `WeaponDef` template.

### Ability and Passive Ownership

- Every ability or passive granted by equipment records a source key:
  `equipment:<instanceId>:<effectOrdinal>`.
- A grant remains active while at least one source with that key exists.
- Unequipping removes only the originating source keys.
- The existing ten-slot active-ability limit remains authoritative.

### Achievement Reward Contracts

- Reward instances resolve atomically at unlock time and are immutable inside the reward bundle.
- A `claim` operation transfers the whole bundle and marks it claimed in one transaction,
  or performs no mutation (no partial state).
- Claimed state is excluded from the instance fingerprint.

### Shop and Economy Contracts

- Player purchases and AI purchases share one atomic public purchase API.
- A purchase either succeeds (item moves from merchant stock to buyer bag, price debited) or
  fails completely — no partial transfer.
- Quartermaster rules: Floor 2 merchant stock rotates within the unlocked catalog;
  Tier 1 items appear at the 25/50 zone shops; Tier 2 items at the 50/75 zone shops.
- Boss chest rarity distribution: 85% Uncommon-or-higher, 15% Common fallback.
- The normalized catalog floor is 70 base entries before enhancement or affixes.

### Floor Carryover

- Floor 1 equipment entries are excluded from the Floor 2 registry and must not appear in
  Floor 2 shop or loot pools.
- Floor 2 carryover serializes the registry plus ID references — not resolved records.
- Carryover deserialization is idempotent; repeated loads produce identical registry state.

### Deterministic AI Scoring

- AI agents score generated instances by expected run value: a function of resolved stats,
  current build, and floor-zone context.
- AI may pursue an optional settlement-maintenance goal only through the existing objective
  route planner and public inventory / equip / purchase APIs.
- AI scoring is deterministic: same inputs produce same score. No `Math.random()`.

### Feature Flags

Seven independently staged Floor 2 equipment feature flags govern rollout.
All default to `false` (off). Each flag must not expose equipment on Floor 1.

| Flag ID                        | Enables                                        |
| ------------------------------ | ---------------------------------------------- |
| `floor2EquipmentRegistry`      | Versioned instance registry and resolution     |
| `floor2EquipmentCatalog`       | Tier 1 and Tier 2 item catalog entries         |
| `floor2EquipmentRewards`       | Achievement reward bundles and boss chest loot |
| `floor2EquipmentEconomy`       | Quartermaster stock and purchase API           |
| `floor2EquipmentUX`            | HUD slots, paper doll, and tooltip rendering   |
| `floor2EquipmentWorldInteg`    | World-simulation equipment queries and effects |
| `floor2EquipmentAIMaintenance` | AI scoring and settlement-maintenance goal     |

Dependency closure: each flag may be enabled only after all flags it depends on are enabled.
Disabling a flag with persisted items preserves existing instances (no forced unequip or data loss).

### Migration

- Instance migration is deterministic and idempotent: applying the migration to an already-migrated
  record produces the same result as applying it once.
- Records with an unknown `schema_version` fail closed — they are not silently discarded or
  coerced. The runtime logs a structured error and keeps the record as-is until a supported
  migration is available.
- Migration never rerolls frozen content (no new RNG draws on existing fields).
