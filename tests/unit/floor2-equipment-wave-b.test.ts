import { describe, expect, it } from 'vitest';
import {
  getGeneratedEquipmentBaseV1,
  generateEquipmentInstance,
} from '../../src/game/generated-equipment-generator.js';
import { SLOT_REGISTRY } from '../../src/shared/equipment-slots.js';
import { getEquipmentDefForItem, getEquippableItemIds } from '../../src/shared/equipmentDefs.js';
import {
  FLOOR2_EQUIPMENT_WAVE_B_NON_WEAPON_DEFS,
  FLOOR2_EQUIPMENT_WAVE_B_NON_WEAPON_IDS,
  FLOOR2_EQUIPMENT_WAVE_B_STABLE_IDS,
  FLOOR2_EQUIPMENT_WAVE_B_WEAPON_DEFS,
  FLOOR2_EQUIPMENT_WAVE_B_WEAPON_EQUIPMENT_DEFS,
  FLOOR2_EQUIPMENT_WAVE_B_WEAPON_IDS,
} from '../../src/shared/data/floor2-equipment-wave-b.js';
import { FLOOR2_EQUIPMENT_ART_DEFINITIONS } from '../../src/shared/data/floor2-equipment-art.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { createTestWorld } from '../helpers/world-factory.js';

