# Spec: Character Equipment System

## Context

Crawler's characters need a full equipment system befitting a dungeon crawler. Currently, the weapon system (`src/game/weaponSystem.ts`) uses a flat `WeaponConfig` per world — there's no concept of equippable items, gear slots, or stat modifiers from equipment. This spec introduces a slot-based equipment model that enables deep itemisation, build diversity, and future mechanics like slot disabling (e.g. losing a finger).

## Requirements

### Equipment Slots

Slots are defined in a **data-driven slot registry** — a plain array/map of slot definitions. New slots (trinkets, ammo, earrings, etc.) can be added at any time by appending to the registry without modifying existing code or breaking save compatibility.

#### V1 Slot Registry

| Slot ID            | Label           | Body Group     | Notes                          |
| ------------------ | --------------- | -------------- | ------------------------------ |
| `head`             | Head            | head           | Helmets, crowns, masks         |
| `face`             | Face            | head           | Goggles, face paint, masks     |
| `neck`             | Neck            | torso          | Amulets, necklaces, collars    |
| `shoulders`        | Shoulders       | torso          | Pauldrons, epaulets            |
| `chest`            | Chest           | torso          | Armour, robes, harnesses       |
| `back`             | Back            | torso          | Cloaks, wings, backpacks       |
| `arms`             | Arms            | arms           | Bracers, vambraces             |
| `wrists`           | Wrists          | arms           | Wrist guards, bracelets        |
| `gloves`           | Gloves          | hands          | Gauntlets, gloves              |
| `mainHand`         | Main Hand       | hands          | Primary weapon                 |
| `offHand`          | Off Hand        | hands          | Shield, secondary weapon, tome |
| `ringLeft`         | Left Ring       | hands          | Ring                           |
| `ringRight`        | Right Ring      | hands          | Ring                           |
| `belt`             | Belt            | torso          | Belts, sashes                  |
| `legs`             | Legs            | legs           | Greaves, leggings, pants       |
| `feet`             | Feet            | legs           | Boots, sandals, greaves        |

