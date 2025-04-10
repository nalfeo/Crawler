import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { addComponent, addEntity, setComponent } from 'bitecs';
import { createTestWorld } from '../helpers/world-factory.js';
import type { GameWorld } from '../../src/core/world.js';
import { Health } from '../../src/core/components.js';
import {
  initializeBaseStats,
  equip,
  equipFromBag,
  unequip,
  canEquip,
  getEffectiveStats,
  getEquipmentState,
  clearEquipmentState,
  setEntityTags,
  registerCustomRequirement,
} from '../../src/core/systems/equipmentSystem.js';
import { statSystem } from '../../src/core/systems/statSystem.js';
import { SLOT_REGISTRY } from '../../src/shared/equipment-slots.js';
import { CORE_STAT_TO_SECONDARY, DEFAULT_BASE_STATS } from '../../src/shared/stats.js';
import {
  getEquipmentDefForItem,
  getEquippableItemIds,
  GEAR_ITEM_IDS,
  _registerEquipmentDefForTest,
  _clearEquipmentDefsForTest,
} from '../../src/shared/equipmentDefs.js';
import { addItem, hasItem, getItemCount, type InventoryBag } from '../../src/shared/inventory.js';
import { ItemRarity, customTag, type ItemDef } from '../../src/shared/items.js';
import type { EquipmentItemDef } from '../../src/shared/equipment-types.js';

// --- Test helpers ---

// Minimal inventory-catalog defs for the synthetic gear ids registered via the
// equipment test overlay. `addItem` validates ids against the item catalog, so
// bag-seeding for overlay-only ids must pass this explicit catalog.
function makeCatalogItem(id: string): ItemDef {
  return {
    id,
    name: id,
    description: 'test item',
    tags: [customTag('test')],
    rarity: ItemRarity.Common,
    maxStack: 1,
  };
}
const TEST_CATALOG: ItemDef[] = [makeCatalogItem('colossus-blade'), makeCatalogItem('warblade')];

function makeItem(overrides: Partial<EquipmentItemDef> = {}): EquipmentItemDef {
  return {
    id: 'test-item',
    name: 'Test Item',
    slots: ['head'],
    statBonuses: {},
    weightLb: 0,
    rarity: 'common',
    ...overrides,
  };
}

function setupEntity(world: GameWorld): number {
  const eid = addEntity(world.ecs);
  initializeBaseStats(world, eid);
  return eid;
}