const LEGAL_RARITIES = ['common', 'uncommon', 'rare'] as const;
const COORDINATED_WAVE_A_WEAPON_IDS = [
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

describe('Floor 2 equipment Wave B', () => {
  it('complements the coordinated Wave A roster in deterministic manifest order', () => {
    expect(FLOOR2_EQUIPMENT_ART_DEFINITIONS).toHaveLength(70);
    expect(FLOOR2_EQUIPMENT_WAVE_B_WEAPON_IDS).toHaveLength(25);
    expect(FLOOR2_EQUIPMENT_WAVE_B_NON_WEAPON_IDS).toHaveLength(20);
    const manifestWeaponIds = FLOOR2_EQUIPMENT_ART_DEFINITIONS.filter(
      (entry) => entry.category === 'weapon',
    ).map((entry) => entry.stableId);
    const waveAIds = new Set<string>(COORDINATED_WAVE_A_WEAPON_IDS);
    expect(FLOOR2_EQUIPMENT_WAVE_B_WEAPON_IDS).toEqual(
      manifestWeaponIds.filter((stableId) => !waveAIds.has(stableId)),
    );
    expect(FLOOR2_EQUIPMENT_WAVE_B_NON_WEAPON_IDS).toEqual(
      FLOOR2_EQUIPMENT_ART_DEFINITIONS.filter((entry) => entry.category !== 'weapon').map(
        (entry) => entry.stableId,
      ),
    );
    expect(FLOOR2_EQUIPMENT_WAVE_B_WEAPON_IDS.filter((stableId) => waveAIds.has(stableId))).toEqual(
      [],
    );
    expect(
      new Set([...COORDINATED_WAVE_A_WEAPON_IDS, ...FLOOR2_EQUIPMENT_WAVE_B_WEAPON_IDS]),
    ).toEqual(new Set(manifestWeaponIds));
    expect(FLOOR2_EQUIPMENT_WAVE_B_WEAPON_DEFS.map((def) => def.id)).toEqual(
      FLOOR2_EQUIPMENT_WAVE_B_WEAPON_IDS,
    );
    expect(FLOOR2_EQUIPMENT_WAVE_B_NON_WEAPON_DEFS.map((def) => def.id)).toEqual(
      FLOOR2_EQUIPMENT_WAVE_B_NON_WEAPON_IDS,
    );
    expect(new Set(FLOOR2_EQUIPMENT_WAVE_B_STABLE_IDS).size).toBe(45);
    expect(getEquippableItemIds().length).toBeGreaterThanOrEqual(70);
  });

  it('covers every weapon family and every canonical paper-doll slot', () => {
    const manifestById = new Map<string, (typeof FLOOR2_EQUIPMENT_ART_DEFINITIONS)[number]>(
      FLOOR2_EQUIPMENT_ART_DEFINITIONS.map((entry) => [entry.stableId, entry]),
    );
    const families = new Set(
      FLOOR2_EQUIPMENT_WAVE_B_WEAPON_EQUIPMENT_DEFS.map((def) => manifestById.get(def.id)?.family),
    );
    expect(families).toEqual(
      new Set([
        'blade',
        'axe',
        'bludgeon',
        'polearm',
        'bow',
        'firearm',
        'thrown',
        'magic-focus',
        'beam',
        'trap',
      ]),
    );

    const coveredSlots = new Set(
      FLOOR2_EQUIPMENT_WAVE_B_NON_WEAPON_DEFS.flatMap((def) => def.slots),
    );
    expect(coveredSlots).toEqual(new Set(SLOT_REGISTRY.map((slot) => slot.id)));
    expect(getEquipmentDefForItem('accessory.warding-bell')?.slots).toEqual(['offHand']);
    expect(getEquipmentDefForItem('accessory.surveyor-map')?.slots).toEqual(['mainHand']);
  });

  it('uses only legal rarities and stable manifest runtime art keys', () => {
    const manifestById = new Map<string, (typeof FLOOR2_EQUIPMENT_ART_DEFINITIONS)[number]>(
      FLOOR2_EQUIPMENT_ART_DEFINITIONS.map((entry) => [entry.stableId, entry]),
    );
    const definitions = [
      ...FLOOR2_EQUIPMENT_WAVE_B_WEAPON_EQUIPMENT_DEFS,
      ...FLOOR2_EQUIPMENT_WAVE_B_NON_WEAPON_DEFS,
    ];

    for (const definition of definitions) {
      expect(LEGAL_RARITIES).toContain(definition.rarity);
      expect(definition.artKey).toBe(manifestById.get(definition.id)?.runtimeKey);
      expect(definition.artKey).not.toContain('placeholder');
    }
    expect(new Set(FLOOR2_EQUIPMENT_WAVE_B_WEAPON_EQUIPMENT_DEFS.map((def) => def.rarity))).toEqual(
      new Set(LEGAL_RARITIES),
    );
    expect(new Set(FLOOR2_EQUIPMENT_WAVE_B_NON_WEAPON_DEFS.map((def) => def.rarity))).toEqual(
      new Set(LEGAL_RARITIES),
    );
  });

  it('registers and generates every Wave B base across legal rarity budgets', () => {
    for (const [index, stableId] of FLOOR2_EQUIPMENT_WAVE_B_STABLE_IDS.entries()) {
      const equipmentDef = getEquipmentDefForItem(stableId);
      expect(equipmentDef, stableId).toBeDefined();
      const base = getGeneratedEquipmentBaseV1(stableId);
      expect(base.baseId).toBe(stableId);
      expect(base.artKey).toBe(equipmentDef?.artKey);

      if (stableId.startsWith('weapon.')) {
        expect(getWeaponDef(stableId), stableId).toBeDefined();
        expect(base.template).toEqual({ kind: 'weapon', weaponDefId: stableId });
      } else {
        expect(base.template).toEqual({ kind: 'equipment', equipmentDefId: stableId });
      }

      for (const rarity of LEGAL_RARITIES) {
        const world = createTestWorld({
          seed: 42 + index,
          generatedEquipmentRunKey: `wave-b-${index}-${rarity}`,
        });
        const generated = generateEquipmentInstance(world, {
          baseId: stableId,
          itemLevel: 6,
          rarity,
          enhancementLevel: 0,
        });
        expect(generated.baseId).toBe(stableId);
        expect(generated.rarity).toBe(rarity);
        expect(generated.frozen.artKey).toBe(equipmentDef?.artKey);
      }
    }
  });
});
