import { describe, expect, it } from 'vitest';
import { listGeneratedEquipmentInstances } from '../../src/core/generated-equipment-registry.js';
import {
  _GeneratedEquipmentGeneratorError as GeneratedEquipmentGeneratorError,
  generateEquipmentInstance,
  _getGeneratedEquipmentBaseV1 as getGeneratedEquipmentBaseV1,
} from '../../src/game/generated-equipment-generator.js';
import { canonicalJson } from '../../src/shared/canonical-json.js';
import { getEquipmentDefForItem } from '../../src/shared/equipmentDefs.js';
import { SeededRandom } from '../../src/shared/random.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import {
  GENERATED_ACCESSORY_REQUEST,
  GENERATED_ARMOR_REQUEST,
  GENERATED_WEAPON_REQUEST,
} from '../fixtures/generated-equipment.js';
import { createTestWorld } from '../helpers/world-factory.js';

function expectGeneratorError(
  action: () => unknown,
  code: GeneratedEquipmentGeneratorError['code'],
): void {
  expect(action).toThrowError(
    expect.objectContaining<Partial<GeneratedEquipmentGeneratorError>>({
      name: 'GeneratedEquipmentGeneratorError',
      code,
    }),
  );
}

function nextAfterDraws(seed: number, draws: number): number {
  const rng = new SeededRandom(seed);
  for (let draw = 0; draw < draws; draw += 1) rng.next();
  return rng.next();
}

