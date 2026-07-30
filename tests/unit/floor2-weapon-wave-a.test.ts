import { describe, expect, it } from 'vitest';
import { getEquippableItemIds } from '../../src/shared/equipmentDefs.js';
import {
  FLOOR2_WEAPON_WAVE_A_BASES,
  FLOOR2_WEAPON_WAVE_A_BASE_IDS,
  type Floor2WeaponBaseFamily,
} from '../../src/shared/data/floor2-weapon-bases.js';
import { FLOOR2_EQUIPMENT_ART_DEFINITIONS } from '../../src/shared/data/floor2-equipment-art.js';
import { RARITY_EFFECT_BUDGET } from '../../src/shared/generated-equipment-types.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import {
  generateEquipmentInstance,
  getGeneratedEquipmentBaseV1,
} from '../../src/game/generated-equipment-generator.js';
import { createTestWorld } from '../helpers/world-factory.js';
import {
  expectSpawnedAttack,
  spawnGeneratedWeaponFixture,
} from '../helpers/floor2-weapon-wave-a-fixtures.js';

const EXPECTED_BASE_IDS = [
  'weapon.iron-cleaver',
  'weapon.bone-saw',
  'weapon.dueling-saber',
  'weapon.war-pick',
  'weapon.butcher-hook',
  'weapon.rune-axe',
  'weapon.chain-flail',
  'weapon.stone-maul',
  'weapon.sun-hammer',
  'weapon.quarterstaff',
  'weapon.blood-lance',
  'weapon.grave-shovel',
  'weapon.ashwood-bow',
  'weapon.hand-crossbow',
  'weapon.storm-sling',
  'weapon.musketeer-rifle',
  'weapon.cog-pistol',
  'weapon.throwing-knives',
  'weapon.twin-katar',
  'weapon.ember-wand',
  'weapon.frost-crook',
  'weapon.alchemist-sprayer',
  'weapon.thorn-whip',
  'weapon.sawblade-launcher',
  'weapon.oil-lantern',
] as const;

// Wave A's ten canonical families only — Classic Fantasy [Basic Leather]'s
// weapons (family `basic-leather`) live in a separate roster
// (`floor2-basic-leather-bases.ts`) and are asserted elsewhere; intentionally
// `Partial` (not a full `Record<Floor2WeaponBaseFamily, number>`) so adding a
// new non-wave-A family to `Floor2WeaponBaseFamily` never forces this
// wave-A-only fixture to enumerate it.
const EXPECTED_FAMILY_COUNTS: Readonly<Partial<Record<Floor2WeaponBaseFamily, number>>> = {
  blade: 3,
  axe: 3,
  bludgeon: 3,
  polearm: 3,
  bow: 3,
  firearm: 2,
  thrown: 2,
  'magic-focus': 2,
  beam: 2,
  trap: 2,
};

