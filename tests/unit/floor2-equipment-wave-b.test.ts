import { describe, expect, it } from 'vitest';
import {
  getGeneratedEquipmentBaseV1,
  generateEquipmentInstance,
} from '../../src/game/generated-equipment-generator.js';
import { WeaponType } from '../../src/shared/constants.js';
import { SLOT_REGISTRY } from '../../src/shared/equipment-slots.js';
import {
  FLOOR2_QUARTERMASTER_GENERATED_BASE_IDS,
  getEquipmentDefForItem,
  getEquippableItemIds,
} from '../../src/shared/equipmentDefs.js';
import {
  FLOOR2_EQUIPMENT_WAVE_B_NON_WEAPON_DEFS,
  FLOOR2_EQUIPMENT_WAVE_B_NON_WEAPON_IDS,
  FLOOR2_EQUIPMENT_WAVE_B_STABLE_IDS,
  FLOOR2_EQUIPMENT_WAVE_B_WEAPON_DEFS,
  FLOOR2_EQUIPMENT_WAVE_B_WEAPON_EQUIPMENT_DEFS,
  FLOOR2_EQUIPMENT_WAVE_B_WEAPON_IDS,
} from '../../src/shared/data/floor2-equipment-wave-b.js';
import { FLOOR2_EQUIPMENT_ART_DEFINITIONS } from '../../src/shared/data/floor2-equipment-art.js';
import * as floor2EquipmentArtModule from '../../src/shared/data/floor2-equipment-art.js';
import * as floor2EquipmentWaveBModule from '../../src/shared/data/floor2-equipment-wave-b.js';
import { FLOOR2_WEAPON_WAVE_A_BASE_IDS } from '../../src/shared/data/floor2-weapon-bases.js';
import { FLOOR2_BASIC_LEATHER_STABLE_IDS } from '../../src/shared/data/floor2-basic-leather-bases.js';
import { createWeaponDef, WEAPON_DEF_DEFAULTS } from '../../src/shared/weapon-def-defaults.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { createTestWorld } from '../helpers/world-factory.js';

const LEGAL_RARITIES = ['common', 'uncommon', 'rare'] as const;

