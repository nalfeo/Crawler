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
  generatedEquipmentBaseHasNonArmorStatBonus,
  getGeneratedEquipmentBaseV1,
} from '../../src/game/generated-equipment-generator.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { getEquippableItemIds } from '../../src/shared/equipmentDefs.js';
import { createTestWorld } from '../helpers/world-factory.js';

const LEGAL_RARITIES = ['common', 'uncommon', 'rare'] as const;

describe('Floor 2 central reward pool — derived counts and coverage', () => {
  it('contains exactly 88 bases: 56 weapons + 32 non-weapons, partitioning cleanly', () => {
    expect(FLOOR2_REWARD_POOL_STABLE_IDS).toHaveLength(88);
    expect(FLOOR2_REWARD_POOL_WEAPON_IDS).toHaveLength(56);
    expect(FLOOR2_REWARD_POOL_NON_WEAPON_IDS).toHaveLength(32);
    expect(FLOOR2_REWARD_POOL_WEAPON_IDS.length + FLOOR2_REWARD_POOL_NON_WEAPON_IDS.length).toBe(
      FLOOR2_REWARD_POOL_STABLE_IDS.length,
    );
    // No duplicates within the pool, and the weapon/non-weapon subsets are
    // disjoint (every ID appears in exactly one subset).
    expect(new Set(FLOOR2_REWARD_POOL_STABLE_IDS).size).toBe(88);
    const weaponSet = new Set(FLOOR2_REWARD_POOL_WEAPON_IDS);
    const nonWeaponSet = new Set(FLOOR2_REWARD_POOL_NON_WEAPON_IDS);
    for (const id of weaponSet) expect(nonWeaponSet.has(id)).toBe(false);
  });

  it('is derived (not hand-copied): includes all 18 Classic Fantasy Basic Leather bases (6 weapons + 12 non-weapons)', () => {
    expect(FLOOR2_BASIC_LEATHER_STABLE_IDS).toHaveLength(18);
    expect(FLOOR2_BASIC_LEATHER_WEAPON_IDS).toHaveLength(6);
    expect(FLOOR2_BASIC_LEATHER_NON_WEAPON_IDS).toHaveLength(12);
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

  it('exactly matches the 88-entry art manifest, set-for-set', () => {
    const manifestIds = new Set(FLOOR2_EQUIPMENT_ART_DEFINITIONS.map((entry) => entry.stableId));
    expect(manifestIds.size).toBe(88);
    expect(new Set(FLOOR2_REWARD_POOL_STABLE_IDS)).toEqual(manifestIds);
  });

  it('reaches every one of the 16 real armor slots (excludes mainHand/offHand)', () => {
    const expectedArmorSlots = SLOT_REGISTRY.filter(
      (slot) => slot.id !== 'mainHand' && slot.id !== 'offHand',
    ).map((slot) => slot.id);
    expect(expectedArmorSlots).toHaveLength(16);
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

  it("a base's inherent non-armor stat bonus is source-independent: identical at every rarity, for every caller", () => {
    // leather-collar (charisma), leather-belt (luck), iron-ring (luck) are
    // the 3 Basic Leather non-weapon bases that carry an inherent non-armor
    // stat bonus in the catalog (see floor2-basic-leather-bases.ts).
    // `generateEquipmentInstance` must NEVER mutate a base's inherent stats
    // based on rarity or caller — the same base always yields the same
    // `statBonuses` baseline (base bonus + that rarity's effect budget)
    // regardless of who is generating it (achievement reward, Quartermaster,
    // or anything else). The reward-bundle resolver enforces the Common
    // rarity contract by excluding such bases from *candidacy* for a Common
    // draw specifically (see floor2-reward-bundle-resolver.test.ts) — never
    // by stripping generated output.
    const basesWithInherentNonArmorBonus = FLOOR2_BASIC_LEATHER_NON_WEAPON_BASES.filter((def) =>
      Object.entries(def.statBonuses).some(
        ([stat, value]) => stat !== 'armor' && (value ?? 0) !== 0,
      ),
    );
    expect(basesWithInherentNonArmorBonus).toHaveLength(3);
    expect(new Set(basesWithInherentNonArmorBonus.map((def) => def.id))).toEqual(
      new Set(['accessory.leather-collar', 'accessory.leather-belt', 'accessory.iron-ring']),
    );
    for (const def of basesWithInherentNonArmorBonus) {
      expect(generatedEquipmentBaseHasNonArmorStatBonus(def.id)).toBe(true);
    }

    for (const [index, def] of basesWithInherentNonArmorBonus.entries()) {
      for (const rarity of LEGAL_RARITIES) {
        const world = createTestWorld({
          seed: 200 + index,
          generatedEquipmentRunKey: `basic-leather-source-independent-${index}-${rarity}`,
        });
        const instance = generateEquipmentInstance(world, {
          baseId: def.id,
          itemLevel: 6,
          rarity,
          enhancementLevel: 0,
        });
        const nonArmor = Object.entries(instance.frozen.statBonuses).filter(
          ([stat, value]) => stat !== 'armor' && (value ?? 0) !== 0,
        );
        expect(
          nonArmor.length,
          `${def.id} at ${rarity} must preserve its inherent non-armor base bonus (source-independent)`,
        ).toBeGreaterThan(0);
      }
    }
  });
});
