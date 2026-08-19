import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { addEntity } from 'bitecs';
import { createTestWorld } from '../helpers/world-factory.js';
import type { GameWorld } from '../../src/core/world.js';
import {
  computeEffectiveStatsFromLoadout,
  type StatBonusSource,
} from '../../src/core/effective-stats.js';
import {
  addGeneratedEquipmentToBag,
  equipFromBag,
  initializeBaseStats,
  equip,
  previewEquipDelta,
} from '../../src/core/systems/equipmentSystem.js';
import { createGeneratedEquipmentInstance } from '../../src/core/generated-equipment-registry.js';
import { getEquipmentDefForItem } from '../../src/shared/equipmentDefs.js';
import equipmentDefsTestSeams from '../../src/shared/equipmentDefs.test-seams.js';
import type { EquipmentItemDef } from '../../src/shared/equipment-types.js';
import {
  FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
  type GeneratedEquipmentCreateInputV1,
} from '../../src/shared/generated-equipment-types.js';
import { createInventoryBag } from '../../src/shared/inventory.js';
import {
  DEFAULT_BASE_STATS,
  CORE_STAT_TO_SECONDARY,
  clampStat,
  type PrimaryStatId,
  type StatId,
} from '../../src/shared/stats.js';

const LUCK_TO_CRIT = CORE_STAT_TO_SECONDARY.luck.critChance!;
const DEX_TO_DODGE = CORE_STAT_TO_SECONDARY.dexterity.dodgeChance!;

function baseMap(): Record<StatId, number> {
  return { ...DEFAULT_BASE_STATS };
}

function zeroCore(): Record<PrimaryStatId, number> {
  return {
    strength: 0,
    dexterity: 0,
    constitution: 0,
    intelligence: 0,
    wisdom: 0,
    charisma: 0,
    luck: 0,
  };
}

// ---------------------------------------------------------------------------
// Pure loadout formula
// ---------------------------------------------------------------------------