describe('deterministic generated equipment', () => {
  it('normalizes canonical weapon and equipment definitions without creating a second registry', () => {
    const weapon = getGeneratedEquipmentBaseV1('plasma-pistol');
    const armor = getGeneratedEquipmentBaseV1('iron-breastplate');

    expect(weapon).toEqual({
      schemaVersion: 'floor2-equipment-base/v1',
      baseId: 'plasma-pistol',
      template: { kind: 'weapon', weaponDefId: 'pistol' },
      displayName: 'Pistol',
      artKey: 'plasma-pistol',
      slots: ['mainHand'],
      tags: ['weapon'],
      weightLb: 2,
    });
    expect(armor.template).toEqual({
      kind: 'equipment',
      equipmentDefId: 'iron-breastplate',
    });
    expect(armor.artKey).toBe('iron-breastplate');
    expect(Object.isFrozen(weapon)).toBe(true);
    expect(Object.isFrozen(weapon.slots)).toBe(true);
  });

  it('resolves level, rarity, and enhancement before one final weapon-damage normalization', () => {
    const world = createTestWorld({
      seed: 42,
      generatedEquipmentRunKey: 'generator-weapon',
    });
    const staticWeapon = getWeaponDef('pistol')!;
    const expectedDamage = Math.floor(staticWeapon.baseDamage * 1.2 * 1.1 * 1.1 + 0.5);

    const instance = generateEquipmentInstance(world, GENERATED_WEAPON_REQUEST);

    expect(instance.itemLevel).toBe(3);
    expect(instance.rarity).toBe('rare');
    expect(instance.enhancementLevel).toBe(2);
    expect(instance.frozen.activeWeaponSnapshot?.baseDamage).toBe(expectedDamage);
    expect(instance.frozen.activeWeaponSnapshot?.sourceWeaponDefId).toBe('pistol');
    expect(instance.frozen.activeWeaponSnapshot?.name).toBe(staticWeapon.name);
    expect(instance.frozen.displayName).toMatch(/Pistol \+2$/);
    expect(instance.frozen.artKey).toBe('plasma-pistol');
    expect(
      instance.resolvedEffects.reduce(
        (sum, effect) => sum + ('unitCost' in effect ? effect.unitCost : 0),
        0,
      ),
    ).toBe(2);
    expect(instance.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.isFrozen(instance)).toBe(true);
    expect(Object.isFrozen(instance.frozen.activeWeaponSnapshot)).toBe(true);
  });

  it('applies armor affixes before the single final armor normalization', () => {
    const world = createTestWorld({
      seed: 42,
      generatedEquipmentRunKey: 'generator-armor',
    });
    const staticArmor = getEquipmentDefForItem('iron-breastplate')!;
    const affixArmor = generateEquipmentInstance(world, GENERATED_ARMOR_REQUEST);
    const effectArmor = affixArmor.resolvedEffects.reduce(
      (sum, effect) =>
        'kind' in effect && effect.kind === 'stat' && effect.stat === 'armor'
          ? sum + effect.value
          : sum,
      0,
    );
    const expectedArmor = Math.floor(
      (staticArmor.statBonuses.armor ?? 0) * 1.3 * 1.1 * 1.15 + effectArmor + 0.5,
    );
    const effectConstitution = affixArmor.resolvedEffects.reduce(
      (sum, effect) =>
        'kind' in effect && effect.kind === 'stat' && effect.stat === 'constitution'
          ? sum + effect.value
          : sum,
      0,
    );

    expect(affixArmor.frozen.statBonuses.armor).toBe(expectedArmor);
    expect(affixArmor.frozen.statBonuses.constitution ?? 0).toBe(effectConstitution);
    expect(affixArmor.frozen.activeWeaponSnapshot).toBeNull();
    expect(affixArmor.frozen.displayName).toMatch(/Iron Breastplate \+3$/);
    expect(
      affixArmor.resolvedEffects.reduce(
        (sum, effect) => sum + ('unitCost' in effect ? effect.unitCost : 0),
        0,
      ),
    ).toBe(2);
  });

  it('mirrors generated active and passive grant effects into frozen grant fields', () => {
    const activeWorld = createTestWorld({
      seed: 2,
      generatedEquipmentRunKey: 'generator-active-grant',
    });
    const passiveWorld = createTestWorld({
      seed: 1,
      generatedEquipmentRunKey: 'generator-passive-grant',
    });

    const active = generateEquipmentInstance(activeWorld, GENERATED_ACCESSORY_REQUEST);
    const passive = generateEquipmentInstance(passiveWorld, GENERATED_ACCESSORY_REQUEST);

    expect(active.resolvedEffects).toEqual([
      expect.objectContaining({ kind: 'abilityGrant', grantId: 'fireball', effectOrdinal: 0 }),
    ]);
    expect(active.frozen.abilityGrants).toEqual(['fireball']);
    expect(active.frozen.passiveGrants).toEqual([]);
    expect(active.frozen.statBonuses).toEqual({});
    expect(passive.resolvedEffects).toEqual([
      expect.objectContaining({
        kind: 'passiveGrant',
        grantId: 'veteran-instinct',
        effectOrdinal: 0,
      }),
    ]);
    expect(passive.frozen.abilityGrants).toEqual([]);
    expect(passive.frozen.passiveGrants).toEqual(['veteran-instinct']);
    expect(passive.frozen.statBonuses).toEqual({});
  });

  it('uses stable bounded draw counts for each exact rarity budget', () => {
    const common = createTestWorld({ seed: 42, generatedEquipmentRunKey: 'draw-common' });
    const uncommon = createTestWorld({
      seed: 42,
      generatedEquipmentRunKey: 'draw-uncommon',
    });
    const rare = createTestWorld({ seed: 42, generatedEquipmentRunKey: 'draw-rare' });
    const rareAccessory = createTestWorld({
      seed: 42,
      generatedEquipmentRunKey: 'draw-rare-accessory',
    });

    generateEquipmentInstance(common, { ...GENERATED_WEAPON_REQUEST, rarity: 'common' });
    generateEquipmentInstance(uncommon, { ...GENERATED_WEAPON_REQUEST, rarity: 'uncommon' });
    generateEquipmentInstance(rare, GENERATED_WEAPON_REQUEST);
    generateEquipmentInstance(rareAccessory, GENERATED_ACCESSORY_REQUEST);

    expect(common.rng.next()).toBe(nextAfterDraws(42, 0));
    expect(uncommon.rng.next()).toBe(nextAfterDraws(42, 1));
    expect(rare.rng.next()).toBe(nextAfterDraws(42, 2));
    expect(rareAccessory.rng.next()).toBe(nextAfterDraws(42, 2));
  });

  it('fails before allocation or random draws for invalid requests', () => {
    const unconfigured = createTestWorld({ seed: 42, generatedEquipmentRunKey: null });
    const configured = createTestWorld({
      seed: 42,
      generatedEquipmentRunKey: 'generator-errors',
    });

    expectGeneratorError(
      () => generateEquipmentInstance(unconfigured, GENERATED_WEAPON_REQUEST),
      'registry-unconfigured',
    );
    expectGeneratorError(
      () =>
        generateEquipmentInstance(configured, {
          ...GENERATED_ACCESSORY_REQUEST,
          enhancementLevel: 1,
        }),
      'illegal-enhancement',
    );
    expectGeneratorError(
      () =>
        generateEquipmentInstance(configured, {
          ...GENERATED_WEAPON_REQUEST,
          baseId: 'missing-base',
        }),
      'unknown-base',
    );
    expectGeneratorError(
      () =>
        generateEquipmentInstance(configured, {
          ...GENERATED_WEAPON_REQUEST,
          enhancementLevel: 6 as never,
        }),
      'invalid-request',
    );
    expect(listGeneratedEquipmentInstances(configured)).toEqual([]);
    expect(configured.rng.next()).toBe(nextAfterDraws(42, 0));
  });

  it('does not mutate or freeze canonical static definitions', () => {
    const world = createTestWorld({
      seed: 42,
      generatedEquipmentRunKey: 'generator-static-defs',
    });
    const weaponEquipmentDef = getEquipmentDefForItem('plasma-pistol')!;
    const armorEquipmentDef = getEquipmentDefForItem('iron-breastplate')!;
    const accessoryEquipmentDef = getEquipmentDefForItem('band-of-fortune')!;
    const weaponDef = getWeaponDef('pistol')!;
    const weaponEquipmentBefore = canonicalJson(weaponEquipmentDef);
    const armorEquipmentBefore = canonicalJson(armorEquipmentDef);
    const accessoryEquipmentBefore = canonicalJson(accessoryEquipmentDef);
    const weaponBefore = canonicalJson(weaponDef);
    const weaponEquipmentFrozenBefore = Object.isFrozen(weaponEquipmentDef);
    const armorEquipmentFrozenBefore = Object.isFrozen(armorEquipmentDef);
    const accessoryEquipmentFrozenBefore = Object.isFrozen(accessoryEquipmentDef);
    const weaponFrozenBefore = Object.isFrozen(weaponDef);

    generateEquipmentInstance(world, GENERATED_WEAPON_REQUEST);
    generateEquipmentInstance(world, GENERATED_ARMOR_REQUEST);
    generateEquipmentInstance(world, GENERATED_ACCESSORY_REQUEST);

    expect(canonicalJson(weaponEquipmentDef)).toBe(weaponEquipmentBefore);
    expect(canonicalJson(armorEquipmentDef)).toBe(armorEquipmentBefore);
    expect(canonicalJson(accessoryEquipmentDef)).toBe(accessoryEquipmentBefore);
    expect(canonicalJson(weaponDef)).toBe(weaponBefore);
    expect(Object.isFrozen(weaponEquipmentDef)).toBe(weaponEquipmentFrozenBefore);
    expect(Object.isFrozen(armorEquipmentDef)).toBe(armorEquipmentFrozenBefore);
    expect(Object.isFrozen(accessoryEquipmentDef)).toBe(accessoryEquipmentFrozenBefore);
    expect(Object.isFrozen(weaponDef)).toBe(weaponFrozenBefore);
  });
});

describe('createActiveWeaponSnapshotInput registry boundary', () => {
  it('resolves a deferred snapshot through createGeneratedEquipmentInstance into a full frozen snapshot', () => {
    const world = createTestWorld({
      seed: 42,
      generatedEquipmentRunKey: 'deferred-snapshot-create',
    });
    const instance = generateEquipmentInstance(world, GENERATED_WEAPON_REQUEST);
    // The registry must expand the deferred stub into a full ActiveWeaponSnapshotV1 before persisting
    expect(instance.frozen.activeWeaponSnapshot).not.toBeNull();
    const snapshot = instance.frozen.activeWeaponSnapshot!;
    expect(snapshot).toHaveProperty('schemaVersion', 'active-weapon-snapshot/v1');
    expect(snapshot).toHaveProperty('sourceWeaponDefId', 'pistol');
    expect(snapshot).toHaveProperty('generatedEquipmentInstanceId', instance.instanceId);
    // Must not carry the stub shape (weaponDefId on a plain object) — it's a full WeaponDef extension
    expect(snapshot).not.toHaveProperty('weaponDefId');
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});