describe('Floor 2 equipment Wave B', () => {
  it('complements the coordinated Wave A roster in deterministic manifest order', () => {
    // The full art manifest now also carries the 18 Classic Fantasy [Basic
    // Leather] entries (see floor2-basic-leather-bases.ts / floor2-reward-pool.ts)
    // alongside Wave A (25) + Wave B (45) = 70, for 88 total. This test's
    // invariant is scoped to "Wave A + Wave B fully account for the
    // non-Basic-Leather manifest entries" — Basic Leather coverage is
    // asserted separately (see floor2-reward-pool.test.ts).
    expect(FLOOR2_EQUIPMENT_ART_DEFINITIONS).toHaveLength(88);
    const basicLeatherIds = new Set<string>(FLOOR2_BASIC_LEATHER_STABLE_IDS);
    const waveAAndBManifest = FLOOR2_EQUIPMENT_ART_DEFINITIONS.filter(
      (entry) => !basicLeatherIds.has(entry.stableId),
    );
    expect(waveAAndBManifest).toHaveLength(70);
    expect(FLOOR2_EQUIPMENT_WAVE_B_WEAPON_IDS).toHaveLength(25);
    expect(FLOOR2_EQUIPMENT_WAVE_B_NON_WEAPON_IDS).toHaveLength(20);
    const manifestWeaponIds = waveAAndBManifest
      .filter((entry) => entry.category === 'weapon')
      .map((entry) => entry.stableId);
    const waveAIds = new Set<string>(FLOOR2_WEAPON_WAVE_A_BASE_IDS);
    expect(FLOOR2_EQUIPMENT_WAVE_B_WEAPON_IDS).toEqual(
      manifestWeaponIds.filter((stableId) => !waveAIds.has(stableId)),
    );
    expect(FLOOR2_EQUIPMENT_WAVE_B_NON_WEAPON_IDS).toEqual(
      waveAAndBManifest
        .filter((entry) => entry.category !== 'weapon')
        .map((entry) => entry.stableId),
    );
    expect(FLOOR2_EQUIPMENT_WAVE_B_WEAPON_IDS.filter((stableId) => waveAIds.has(stableId))).toEqual(
      [],
    );
    expect(
      new Set([...FLOOR2_WEAPON_WAVE_A_BASE_IDS, ...FLOOR2_EQUIPMENT_WAVE_B_WEAPON_IDS]),
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

  it('inherits the frozen shared weapon defaults while preserving explicit overrides', () => {
    expect(Object.isFrozen(WEAPON_DEF_DEFAULTS)).toBe(true);
    expect(Object.keys(WEAPON_DEF_DEFAULTS)).toHaveLength(20);

    const explicit = createWeaponDef({
      id: 'shared-default-regression',
      name: 'Shared Default Regression',
      weaponType: WeaponType.MELEE,
      baseDamage: 1,
      cooldownMs: 2,
      range: 3,
      baseAccuracy: 0.99,
      weaponClassSkillId: 'slashing',
      weaponTypeSkillId: 'sword',
    });
    expect(explicit).toEqual({
      ...WEAPON_DEF_DEFAULTS,
      id: 'shared-default-regression',
      name: 'Shared Default Regression',
      weaponType: WeaponType.MELEE,
      baseDamage: 1,
      cooldownMs: 2,
      range: 3,
      baseAccuracy: 0.99,
      weaponClassSkillId: 'slashing',
      weaponTypeSkillId: 'sword',
    });

    expect(FLOOR2_EQUIPMENT_WAVE_B_WEAPON_DEFS[0]).toMatchObject({
      id: 'weapon.venom-dirk',
      bounceCount: WEAPON_DEF_DEFAULTS.bounceCount,
      trapArmMs: WEAPON_DEF_DEFAULTS.trapArmMs,
      range: 5,
      baseAccuracy: 0.88,
    });
  });

  it('keeps all quartermaster generated-base display names unique', () => {
    const displayNames = FLOOR2_QUARTERMASTER_GENERATED_BASE_IDS.map((stableId) => {
      const definition = getEquipmentDefForItem(stableId);
      expect(definition, stableId).toBeDefined();
      return definition?.name;
    });
    expect(new Set(displayNames).size).toBe(displayNames.length);
    expect(getEquipmentDefForItem('head.iron-visor')?.name).toBe('Iron Faceplate');
    expect(getEquipmentDefForItem('feet.iron-greaves')?.name).toBe('Iron Legguards');
    expect(getEquipmentDefForItem('iron-visor')?.name).toBe('Iron Visor');
    expect(getEquipmentDefForItem('iron-greaves')?.name).toBe('Iron Greaves');
  });

  it('keeps the Wave B display-name override table private and runtime-local', () => {
    // Regression guard: the override table must stay a module-private const
    // inside floor2-equipment-wave-b.ts. It must never be exported from this
    // module, and floor2-equipment-art.ts (the canonical art-manifest module)
    // must never define, re-export, or otherwise expose it either.
    expect(Object.keys(floor2EquipmentWaveBModule)).not.toContain('WAVE_B_DISPLAY_NAME_OVERRIDES');
    expect(Object.keys(floor2EquipmentWaveBModule)).not.toContain(
      'FLOOR2_WAVE_B_DISPLAY_NAME_OVERRIDES',
    );
    expect(Object.keys(floor2EquipmentArtModule)).not.toContain(
      'FLOOR2_WAVE_B_DISPLAY_NAME_OVERRIDES',
    );
    expect(Object.keys(floor2EquipmentArtModule)).not.toContain('WAVE_B_DISPLAY_NAME_OVERRIDES');
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