describe('Equipment System', () => {
  let world: GameWorld;
  let entity: number;

  beforeEach(() => {
    world = createTestWorld();
    world.state = 'safe_room';
    entity = setupEntity(world);
  });

  // 1. Equip single-slot item
  it('equips a single-slot item', () => {
    const item = makeItem({ statBonuses: { armor: 5 } });
    const result = equip(world, entity, item, { force: true });
    expect(result.ok).toBe(true);
    const state = getEquipmentState(world, entity)!;
    expect(state.equipped['head']).not.toBeNull();
    expect(getEffectiveStats(world, entity).armor).toBe(5);
  });

  it('applies maxHp delta to Health immediately on constitution equip/unequip', () => {
    const hpEntity = addEntity(world.ecs);
    addComponent(world.ecs, hpEntity, Health);
    setComponent(world.ecs, hpEntity, Health, { max: 1, current: 1 });
    initializeBaseStats(world, hpEntity);

    const beforeMax = world.stores.health.max[hpEntity] ?? 0;
    const beforeCurrent = world.stores.health.current[hpEntity] ?? 0;
    const result = equip(
      world,
      hpEntity,
      makeItem({ id: 'con-ring', slots: ['ringLeft'], statBonuses: { constitution: 1 } }),
      { force: true },
    );
    expect(result.ok).toBe(true);
    expect(world.stores.health.max[hpEntity]).toBe(beforeMax + 10);
    expect(world.stores.health.current[hpEntity]).toBe(beforeCurrent + 10);

    const unequipResult = unequip(world, hpEntity, 'ringLeft', { force: true });
    expect(unequipResult.ok).toBe(true);
    expect(world.stores.health.max[hpEntity]).toBe(beforeMax);
    expect(world.stores.health.current[hpEntity]).toBe(beforeCurrent);
  });

  // 2. Equip multi-slot item
  it('equips a multi-slot item occupying all specified slots', () => {
    const item = makeItem({
      id: 'greatsword',
      slots: ['mainHand', 'offHand'],
      statBonuses: { damageBonus: 10 },
    });
    const result = equip(world, entity, item, { force: true });
    expect(result.ok).toBe(true);
    const state = getEquipmentState(world, entity)!;
    expect(state.equipped['mainHand']).toBe(state.equipped['offHand']);
  });

  // 3. Unequip single-slot item
  it('unequips a single-slot item and removes stats', () => {
    const item = makeItem({ statBonuses: { armor: 5 } });
    equip(world, entity, item, { force: true });
    const result = unequip(world, entity, 'head', { force: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.item.def.id).toBe('test-item');
    expect(getEffectiveStats(world, entity).armor).toBe(0);
  });

  // 4. Unequip multi-slot item frees all slots
  it('unequips multi-slot item from any occupied slot', () => {
    const item = makeItem({ id: 'gs', slots: ['mainHand', 'offHand'] });
    equip(world, entity, item, { force: true });
    unequip(world, entity, 'offHand', { force: true });
    const state = getEquipmentState(world, entity)!;
    expect(state.equipped['mainHand']).toBeNull();
    expect(state.equipped['offHand']).toBeNull();
  });

  // 5. Equip fails on occupied slot (atomic)
  it('fails to equip when slot is occupied', () => {
    equip(world, entity, makeItem(), { force: true });
    const result = equip(world, entity, makeItem({ id: 'helm2' }), { force: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons.some((r) => r.type === 'occupiedSlot')).toBe(true);
    }
  });

  // 6. Equip multi-slot fails partially blocked
  it('fails atomically when one multi-slot is blocked', () => {
    equip(world, entity, makeItem({ id: 'shield', slots: ['offHand'] }), { force: true });
    const result = equip(world, entity, makeItem({ id: 'gs', slots: ['mainHand', 'offHand'] }), {
      force: true,
    });
    expect(result.ok).toBe(false);
    const state = getEquipmentState(world, entity)!;
    expect(state.equipped['mainHand']).toBeNull();
  });

  // 7. Stat aggregation across multiple items
  it('aggregates stats from multiple equipped items', () => {
    equip(world, entity, makeItem({ id: 'helm', slots: ['head'], statBonuses: { armor: 5 } }), {
      force: true,
    });
    equip(
      world,
      entity,
      makeItem({ id: 'boots', slots: ['feet'], statBonuses: { armor: 3, moveSpeed: 1 } }),
      { force: true },
    );
    const stats = getEffectiveStats(world, entity);
    expect(stats.armor).toBe(8);
    // moveSpeed = gear flat bonus (1) + base Dexterity's own always-on
    // derivation (effective DEX 1 * CORE_STAT_TO_SECONDARY.dexterity.moveSpeed)
    // — Dexterity's per-point moveSpeed rate applies to the FULL effective
    // value (base + allocated + gear), not just allocated points.
    expect(stats.moveSpeed).toBeCloseTo(
      1 + DEFAULT_BASE_STATS.dexterity * CORE_STAT_TO_SECONDARY.dexterity.moveSpeed!,
      6,
    );
  });

  // 8. Stat aggregation after partial unequip
  it('recalculates stats after unequip', () => {
    equip(world, entity, makeItem({ id: 'helm', slots: ['head'], statBonuses: { armor: 5 } }), {
      force: true,
    });
    equip(world, entity, makeItem({ id: 'boots', slots: ['feet'], statBonuses: { armor: 3 } }), {
      force: true,
    });
    unequip(world, entity, 'head', { force: true });
    expect(getEffectiveStats(world, entity).armor).toBe(3);
  });

  // 9. Base stats never modified by equipment
  it('does not modify base stats on equip/unequip', () => {
    const baseBefore = world.stores.baseStats.armor[entity];
    equip(world, entity, makeItem({ statBonuses: { armor: 10 } }), { force: true });
    expect(world.stores.baseStats.armor[entity]).toBe(baseBefore);
    unequip(world, entity, 'head', { force: true });
    expect(world.stores.baseStats.armor[entity]).toBe(baseBefore);
  });

  // 10. Recompute is idempotent (no double-counting)
  it('does not double-count stats on repeated recompute', () => {
    equip(world, entity, makeItem({ statBonuses: { armor: 5 } }), { force: true });
    const before = getEffectiveStats(world, entity).armor;
    statSystem(world);
    statSystem(world);
    expect(getEffectiveStats(world, entity).armor).toBe(before);
  });

  // 11. All registered slots can be equipped independently
  it('equips all registered slots independently', () => {
    for (const slot of SLOT_REGISTRY) {
      const result = equip(
        world,
        entity,
        makeItem({ id: `item-${slot.id}`, slots: [slot.id], statBonuses: { armor: 1 } }),
        { force: true },
      );
      expect(result.ok).toBe(true);
    }
    expect(getEffectiveStats(world, entity).armor).toBe(SLOT_REGISTRY.length);
  });

  // 12. Duplicate item definitions (same id, different instances)
  it('handles duplicate item defs with independent instances', () => {
    const ringDef = makeItem({ id: 'lucky-ring', slots: ['ringLeft'], statBonuses: { luck: 3 } });
    equip(world, entity, ringDef, { force: true });
    equip(
      world,
      entity,
      makeItem({ id: 'lucky-ring', slots: ['ringRight'], statBonuses: { luck: 3 } }),
      { force: true },
    );
    expect(getEffectiveStats(world, entity).luck).toBe(7); // base 1 + 3 + 3
    unequip(world, entity, 'ringLeft', { force: true });
    expect(getEffectiveStats(world, entity).luck).toBe(4); // base 1 + 3
  });

  // 13. Invalid item def (empty slots)
  it('rejects item with empty slots', () => {
    const result = equip(world, entity, makeItem({ slots: [] }), { force: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons.some((r) => r.type === 'invalidDef')).toBe(true);
    }
  });

  // 14. Invalid item def (duplicate slots)
  it('rejects item with duplicate slots', () => {
    const result = equip(world, entity, makeItem({ slots: ['head', 'head'] }), { force: true });
    expect(result.ok).toBe(false);
  });

  it('rejects non-finite or negative weightLb', () => {
    const nanWeight = equip(world, entity, makeItem({ id: 'nan-weight', weightLb: Number.NaN }), {
      force: true,
    });
    expect(nanWeight.ok).toBe(false);
    if (!nanWeight.ok) {
      expect(nanWeight.reasons.some((r) => r.type === 'invalidDef')).toBe(true);
    }

    const negativeWeight = equip(world, entity, makeItem({ id: 'negative-weight', weightLb: -1 }), {
      force: true,
    });
    expect(negativeWeight.ok).toBe(false);
    if (!negativeWeight.ok) {
      expect(negativeWeight.reasons.some((r) => r.type === 'invalidDef')).toBe(true);
    }
  });

  // 15. Entity cleanup
  it('clears equipment state on entity cleanup', () => {
    equip(world, entity, makeItem({ statBonuses: { armor: 5 } }), { force: true });
    clearEquipmentState(world, entity);
    expect(getEquipmentState(world, entity)).toBeUndefined();
  });

  // 16. Equip/unequip determinism
  it('produces identical results for same sequence', () => {
    const world2 = createTestWorld();
    world2.state = 'safe_room';
    const e2 = setupEntity(world2);

    const items = [
      makeItem({ id: 'a', slots: ['head'], statBonuses: { armor: 5 } }),
      makeItem({ id: 'b', slots: ['chest'], statBonuses: { strength: 3 } }),
    ];

    for (const item of items) {
      equip(world, entity, item, { force: true });
      equip(world2, e2, item, { force: true });
    }

    expect(getEffectiveStats(world, entity)).toEqual(getEffectiveStats(world2, e2));
  });

  // 17. Equip fails on minStat requirement
  it('rejects equip when minStat requirement not met', () => {
    const item = makeItem({
      statBonuses: { armor: 5 },
      requirements: [{ type: 'minStat', stat: 'strength', value: 100 }],
    });
    const result = equip(world, entity, item, { force: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons.some((r) => r.type === 'requirementFailed')).toBe(true);
    }
  });

  // 18. Equip fails on notTag requirement
  it('rejects equip when notTag requirement fails', () => {
    setEntityTags(world, entity, ['male']);
    const item = makeItem({
      requirements: [{ type: 'notTag', tag: 'male' }],
    });
    const result = equip(world, entity, item, { force: true });
    expect(result.ok).toBe(false);
  });

  // 19. Equip succeeds with all requirements met
  it('equips when all requirements pass', () => {
    setEntityTags(world, entity, ['class:mage']);
    initializeBaseStats(world, entity, { strength: 10 });
    const item = makeItem({
      requirements: [
        { type: 'minStat', stat: 'strength', value: 10 },
        { type: 'hasTag', tag: 'class:mage' },
      ],
    });
    const result = equip(world, entity, item, { force: true });
    expect(result.ok).toBe(true);
  });

  // 20. canEquip returns reasons
  it('canEquip returns all failure reasons', () => {
    setEntityTags(world, entity, ['male']);
    equip(world, entity, makeItem(), { force: true });
    const item = makeItem({
      requirements: [
        { type: 'notTag', tag: 'male' },
        { type: 'minStat', stat: 'strength', value: 999 },
      ],
    });
    const result = canEquip(world, entity, item);
    expect(result.allowed).toBe(false);
    expect(result.reasons.length).toBeGreaterThanOrEqual(3); // occupied + 2 requirements
  });

  // 21. Custom requirement predicate
  it('evaluates custom requirement predicates', () => {
    registerCustomRequirement(world, 'always-fail', () => false);
    const item = makeItem({ requirements: [{ type: 'custom', id: 'always-fail' }] });
    const result = equip(world, entity, item, { force: true });
    expect(result.ok).toBe(false);
  });

  // 22. New slot added to registry — tested indirectly via slot registry length
  it('supports all registered slots', () => {
    expect(SLOT_REGISTRY.length).toBe(18);
  });

  // 23. Unknown slot rejected
  it('rejects items referencing unknown slots', () => {
    const item = makeItem({ slots: ['nonexistent'] });
    const result = equip(world, entity, item, { force: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons.some((r) => r.type === 'unknownSlot')).toBe(true);
    }
  });

  // 24. Multi-slot stats not double-counted
  it('does not double-count multi-slot item stats', () => {
    statSystem(world);
    const item = makeItem({
      id: 'gs',
      slots: ['mainHand', 'offHand'],
      statBonuses: { damageBonus: 10 },
    });
    equip(world, entity, item, { force: true });
    // Strength no longer auto-derives a generic `damagePercent` secondary (its
    // payoff is a typed-primary multiplier applied at damage resolution — see
    // shared/stats.ts#computeTypedPrimaryMultiplier), so a non-Strength item
    // equipped once must leave damagePercent at 0 (proving no double-count
    // leaked a phantom contribution) while damageBonus reflects exactly one
    // copy of the 2H item's own bonus.
    expect(getEffectiveStats(world, entity).damagePercent).toBeCloseTo(0, 6);
    expect(getEffectiveStats(world, entity).damageBonus).toBeCloseTo(10, 6);
  });

  // 25. NaN/Infinity stat values rejected
  it('rejects NaN stat values', () => {
    const item = makeItem({ statBonuses: { armor: NaN } });
    const result = equip(world, entity, item, { force: true });
    expect(result.ok).toBe(false);
  });

  it('rejects Infinity stat values', () => {
    const item = makeItem({ statBonuses: { armor: Infinity } });
    const result = equip(world, entity, item, { force: true });
    expect(result.ok).toBe(false);
  });

  // 26. Equip denied outside safe room
  it('denies equip outside safe room without force', () => {
    world.state = 'playing';
    const result = equip(world, entity, makeItem());
    expect(result.ok).toBe(false);
  });

  // 27. Entity tag requirements — hasTag checks entity tags
  it('hasTag checks entity tags not item tags', () => {
    const item = makeItem({
      tags: ['sword'], // item tag
      requirements: [{ type: 'hasTag', tag: 'warrior' }], // entity tag check
    });
    const result = equip(world, entity, item, { force: true });
    expect(result.ok).toBe(false); // entity doesn't have 'warrior' tag

    setEntityTags(world, entity, ['warrior']);
    const result2 = equip(world, entity, item, { force: true });
    expect(result2.ok).toBe(true);
  });

  // 28. Stat clamping
  it('clamps stats to defined ranges', () => {
    equip(
      world,
      entity,
      makeItem({ id: 'a', slots: ['ringLeft'], statBonuses: { dodgeChance: 0.9 } }),
      { force: true },
    );
    expect(getEffectiveStats(world, entity).dodgeChance).toBeCloseTo(0.75, 5); // capped

    equip(
      world,
      entity,
      makeItem({ id: 'b', slots: ['ringRight'], statBonuses: { cooldownReduction: 0.95 } }),
      { force: true },
    );
    expect(getEffectiveStats(world, entity).cooldownReduction).toBeCloseTo(0.8, 5); // capped
  });

  // 29. Unequip rejects unknown slot IDs
  it('rejects unequip with unknown slot id', () => {
    const result = unequip(world, entity, 'nonexistent', { force: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('Unknown slot');
    }
  });
});

// --- equipFromBag: Diablo-style equip-from-inventory swap ---

describe('equipFromBag', () => {
  let world: GameWorld;
  let entity: number;
  let bag: InventoryBag;

  beforeEach(() => {
    world = createTestWorld();
    world.state = 'safe_room';
    entity = setupEntity(world);
    bag = { slots: [] };
    world.inventories.set(entity, bag);
  });

  afterEach(() => {
    _clearEquipmentDefsForTest();
  });

  it('equips an item from the bag into an empty slot and removes it from the bag', () => {
    addItem(bag, 'iron-helm', 1);
    const result = equipFromBag(world, entity, 'iron-helm');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.swappedOut).toEqual([]);
    expect(hasItem(bag, 'iron-helm')).toBe(false);
    const state = getEquipmentState(world, entity)!;
    expect(state.equipped['head']).not.toBeNull();
    // iron-helm grants +2 armor, +1 constitution.
    expect(getEffectiveStats(world, entity).armor).toBe(2);
  });

  it('swaps: returns the previously-equipped item to the bag', () => {
    // Occupy the head slot first, then equip a second head item from the bag —
    // the occupant must be swapped back into the bag.
    equip(world, entity, getEquipmentDefForItem('iron-helm')!, { force: true });
    addItem(bag, 'iron-helm', 1);

    const result = equipFromBag(world, entity, 'iron-helm');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.swappedOut).toEqual(['iron-helm']);
    // The swapped-out helm is back in the bag; the freshly equipped one occupies head.
    expect(getItemCount(bag, 'iron-helm')).toBe(1);
    expect(getEquipmentState(world, entity)!.equipped['head']).not.toBeNull();
  });

  it('fails and mutates nothing when the item is not in the bag', () => {
    const result = equipFromBag(world, entity, 'iron-helm');
    expect(result.ok).toBe(false);
    expect(getEquipmentState(world, entity)?.equipped['head'] ?? null).toBeNull();
  });

  it('fails when the item id is not equippable', () => {
    addItem(bag, 'iron-ore', 1); // a material, no equipment def
    const result = equipFromBag(world, entity, 'iron-ore');
    expect(result.ok).toBe(false);
    expect(hasItem(bag, 'iron-ore')).toBe(true); // untouched
  });

  it('fails when the entity has no inventory bag', () => {
    world.inventories.delete(entity);
    const result = equipFromBag(world, entity, 'iron-helm');
    expect(result.ok).toBe(false);
  });

  it('honors the safe-context gate and leaves the bag untouched outside a safe room', () => {
    world.state = 'playing';
    world.playerInSafeRoom = false;
    addItem(bag, 'iron-helm', 1);
    const result = equipFromBag(world, entity, 'iron-helm');
    expect(result.ok).toBe(false);
    expect(hasItem(bag, 'iron-helm')).toBe(true); // early return, no removal
    expect(getEquipmentState(world, entity)?.equipped['head'] ?? null).toBeNull();
  });

  it('force bypasses the safe-context gate', () => {
    world.state = 'playing';
    world.playerInSafeRoom = false;
    addItem(bag, 'iron-helm', 1);
    const result = equipFromBag(world, entity, 'iron-helm', { force: true });
    expect(result.ok).toBe(true);
    expect(hasItem(bag, 'iron-helm')).toBe(false);
  });

  // Regression: the swap must be ATOMIC. A 2H item that can never be equipped
  // would need to unequip BOTH hand occupants first; a rollback that re-equips
  // them one-by-one can permanently delete an item whose requirement is only met
  // by another (not-yet-restored) occupant. The pre-mutation feasibility gate
  // must refuse the whole swap up front, leaving every item exactly where it was.
  it('is atomic: refuses an infeasible swap without losing the dependency-linked items it would displace', () => {
    // Base STR 8. The blade (mainHand) requires STR>=10, satisfied ONLY by the
    // girdle (offHand, +5 STR → live STR 13). A 2H item needing STR>=30 can never
    // be equipped. The OLD rollback re-equipped the blade first (girdle not yet
    // restored → STR 8 < 10 → blade silently dropped). The gate must reject it.
    initializeBaseStats(world, entity, { strength: 8 });
    _registerEquipmentDefForTest({
      id: 'colossus-blade',
      name: 'Colossus Blade',
      slots: ['mainHand', 'offHand'],
      statBonuses: {},
      weightLb: 0,
      rarity: 'rare',
      requirements: [{ type: 'minStat', stat: 'strength', value: 30 }],
    });
    const girdle = makeItem({
      id: 'giant-girdle',
      slots: ['offHand'],
      statBonuses: { strength: 5 },
    });
    const blade = makeItem({
      id: 'heavy-blade',
      slots: ['mainHand'],
      statBonuses: { damageBonus: 6 },
      requirements: [{ type: 'minStat', stat: 'strength', value: 10 }],
    });
    // Girdle first so STR (8 + 5) meets the blade's requirement at equip time.
    expect(equip(world, entity, girdle, { force: true }).ok).toBe(true);
    expect(equip(world, entity, blade, { force: true }).ok).toBe(true);
    const statsBefore = getEffectiveStats(world, entity);

    addItem(bag, 'colossus-blade', 1, TEST_CATALOG);
    const result = equipFromBag(world, entity, 'colossus-blade');

    expect(result.ok).toBe(false);
    // No item lost: the new item stays bagged; neither occupant was displaced.
    expect(getItemCount(bag, 'colossus-blade')).toBe(1);
    expect(hasItem(bag, 'heavy-blade')).toBe(false);
    expect(hasItem(bag, 'giant-girdle')).toBe(false);
    const state = getEquipmentState(world, entity)!;
    expect(state.instances.get(state.equipped['mainHand']!)?.def.id).toBe('heavy-blade');
    expect(state.instances.get(state.equipped['offHand']!)?.def.id).toBe('giant-girdle');
    // Stats unchanged — no partial unequip left the entity weaker.
    expect(getEffectiveStats(world, entity)).toEqual(statsBefore);
  });

  // Companion to the atomicity test: a requirement-gated swap that IS feasible on
  // the post-unequip basis must still go through (the gate is not over-eager).
  it('allows a requirement-gated swap that is feasible after the target slot is freed', () => {
    initializeBaseStats(world, entity, { strength: 12 });
    _registerEquipmentDefForTest({
      id: 'warblade',
      name: 'Warblade',
      slots: ['mainHand'],
      statBonuses: { damageBonus: 4 },
      weightLb: 0,
      rarity: 'rare',
      requirements: [{ type: 'minStat', stat: 'strength', value: 10 }],
    });
    addItem(bag, 'warblade', 1, TEST_CATALOG);
    const result = equipFromBag(world, entity, 'warblade');
    expect(result.ok).toBe(true);
    expect(hasItem(bag, 'warblade')).toBe(false);
    const state = getEquipmentState(world, entity)!;
    expect(state.instances.get(state.equipped['mainHand']!)?.def.id).toBe('warblade');
  });
});

// --- Equippable placeholder coverage across the paper-doll ---

describe('equippable slot coverage', () => {
  it('every paper-doll slot has at least one equippable item', () => {
    const covered = new Set<string>();
    for (const id of getEquippableItemIds()) {
      const def = getEquipmentDefForItem(id);
      if (def) for (const slotId of def.slots) covered.add(slotId);
    }
    for (const slot of SLOT_REGISTRY) {
      expect(covered.has(slot.id), `slot ${slot.id} has no equippable item`).toBe(true);
    }
  });

  it('GEAR_ITEM_IDS covers 15 armor/accessory slots and excludes hands + neck', () => {
    const gearSlots = new Set<string>();
    for (const id of GEAR_ITEM_IDS) {
      const def = getEquipmentDefForItem(id);
      expect(def, `gear id ${id} has no equipment def`).toBeDefined();
      for (const slotId of def!.slots) gearSlots.add(slotId);
    }
    expect(GEAR_ITEM_IDS).toHaveLength(15);
    expect(gearSlots.has('mainHand')).toBe(false);
    expect(gearSlots.has('offHand')).toBe(false);
    expect(gearSlots.has('neck')).toBe(false);
  });
});
