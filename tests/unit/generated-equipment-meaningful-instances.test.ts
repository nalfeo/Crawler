/**
 * Regression guard for issue #3697 ("leather gloves offer no stat bonus at
 * all"): no shipped generated-equipment base may realize into a *dead item*.
 *
 * A generated instance is meaningful when it can actually do something for the
 * player: it swings (an `activeWeaponSnapshot`), it carries at least one
 * non-zero stat bonus, or it grants an ability/passive. Before ADR 2026-08-27-generated-equipment-inherent-stat-line every
 * non-weapon base with no inherent `armor` (legacy `leather-gloves`,
 * `feet.merchant-sandals`, `accessory.compass-charm`, …) realized at Common
 * with a literally empty `statBonuses` map, because Common has a zero-effect
 * affix budget and inherent non-armor stats were dropped. Those items still
 * occupied a slot and still cost full price at the Floor 2 Quartermaster.
 *
 * Determinism: fixed seeds and fixed run keys; every assertion is on generated
 * content, never on wall-clock or unseeded RNG.
 */
import { describe, expect, it } from 'vitest';
import { generateEquipmentInstance } from '../../src/game/generated-equipment-generator.js';
import { FLOOR2_BASIC_LEATHER_NON_WEAPON_BASES } from '../../src/shared/data/floor2-basic-leather-bases.js';
import { FLOOR2_REWARD_POOL_STABLE_IDS } from '../../src/shared/data/floor2-reward-pool.js';
import { FLOOR2_QUARTERMASTER_GENERATED_BASE_IDS } from '../../src/shared/equipmentDefs.js';
import type { GeneratedEquipmentInstanceV1 } from '../../src/shared/generated-equipment-types.js';
import { createTestWorld } from '../helpers/world-factory.js';

/** Every base id the shipped acquisition paths can draw from. */
const SHIPPED_BASE_IDS: readonly string[] = Object.freeze([
  ...new Set<string>([
    ...FLOOR2_QUARTERMASTER_GENERATED_BASE_IDS,
    ...FLOOR2_REWARD_POOL_STABLE_IDS,
    ...FLOOR2_BASIC_LEATHER_NON_WEAPON_BASES.map((def) => def.id),
  ]),
]);

function isMeaningful(instance: GeneratedEquipmentInstanceV1): boolean {
  return (
    instance.frozen.activeWeaponSnapshot !== null ||
    instance.frozen.abilityGrants.length > 0 ||
    instance.frozen.passiveGrants.length > 0 ||
    Object.values(instance.frozen.statBonuses).some((value) => (value ?? 0) !== 0)
  );
}

describe('generated equipment never realizes a stat-less item', () => {
  it('every shipped base is meaningful at Common (the zero-affix rarity)', () => {
    const blank: string[] = [];
    for (const [index, baseId] of SHIPPED_BASE_IDS.entries()) {
      const world = createTestWorld({
        seed: 1000 + index,
        generatedEquipmentRunKey: `meaningful-common-${index}`,
      });
      const instance = generateEquipmentInstance(world, {
        baseId,
        itemLevel: 3,
        rarity: 'common',
        enhancementLevel: 0,
      });
      if (!isMeaningful(instance)) blank.push(baseId);
    }
    expect(blank, `bases realizing a dead Common item: ${blank.join(', ')}`).toEqual([]);
  });

  it('leather gloves keep their authored identity at Common (issue #3697)', () => {
    const world = createTestWorld({
      seed: 3697,
      generatedEquipmentRunKey: 'leather-gloves-common',
    });
    const instance = generateEquipmentInstance(world, {
      baseId: 'leather-gloves',
      itemLevel: 1,
      rarity: 'common',
      enhancementLevel: 0,
    });
    expect(instance.resolvedEffects).toHaveLength(0);
    expect(instance.frozen.statBonuses).toEqual({ attackSpeed: 0.05, dexterity: 1 });
  });
});