describe('Floor 2 weapon content wave A', () => {
  it('freezes exactly 25 explicit bases across all ten canonical families', () => {
    expect(FLOOR2_WEAPON_WAVE_A_BASE_IDS).toEqual(EXPECTED_BASE_IDS);
    expect(FLOOR2_WEAPON_WAVE_A_BASES).toHaveLength(25);
    expect(Object.isFrozen(FLOOR2_WEAPON_WAVE_A_BASES)).toBe(true);
    expect(
      Object.fromEntries(
        Object.keys(EXPECTED_FAMILY_COUNTS).map((family) => [
          family,
          FLOOR2_WEAPON_WAVE_A_BASES.filter((definition) => definition.family === family).length,
        ]),
      ),
    ).toEqual(EXPECTED_FAMILY_COUNTS);
  });

  it('preserves the full 56-ID manifest with five entries per Wave A/B family', () => {
    // 50 Wave A + Wave B weapon entries (five per canonical family) plus the
    // 6 Classic Fantasy [Basic Leather] weapons (family `basic-leather`,
    // asserted separately in floor2-reward-pool.test.ts) = 56 total.
    const weapons = FLOOR2_EQUIPMENT_ART_DEFINITIONS.filter(
      (definition) => definition.category === 'weapon',
    );
    expect(weapons).toHaveLength(56);
    const waveAAndBWeapons = weapons.filter((definition) => definition.family !== 'basic-leather');
    expect(waveAAndBWeapons).toHaveLength(50);
    for (const family of Object.keys(EXPECTED_FAMILY_COUNTS)) {
      expect(waveAAndBWeapons.filter((definition) => definition.family === family)).toHaveLength(5);
    }
    expect(weapons.filter((definition) => definition.family === 'basic-leather')).toHaveLength(6);
  });

  it('normalizes stable base IDs without leaking generated-only bases into inventory items', () => {
    const inventoryEquipmentIds = new Set(getEquippableItemIds());
    for (const definition of FLOOR2_WEAPON_WAVE_A_BASES) {
      const generatedBase = getGeneratedEquipmentBaseV1(definition.stableId);
      expect(generatedBase).toMatchObject({
        baseId: definition.stableId,
        template: { kind: 'weapon', weaponDefId: definition.weaponDef.id },
        displayName: definition.weaponDef.name,
        artKey: definition.artKey,
        slots: definition.equipmentDef.slots,
        weightLb: definition.equipmentDef.weightLb,
      });
      expect(getWeaponDef(definition.weaponDef.id)).toBe(definition.weaponDef);
      expect(inventoryEquipmentIds.has(definition.stableId)).toBe(false);
      expect(definition.equipmentDef.rarity).toBe('common');
      expect(definition.equipmentDef.statBonuses).toEqual({});
    }

    expect(getGeneratedEquipmentBaseV1('plasma-pistol').artKey).toBe('plasma-pistol');
  });

  it('generates deterministic legal Common, Uncommon, and Rare instances for every base', () => {
    const rarities = ['common', 'uncommon', 'rare'] as const;
    for (const definition of FLOOR2_WEAPON_WAVE_A_BASES) {
      for (const rarity of rarities) {
        const request = {
          baseId: definition.stableId,
          itemLevel: 6,
          rarity,
          enhancementLevel: 1,
        } as const;
        const left = createTestWorld({
          seed: 42,
          generatedEquipmentRunKey: `wave-a-${definition.weaponDef.id}-${rarity}`,
        });
        const right = createTestWorld({
          seed: 42,
          generatedEquipmentRunKey: `wave-a-${definition.weaponDef.id}-${rarity}`,
        });
        const leftInstance = generateEquipmentInstance(left, request);
        const rightInstance = generateEquipmentInstance(right, request);
        const spentUnits = leftInstance.resolvedEffects.reduce(
          (sum, effect) => sum + ('unitCost' in effect ? effect.unitCost : 0),
          0,
        );

        expect(rightInstance).toEqual(leftInstance);
        expect(leftInstance.frozen.artKey).toBe(definition.artKey);
        expect(leftInstance.frozen.activeWeaponSnapshot?.sourceWeaponDefId).toBe(
          definition.weaponDef.id,
        );
        expect(spentUnits).toBe(RARITY_EFFECT_BUDGET[rarity]);
        if (rarity === 'common') {
          expect(leftInstance.resolvedEffects).toHaveLength(0);
          expect(leftInstance.frozen.statBonuses).toEqual({});
        } else if (rarity === 'uncommon') {
          expect(leftInstance.resolvedEffects).toHaveLength(1);
          expect(leftInstance.resolvedEffects[0]).toMatchObject({ kind: 'stat', unitCost: 1 });
        } else {
          expect(leftInstance.resolvedEffects.length).toBeGreaterThanOrEqual(1);
          expect(leftInstance.resolvedEffects.length).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  it('routes every generated snapshot into the intended production attack kind', () => {
    for (const definition of FLOOR2_WEAPON_WAVE_A_BASES) {
      const fixture = spawnGeneratedWeaponFixture(definition);
      expect(fixture.snapshot.sourceWeaponDefId).toBe(definition.weaponDef.id);
      expectSpawnedAttack(fixture.world, fixture.attackKind, fixture.snapshot);
    }
  });
});
