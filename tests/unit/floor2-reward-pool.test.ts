import { describe, expect, it } from 'vitest';
import {
  FLOOR2_ARMOR_SLOT_IDS,
  FLOOR2_REWARD_POOL_NON_WEAPON_IDS,
  FLOOR2_REWARD_POOL_STABLE_IDS,
  FLOOR2_REWARD_POOL_WEAPON_IDS,
} from '../../src/shared/data/floor2-reward-pool.js';
import { FLOOR2_EQUIPMENT_ART_DEFINITIONS } from '../../src/shared/data/floor2-equipment-art.js';
import {
  FLOOR2_BASIC_LEATHER_NON_WEAPON_BASES,
  FLOOR2_BASIC_LEATHER_NON_WEAPON_IDS,
  FLOOR2_BASIC_LEATHER_STABLE_IDS,
  FLOOR2_BASIC_LEATHER_WEAPON_BASES,
  FLOOR2_BASIC_LEATHER_WEAPON_IDS,
} from '../../src/shared/data/floor2-basic-leather-bases.js';
import { SLOT_REGISTRY } from '../../src/shared/equipment-slots.js';
import {
  generateEquipmentInstance,
  _getGeneratedEquipmentBaseV1 as getGeneratedEquipmentBaseV1,
} from '../../src/game/generated-equipment-generator.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { getEquippableItemIds } from '../../src/shared/equipmentDefs.js';
import { createTestWorld } from '../helpers/world-factory.js';

const LEGAL_RARITIES = ['common', 'uncommon', 'rare'] as const;

describe('Floor 2 central reward pool — derived counts and coverage', () => {
  it('contains exactly 81 bases: 56 weapons + 25 non-weapons, partitioning cleanly', () => {
    expect(FLOOR2_REWARD_POOL_STABLE_IDS).toHaveLength(81);
    expect(FLOOR2_REWARD_POOL_WEAPON_IDS).toHaveLength(56);
    expect(FLOOR2_REWARD_POOL_NON_WEAPON_IDS).toHaveLength(25);
    expect(FLOOR2_REWARD_POOL_WEAPON_IDS.length + FLOOR2_REWARD_POOL_NON_WEAPON_IDS.length).toBe(
      FLOOR2_REWARD_POOL_STABLE_IDS.length,
    );
    // No duplicates within the pool, and the weapon/non-weapon subsets are
    // disjoint (every ID appears in exactly one subset).
    expect(new Set(FLOOR2_REWARD_POOL_STABLE_IDS).size).toBe(81);
    const weaponSet = new Set(FLOOR2_REWARD_POOL_WEAPON_IDS);
    const nonWeaponSet = new Set(FLOOR2_REWARD_POOL_NON_WEAPON_IDS);
    for (const id of weaponSet) expect(nonWeaponSet.has(id)).toBe(false);
  });

  it('is derived (not hand-copied): includes all 13 active Basic Leather bases (6 weapons + 7 non-weapons)', () => {
    expect(FLOOR2_BASIC_LEATHER_STABLE_IDS).toHaveLength(13);
    expect(FLOOR2_BASIC_LEATHER_WEAPON_IDS).toHaveLength(6);
    expect(FLOOR2_BASIC_LEATHER_NON_WEAPON_IDS).toHaveLength(7);
    for (const id of FLOOR2_BASIC_LEATHER_STABLE_IDS) {
      expect(FLOOR2_REWARD_POOL_STABLE_IDS).toContain(id);
    }
    for (const id of FLOOR2_BASIC_LEATHER_WEAPON_IDS) {
      expect(FLOOR2_REWARD_POOL_WEAPON_IDS).toContain(id);
    }
    for (const id of FLOOR2_BASIC_LEATHER_NON_WEAPON_IDS) {
      expect(FLOOR2_REWARD_POOL_NON_WEAPON_IDS).toContain(id);
    }
  });

  it('exactly matches the active art manifest, set-for-set', () => {
    const manifestIds = new Set(FLOOR2_EQUIPMENT_ART_DEFINITIONS.map((entry) => entry.stableId));
    expect(manifestIds.size).toBe(81);
    expect(new Set(FLOOR2_REWARD_POOL_STABLE_IDS)).toEqual(manifestIds);
  });

  it('reaches every one of the 8 real armor slots (excludes mainHand/offHand)', () => {
    const expectedArmorSlots = SLOT_REGISTRY.filter(
      (slot) => slot.id !== 'mainHand' && slot.id !== 'offHand',
    ).map((slot) => slot.id);
    expect(expectedArmorSlots).toHaveLength(8);
    expect(new Set(FLOOR2_ARMOR_SLOT_IDS)).toEqual(new Set(expectedArmorSlots));

    const nonWeaponBaseIds = new Set(FLOOR2_REWARD_POOL_NON_WEAPON_IDS);
    const coveredSlots = new Set<string>();
    for (const definition of FLOOR2_EQUIPMENT_ART_DEFINITIONS) {
      if (definition.category === 'weapon' || !nonWeaponBaseIds.has(definition.stableId)) continue;
      const base = getGeneratedEquipmentBaseV1(definition.stableId);
      for (const slot of base.slots) {
        if (slot !== 'mainHand' && slot !== 'offHand') coveredSlots.add(slot);
      }
    }
    for (const slotId of FLOOR2_ARMOR_SLOT_IDS) {
      expect(coveredSlots.has(slotId), `armor slot "${slotId}" must be reachable`).toBe(true);
    }
  });

  it('never includes a duplicate stable ID between weapon and non-weapon subsets or across catalogs', () => {
    const seen = new Set<string>();
    for (const id of FLOOR2_REWARD_POOL_STABLE_IDS) {
      expect(seen.has(id), `duplicate pool ID: ${id}`).toBe(false);
      seen.add(id);
    }
  });
});