```typescript
interface SlotDefinition {
  id: string;           // unique slot key
  label: string;        // display name
  bodyGroup: string;    // grouping for UI layout and future mechanics
  /** Paper doll position hint (normalised 0–1 coords relative to doll bounds) */
  uiPosition: { x: number; y: number };
}

/** The slot registry — append-only. */
const SLOT_REGISTRY: SlotDefinition[] = [ /* ...v1 slots above... */ ];

/** Derived type from registry keys. Extensible by appending to SLOT_REGISTRY. */
type EquipmentSlotId = string;  // validated against SLOT_REGISTRY at runtime
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

### Slot Disabling

Slots can be individually **disabled** at runtime (future mechanic: injuries, curses, mutations).

- A disabled slot cannot hold an item. If an item is in that slot when it becomes disabled, the item is forcibly unequipped.
- Multi-slot items are fully unequipped if **any** of their slots are disabled.
- Disabling/re-enabling is tracked per-entity, per-slot.

### Stats

Equipment may grant bonuses to **primary stats** and/or **secondary stats**.

#### Primary Stats

| Stat ID        | Label         | Effect Summary                              |
| -------------- | ------------- | ------------------------------------------- |
| `strength`     | Strength      | Melee damage, carry capacity                |
| `dexterity`    | Dexterity     | Attack speed, dodge chance, crit chance     |
| `constitution` | Constitution  | Max HP, HP regen, status resist             |
| `intelligence` | Intelligence  | Spell/ability power, crafting bonus         |
| `wisdom`       | Wisdom        | XP gain, cooldown reduction, awareness      |
| `charisma`     | Charisma      | Broadcast Score bonus, shop prices, sponsor |
| `luck`         | Luck          | Drop rates, crit chance, random event bias  |

#### Secondary Stats (derived / granted by items)

| Stat ID          | Label              | Notes                                    |
| ---------------- | ------------------ | ---------------------------------------- |
| `armor`          | Armor              | Flat damage reduction                    |
| `damageBonus`    | Damage Bonus       | Additive bonus to outgoing damage        |
| `attackSpeed`    | Attack Speed       | Modifier to fire rate / swing cooldown   |
| `moveSpeed`      | Move Speed         | Movement speed modifier                  |
| `critChance`     | Crit Chance        | Percentage chance for critical hit       |
| `critMultiplier` | Crit Multiplier    | Damage multiplier on critical hit        |
| `dodgeChance`    | Dodge Chance       | Percentage chance to evade an attack     |
| `hpRegen`        | HP Regen           | Health regenerated per second            |
| `xpBonus`        | XP Bonus           | Multiplier to XP gained                  |
| `cooldownReduction` | Cooldown Reduction | Percentage reduction on ability cooldowns |

Items declare stat bonuses as a flat map: `{ strength: 5, armor: 3, critChance: 0.02 }`.

### Base Stats vs Effective Stats

Stat computation uses two distinct layers to prevent double-counting:

- **`BaseStats`** store: Intrinsic character stats (set at creation, modified by level-ups/buffs — never by equipment).
- **`EffectiveStats`** store: Computed result = `BaseStats + Σ equipment bonuses`. This is what downstream systems read.

Recomputation always starts from `BaseStats` and sums all equipped item bonuses. Equipment bonuses are never written back into `BaseStats`.

### Stat Semantics & Stacking

All equipment stat bonuses are **additive flat values** in v1. No multiplicative stacking.

| Stat               | Unit / Type     | Clamp Range     | Notes                           |
| ------------------ | --------------- | --------------- | ------------------------------- |
| `strength` etc.    | Flat integer    | [0, ∞)          | Primary stats; floor at 0       |
| `armor`            | Flat integer    | [0, ∞)          | Damage reduction points         |
| `damageBonus`      | Flat number     | (-∞, ∞)         | Can be negative (cursed items)  |
| `attackSpeed`      | Flat number     | Added to base   | Higher = faster; floor at 0.1   |
| `moveSpeed`        | Flat number     | Added to base   | Higher = faster; floor at 0     |
| `critChance`       | Decimal [0–1]   | [0, 1]          | Clamped percentage              |
| `critMultiplier`   | Decimal         | [1, ∞)          | Additive to base 1.0; floor 1.0 |
| `dodgeChance`      | Decimal [0–1]   | [0, 0.75]       | Hard cap at 75%                 |
| `hpRegen`          | HP/sec          | [0, ∞)          | Floor at 0                      |
| `xpBonus`          | Decimal         | [0, ∞)          | Additive percentage; 0.1 = +10% |
| `cooldownReduction`| Decimal [0–1]   | [0, 0.80]       | Hard cap at 80%                 |

Primary stat → secondary stat derivation formulas are **deferred to a future spec**. In v1, primary stats are tracked but do not auto-derive secondary stats.

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
  | { type: 'minLevel'; value: number }           // entity must be ≥ level
  | { type: 'maxLevel'; value: number }           // entity must be ≤ level
  | { type: 'minStat'; stat: StatId; value: number } // base stat must be ≥ value
  | { type: 'hasTag'; tag: string }                // entity must have tag (e.g. 'male', 'undead', 'class:mage')
  | { type: 'notTag'; tag: string }                // entity must NOT have tag
  | { type: 'custom'; id: string }                 // lookup in custom requirement registry
```

#### Examples

```typescript
// Only equippable at level 5+
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
  /** Registry of instance ID → item definition (source of truth for stats/slots) */
  instances: Map<EquipmentInstanceId, EquipmentItemDef>;
  /** Set of currently disabled slot IDs */
  disabledSlots: Set<EquipmentSlotId>;
}
```

### Core Operations

| Operation                           | Preconditions                                              | Effects                                         |
| ----------------------------------- | ---------------------------------------------------------- | ----------------------------------------------- |
| `equip(world, entity, itemDef)`     | All required slots free AND enabled, all requirements pass | Sets item in all slots, recalculates stats       |
| `unequip(world, entity, slotId)`    | Slot has an item                                           | Frees all slots the item occupies, recalcs stats |
| `disableSlot(world, entity, slot)`  | —                                                          | Forcibly unequips item if present, marks disabled |
| `enableSlot(world, entity, slot)`   | —                                                          | Marks slot enabled                               |
| `getEffectiveStats(world, entity)`  | —                                                          | Returns sum of base stats + all equipment bonuses |
| `canEquip(world, entity, itemDef)`  | —                                                          | Returns `{ allowed: boolean; reasons: string[] }` — checks slots AND requirements |