describe('computeEffectiveStatsFromLoadout (pure)', () => {
  it('with no items or core points equals base + secondary derivation', () => {
    const eff = computeEffectiveStatsFromLoadout(baseMap(), zeroCore(), []);
    expect(eff.strength).toBe(DEFAULT_BASE_STATS.strength);
    // Secondaries derive from the base primaries.
    expect(eff.critChance).toBeCloseTo(
      DEFAULT_BASE_STATS.critChance + DEFAULT_BASE_STATS.luck * LUCK_TO_CRIT,
      6,
    );
    expect(eff.dodgeChance).toBeCloseTo(
      DEFAULT_BASE_STATS.dodgeChance + DEFAULT_BASE_STATS.dexterity * DEX_TO_DODGE,
      6,
    );
  });

  it('folds core-stat points into the effective primaries', () => {
    const core = zeroCore();
    core.strength = 5;
    const eff = computeEffectiveStatsFromLoadout(baseMap(), core, []);
    expect(eff.strength).toBe(DEFAULT_BASE_STATS.strength + 5);
  });

  it('adds a single item flat bonus', () => {
    const items: StatBonusSource[] = [{ statBonuses: { armor: 5 }, weightLb: 0 }];
    const eff = computeEffectiveStatsFromLoadout(baseMap(), zeroCore(), items);
    expect(eff.armor).toBe(DEFAULT_BASE_STATS.armor + 5);
  });

  it('sums bonuses across multiple items (caller supplies unique instances)', () => {
    const items: StatBonusSource[] = [
      { statBonuses: { armor: 5 }, weightLb: 0 },
      { statBonuses: { armor: 3, strength: 2 }, weightLb: 0 },
    ];
    const eff = computeEffectiveStatsFromLoadout(baseMap(), zeroCore(), items);
    expect(eff.armor).toBe(DEFAULT_BASE_STATS.armor + 8);
    expect(eff.strength).toBe(DEFAULT_BASE_STATS.strength + 2);
  });

  it('re-derives secondaries after a primary bonus (luck raises critChance)', () => {
    const items: StatBonusSource[] = [{ statBonuses: { luck: 4, critChance: 0.02 }, weightLb: 0 }];
    const eff = computeEffectiveStatsFromLoadout(baseMap(), zeroCore(), items);
    // Flat crit bonus + secondary derived from the extra luck.
    const expected =
      DEFAULT_BASE_STATS.critChance + 0.02 + (DEFAULT_BASE_STATS.luck + 4) * LUCK_TO_CRIT;
    expect(eff.critChance).toBeCloseTo(expected, 6);
  });

  it('clamps every stat to its configured range', () => {
    const core = zeroCore();
    core.luck = 100000;
    core.dexterity = 100000;
    const eff = computeEffectiveStatsFromLoadout(baseMap(), core, []);
    expect(eff.critChance).toBe(clampStat('critChance', Number.MAX_SAFE_INTEGER));
    expect(eff.dodgeChance).toBe(clampStat('dodgeChance', Number.MAX_SAFE_INTEGER));
  });

  it('does not mutate the base-stats input', () => {
    const base = baseMap();
    const snapshot = { ...base };
    computeEffectiveStatsFromLoadout(base, zeroCore(), [
      { statBonuses: { armor: 9 }, weightLb: 0 },
    ]);
    expect(base).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// previewEquipDelta (catalog-backed, read-only)
// ---------------------------------------------------------------------------

describe('previewEquipDelta', () => {
  let world: GameWorld;
  let entity: number;

  beforeEach(() => {
    world = createTestWorld({ generatedEquipmentRunKey: 'b2-preview-test' });
    world.state = 'safe_room';
    entity = addEntity(world.ecs);
    initializeBaseStats(world, entity);
  });

  afterEach(() => {
    equipmentDefsTestSeams._clearEquipmentDefsForTest();
  });

  it('returns null for a non-equippable item id', () => {
    expect(previewEquipDelta(world, entity, 'definitely-not-a-real-item')).toBeNull();
  });

  it('reports the direct bonuses when equipping into an empty slot', () => {
    // iron-helm: { armor: 2, constitution: 1 } on the head slot (empty here).
    const preview = previewEquipDelta(world, entity, 'iron-helm')!;
    expect(preview).not.toBeNull();
    expect(preview.deltas.armor).toBe(2);
    expect(preview.deltas.constitution).toBe(1);
    expect(preview.swappedOut).toHaveLength(0);
    expect(preview.canEquip).toBe(true);
    // constitution has no secondary derivation, so nothing else moves.
    expect(preview.deltas.dodgeChance).toBeCloseTo(0, 6);
    expect(preview.deltas.critChance).toBeCloseTo(0, 6);
  });

  it('includes secondary re-derivation from a primary bonus in the delta', () => {
    // band-of-fortune: { luck: 1, xpBonus: 0.05 } on the ring1 slot.
    const preview = previewEquipDelta(world, entity, 'band-of-fortune')!;
    expect(preview.deltas.luck).toBe(1);
    expect(preview.deltas.critChance).toBeCloseTo(LUCK_TO_CRIT, 6);
  });

  it('nets to zero and lists the swapped-out item when replacing an identical item', () => {
    // Equip iron-helm, then preview equipping iron-helm again. Without loss
    // accounting the delta would double-count +armor; correct accounting nets 0.
    const helm = getEquipmentDefForItem('iron-helm')!;
    expect(equip(world, entity, helm, { force: true }).ok).toBe(true);

    const preview = previewEquipDelta(world, entity, 'iron-helm')!;
    expect(preview.deltas.armor).toBe(0);
    expect(preview.deltas.constitution).toBe(0);
    expect(preview.swappedOut).toHaveLength(1);
    expect(preview.swappedOut[0]!.id).toBe('iron-helm');
    expect(preview.canEquip).toBe(true);
  });

  it('uses the frozen display name for a displaced generated instance', () => {
    const input: GeneratedEquipmentCreateInputV1 = {
      baseId: 'armor.preview-helm',
      itemLevel: 2,
      rarity: 'common',
      enhancementLevel: 0,
      resolvedEffects: [],
      frozen: {
        schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
        displayName: 'Frozen Preview Helm',
        artKey: 'equipment.preview-helm',
        slots: ['head'],
        tags: ['armor'],
        weightLb: 4,
        statBonuses: { armor: 1 },
        abilityGrants: [],
        passiveGrants: [],
        activeWeaponSnapshot: null,
      },
    };
    const generated = createGeneratedEquipmentInstance(world, input);
    world.inventories.set(entity, createInventoryBag());
    expect(addGeneratedEquipmentToBag(world, entity, generated.instanceId).ok).toBe(true);
    expect(
      equipFromBag(world, entity, {
        kind: 'generated-instance',
        instanceKey: generated.instanceId,
      }).ok,
    ).toBe(true);

    const preview = previewEquipDelta(world, entity, 'iron-helm')!;

    expect(preview.swappedOut).toHaveLength(1);
    expect(preview.swappedOut[0]!.id).toBe(generated.instanceId);
    expect(preview.swappedOut[0]!.name).toBe('Frozen Preview Helm');
  });

  it('does not mutate live effective stats (read-only preview)', () => {
    const before = { ...world.stores.effectiveStats.armor };
    previewEquipDelta(world, entity, 'iron-breastplate');
    expect({ ...world.stores.effectiveStats.armor }).toEqual(before);
  });

  it('reports canEquip=false when the requirement is met only by the item being swapped out', () => {
    // A signet requiring STR>=10 targets the ringLeft slot, which currently holds
    // a +5 STR band (base STR 8 → live 13, so the requirement LOOKS satisfiable).
    // But the swap removes the band first, dropping STR to 8, so the real equip
    // would fail. The preview must use the POST-UNEQUIP basis, not live stats.
    initializeBaseStats(world, entity, { strength: 8 });
    const band: EquipmentItemDef = {
      id: 'str-band',
      name: 'Band of Might',
      slots: ['ring1'],
      statBonuses: { strength: 5 },
      weightLb: 0,
      rarity: 'common',
    };
    expect(equip(world, entity, band, { force: true }).ok).toBe(true);
    equipmentDefsTestSeams._registerEquipmentDefForTest({
      id: 'heavy-signet',
      name: 'Heavy Signet',
      slots: ['ring1'],
      statBonuses: { armor: 3 },
      weightLb: 0,
      rarity: 'rare',
      requirements: [{ type: 'minStat', stat: 'strength', value: 10 }],
    });

    const preview = previewEquipDelta(world, entity, 'heavy-signet')!;
    expect(preview).not.toBeNull();
    expect(preview.swappedOut.map((d) => d.id)).toEqual(['str-band']);
    // Old (live-stats) basis would wrongly report true (13 >= 10). Correct
    // post-unequip basis is 8 < 10 → not equippable.
    expect(preview.canEquip).toBe(false);
  });

  it('reports canEquip=true when the requirement still holds on the post-unequip basis', () => {
    // Signet requires only STR>=8 (base), which survives removing the band.
    initializeBaseStats(world, entity, { strength: 8 });
    const band: EquipmentItemDef = {
      id: 'str-band',
      name: 'Band of Might',
      slots: ['ring1'],
      statBonuses: { strength: 5 },
      weightLb: 0,
      rarity: 'common',
    };
    expect(equip(world, entity, band, { force: true }).ok).toBe(true);
    equipmentDefsTestSeams._registerEquipmentDefForTest({
      id: 'light-signet',
      name: 'Light Signet',
      slots: ['ring1'],
      statBonuses: { armor: 1 },
      weightLb: 0,
      rarity: 'common',
      requirements: [{ type: 'minStat', stat: 'strength', value: 8 }],
    });

    const preview = previewEquipDelta(world, entity, 'light-signet')!;
    expect(preview.canEquip).toBe(true);
  });
});