describe('Classic Fantasy [Basic Leather] — art resolution and no placeholders', () => {
  it('every Basic Leather stable ID resolves to a manifest entry with a matching, non-placeholder art key', () => {
    const manifestById = new Map(
      FLOOR2_EQUIPMENT_ART_DEFINITIONS.map((entry) => [entry.stableId, entry]),
    );
    for (const stableId of FLOOR2_BASIC_LEATHER_STABLE_IDS) {
      const manifestEntry = manifestById.get(stableId);
      expect(manifestEntry, `missing art manifest entry for ${stableId}`).toBeDefined();
      if (manifestEntry?.category === 'weapon') {
        expect(manifestEntry.family).toBe('basic-leather');
      }
      const base = getGeneratedEquipmentBaseV1(stableId);
      expect(base.artKey).toBe(manifestEntry?.runtimeKey);
      expect(base.artKey).not.toContain('placeholder');
      expect(manifestEntry?.runtimeKey).not.toContain('placeholder');
    }
  });

  it('registers all 6 Basic Leather weapons in weaponDefs and all 18 bases stay out of the equippable-inventory catalog (ADR 0068)', () => {
    const inventoryEquipmentIds = new Set(getEquippableItemIds());
    for (const definition of FLOOR2_BASIC_LEATHER_WEAPON_BASES) {
      expect(getWeaponDef(definition.weaponDef.id)).toBe(definition.weaponDef);
      expect(inventoryEquipmentIds.has(definition.stableId)).toBe(false);
    }
    for (const definition of FLOOR2_BASIC_LEATHER_NON_WEAPON_BASES) {
      expect(inventoryEquipmentIds.has(definition.id)).toBe(false);
    }
  });

  it('generates deterministic legal Common/Uncommon/Rare instances for every Basic Leather base', () => {
    for (const [index, stableId] of FLOOR2_BASIC_LEATHER_STABLE_IDS.entries()) {
      for (const rarity of LEGAL_RARITIES) {
        const world = createTestWorld({
          seed: 100 + index,
          generatedEquipmentRunKey: `basic-leather-${index}-${rarity}`,
        });
        const generated = generateEquipmentInstance(world, {
          baseId: stableId,
          itemLevel: 6,
          rarity,
          enhancementLevel: 0,
        });
        expect(generated.baseId).toBe(stableId);
        expect(generated.rarity).toBe(rarity);
      }
    }
  });

  it('non-armor base stat bonuses are the instance inherent line; affixes stack on top', () => {
    // leather-collar (charisma) and iron-ring (luck) are the two Basic Leather
    // non-weapon bases that carry an inherent non-armor stat bonus in the
    // catalog (see floor2-basic-leather-bases.ts). A non-weapon base's
    // authored non-armor line IS its identity and reaches every instance at
    // every rarity (ADR 2026-08-27-generated-equipment-inherent-stat-line); the rarity-affix budget stacks on top:
    //   common   → 0 effects → inherent line only (never stat-less)
    //   uncommon → 1 effect  → inherent line + 1 affix stat/grant
    //   rare     → 2 effects → inherent line + up to 2 affix stats/grants
    const basesWithInherentNonArmorBonus = FLOOR2_BASIC_LEATHER_NON_WEAPON_BASES.filter((def) =>
      Object.entries(def.statBonuses).some(
        ([stat, value]) => stat !== 'armor' && (value ?? 0) !== 0,
      ),
    );
    expect(basesWithInherentNonArmorBonus).toHaveLength(2);
    expect(new Set(basesWithInherentNonArmorBonus.map((def) => def.id))).toEqual(
      new Set(['accessory.leather-collar', 'accessory.iron-ring']),
    );

    for (const [index, def] of basesWithInherentNonArmorBonus.entries()) {
      const inherentNonArmor = Object.entries(def.statBonuses).filter(
        ([stat, value]) => stat !== 'armor' && (value ?? 0) !== 0,
      );

      // At Common (0-affix budget) the frozen non-armor stats are exactly the
      // authored inherent line — this is what keeps Common items from
      // generating with an empty stat map (issue #3697).
      const commonWorld = createTestWorld({
        seed: 200 + index,
        generatedEquipmentRunKey: `basic-leather-inherent-${index}-common`,
      });
      const commonInstance = generateEquipmentInstance(commonWorld, {
        baseId: def.id,
        itemLevel: 6,
        rarity: 'common',
        enhancementLevel: 0,
      });
      const commonNonArmor = Object.entries(commonInstance.frozen.statBonuses).filter(
        ([stat, value]) => stat !== 'armor' && (value ?? 0) !== 0,
      );
      expect(
        new Map(commonNonArmor),
        `${def.id} at common must carry exactly its inherent non-armor line`,
      ).toEqual(new Map(inherentNonArmor));

      // At Uncommon/Rare the frozen non-armor stats must equal the inherent
      // line plus the sum of resolved stat effects.
      for (const rarity of ['uncommon', 'rare'] as const) {
        const world = createTestWorld({
          seed: 200 + index,
          generatedEquipmentRunKey: `basic-leather-inherent-${index}-${rarity}`,
        });
        const instance = generateEquipmentInstance(world, {
          baseId: def.id,
          itemLevel: 6,
          rarity,
          enhancementLevel: 0,
        });
        const expectedNonArmor = new Map(inherentNonArmor.map(([stat, value]) => [stat, value!]));
        for (const effect of instance.resolvedEffects) {
          if ('kind' in effect && effect.kind === 'stat' && effect.stat !== 'armor') {
            expectedNonArmor.set(
              effect.stat,
              (expectedNonArmor.get(effect.stat) ?? 0) + effect.value,
            );
          }
        }
        for (const [stat, value] of Object.entries(instance.frozen.statBonuses)) {
          if (stat === 'armor') continue;
          expect(
            value ?? 0,
            `${def.id} at ${rarity}: frozen.statBonuses.${stat} must equal inherent + resolved effects`,
          ).toBe(expectedNonArmor.get(stat) ?? 0);
        }
      }
    }
  });
});