All operations take `world: GameWorld` as the first argument (required to access the WeakMap side-map and typed-array stores).

### Constraints

- An entity can only equip one item per slot.
- `equip` is **atomic**: it either fully succeeds (all slots filled, stats updated) or fails with no state change. It returns `false` if any required slot is occupied or disabled, **or if any equip requirement fails**.
- A **swap** helper may be added later but is not required in v1 — caller unequips first.
- Stats are **recomputed** on every equip/unequip/disable/enable, not cached lazily, to keep determinism simple.
- `disableSlot` / `enableSlot` are **idempotent** — disabling an already-disabled slot or enabling an already-enabled slot is a no-op.
- **Forced unequip** (from slot disabling) removes the item from equipment state and stat computation. The item is returned via a result value — inventory/drop behaviour is out of scope for v1.

### Validation Rules

- `itemDef.slots` must be non-empty.
- `itemDef.slots` must not contain duplicate slot IDs.
- Unknown slot IDs or stat IDs are rejected at equip time.

## Scope & Future Work

**In scope (v1):**
- Data-driven slot registry (16 v1 slots, easily extensible)
- Multi-slot items with atomic equip/unequip
- Equip requirements (level, stat, tag, custom predicate)
- `canEquip` query for UI/tooltip gating
- Slot disabling/enabling
- Flat additive stat bonuses with clamping
- Base/effective stat separation
- Side-map state with entity cleanup

**Explicitly deferred:**
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

| Artifact                       | Location                                |
| ------------------------------ | --------------------------------------- |
| Slot registry + `SlotDefinition` | `src/shared/equipment-slots.ts`       |
| `EquipmentSlotId` type         | `src/shared/equipment-slots.ts`         |
| `EquipmentItemDef`, `EquipRequirement` | `src/shared/equipment-types.ts` |
| `StatId` type + stat tables    | `src/shared/stats.ts`                   |
| `Equipment` component tag      | `src/core/components.ts`                |
| Equipment store (typed arrays) | `src/core/components.ts` (stores)       |
| Equipment logic (pure fns)     | `src/core/systems/equipmentSystem.ts`   |
| Equip requirement evaluator    | `src/core/systems/equipmentSystem.ts`   |
| Custom requirement registry    | `src/core/systems/equipmentSystem.ts`   |
| Stat aggregation system        | `src/core/systems/statSystem.ts`        |
| Equipment lab                  | `src/labs/equipment-lab/`               |

### ECS Integration

- A new **`Equipment`** tag component marks an entity as having equipment.
- Equipment state is stored in a **side map** (`WeakMap<GameWorld, Map<number, EquipmentState>>`) following the same pattern as `weaponSystem.ts`, keeping ECS components slim.
- A new **`BaseStats`** tag component + typed-array store holds intrinsic stat values per entity (never modified by equipment).
- A new **`EffectiveStats`** tag component + typed-array store holds computed stat values (base + equipment).
- The **`statSystem`** runs after `equipmentSystem` each frame (or on-demand after equip/unequip) to aggregate base stats + equipment bonuses into the `EffectiveStats` store.
- **Entity cleanup**: When an entity is destroyed or its `Equipment` component is removed, the side-map entry is deleted to prevent stale state on entity ID reuse.

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

| State       | Visual                                                |
| ----------- | ----------------------------------------------------- |
| Empty       | Dimmed outline + slot label text                      |
| Equipped    | Item icon + rarity-coloured border                    |
| Disabled    | Crossed out / red tint, non-interactive               |
| Hover       | Tooltip with item name, stats, requirements           |
| Invalid     | Red flash when attempting to equip a blocked/failed item |

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

| Artifact                     | Location                              |
| ---------------------------- | ------------------------------------- |
| Paper doll scene (Phaser)    | `src/engine/scenes/EquipmentScene.ts` |
| Slot layout config (data)    | `src/shared/equipment-slots.ts` (position hints per slot) |
| Equipment UI state bridge    | `src/engine/ui/EquipmentUI.ts`        |

The UI layer reads from `EquipmentState` (via the ECS bridge) and calls `equip`/`unequip`/`canEquip` operations. No game logic in the rendering layer.

## Test Plan

### Unit Tests (`tests/ecs/equipment.test.ts`)

1. **Equip single-slot item** — verify slot occupied, stats applied.
2. **Equip multi-slot item** — verify all slots occupied, stats applied.
3. **Unequip single-slot item** — verify slot freed, stats removed.
4. **Unequip multi-slot item** — verify all slots freed via any one slot.
5. **Equip fails on occupied slot** — returns false, state unchanged (atomic).
6. **Equip multi-slot fails partially blocked** — one required slot occupied, all slots unchanged.
7. **Equip fails on disabled slot** — returns false, state unchanged.
8. **Disable slot with equipped item** — item unequipped, stats removed.
9. **Disable slot on multi-slot item** — entire item unequipped.
10. **Enable slot** — slot becomes available, no side effects.
11. **Idempotent disable/enable** — double-disable or double-enable is a no-op, no stat drift.
12. **Stat aggregation** — equip multiple items, verify sum is correct with clamping.
13. **Stat aggregation after partial unequip** — verify recalculation.
14. **Base stats never modified by equipment** — equip/unequip cycle, base stats unchanged.
15. **Recompute idempotent** — recompute multiple times, no double-counting.
16. **All slots can be equipped independently** — 16 items, 16 slots.
17. **Duplicate item definitions** — two rings with same `itemDef.id`, unequip one, other remains.
18. **Invalid item def (empty slots)** — equip rejected.
19. **Invalid item def (duplicate slots)** — equip rejected.
20. **Entity cleanup** — remove Equipment component, verify side-map entry cleared.
21. **Equip/unequip determinism** — same sequence, same outcome (seeded world).
22. **Equip fails on minLevel requirement** — entity below required level, equip denied.
23. **Equip fails on minStat requirement** — entity strength too low, equip denied.
24. **Equip fails on notTag requirement** — entity has excluded tag, equip denied.
25. **Equip succeeds with all requirements met** — level, stat, and tag checks pass.
26. **canEquip returns reasons** — multiple failed requirements, all reasons listed.
27. **Custom requirement predicate** — registered predicate denies equip, verify denial.
28. **New slot added to registry** — item targeting new slot can be equipped.
29. **Unknown slot rejected** — item referencing unregistered slot fails validation.

### Property-Based Tests (`tests/ecs/equipment.property.test.ts`)

Using `fast-check`:
- **Invariant**: equipped item count ≤ 16 (one per slot).
- **Invariant**: `getEffectiveStats` = base stats + Σ equipped bonuses with clamping (no drift).
- **Invariant**: disabling a slot never leaves a dangling item reference.
- **Invariant**: equipping then unequipping returns effective stats to base values.
- **Invariant**: stat values respect their clamp ranges after any sequence of operations.

### Lab (`src/labs/equipment-lab/`)

Visual sandbox showing:
- **Paper doll** with all 16 slot boxes positioned around a character silhouette.
- Click-to-equip / click-to-unequip flow.
- Slot disable/enable toggle buttons.
- Live stat panel (base vs effective with diffs).
- Multi-slot item demonstrations (two-handed weapon, full plate).
- Requirement gating demo (level-locked item, stat-gated item).

## Constitutional Compliance

| Principle                  | Compliance                                                    |
| -------------------------- | ------------------------------------------------------------- |
| **Lab-Gated Development**  | Equipment lab required before shipping. CI-enforced.          |
| **Deterministic Game Logic**| No `Math.random()` or `Date.now()`. Pure functions only.     |
| **ECS-Phaser Bridge**      | Equipment logic in `src/core/`, types in `src/shared/`. No Phaser imports. |
| **Coverage Requirements**  | `src/core/` and `src/shared/` target 90%+ line coverage.     |
| **Conventional Commits**   | `feat: add equipment system`, `lab: equipment-lab`, etc.      |
