import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  getActiveWeaponDef,
  getActiveWeaponGeneration,
  getActiveWeaponSnapshot,
  setActiveWeaponFromGeneratedInstance,
} from '../../src/core/active-weapon.js';
import { Damage, Projectile } from '../../src/core/components.js';
import {
  createActiveWeaponSnapshotInput,
  createGeneratedEquipmentInstance,
} from '../../src/core/generated-equipment-registry.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { weaponSystem } from '../../src/game/weaponSystem.js';
import {
  FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
  type ActiveWeaponCombatOverridesV1,
  type GeneratedEquipmentCreateInputV1,
} from '../../src/shared/generated-equipment-types.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { createTestWorld } from '../helpers/world-factory.js';

function generatedPistolInput(
  displayName: string,
  overrides: ActiveWeaponCombatOverridesV1,
): GeneratedEquipmentCreateInputV1 {
  return {
    baseId: `weapon.${displayName.toLowerCase().replaceAll(' ', '-')}`,
    itemLevel: 1,
    rarity: 'common',
    enhancementLevel: 0,
    resolvedEffects: [],
    frozen: {
      schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
      displayName,
      artKey: 'weapon.generated-pistol',
      slots: ['mainHand'],
      tags: ['weapon'],
      weightLb: 2,
      statBonuses: {},
      abilityGrants: [],
      passiveGrants: [],
      activeWeaponSnapshot: createActiveWeaponSnapshotInput('pistol', overrides),
    },
  };
}

describe('active weapon snapshot runtime pipeline', () => {
  it('fires distinct same-base instances through the real weaponSystem without static drift', () => {
    const world = createTestWorld({ generatedEquipmentRunKey: 'snapshot-runtime' });
    spawnPlayer(world, 0, 0);
    spawnEnemy(world, 10, 0, 100);
    const staticPistol = getWeaponDef('pistol')!;

    const first = createGeneratedEquipmentInstance(
      world,
      generatedPistolInput('Quick Pistol', {
        baseDamage: 17,
        cooldownMs: 500,
        baseAccuracy: 1,
      }),
    );
    const second = createGeneratedEquipmentInstance(
      world,
      generatedPistolInput('Heavy Pistol', {
        baseDamage: 29,
        cooldownMs: 2_000,
        baseAccuracy: 1,
      }),
    );

    world.elapsedMs = 1_000;
    setActiveWeaponFromGeneratedInstance(world, first.instanceId);
    weaponSystem(world);
    const firstProjectile = query(world.ecs, [Projectile, Damage])[0]!;
    expect(world.stores.damage.amount[firstProjectile]).toBe(17);
    expect(world.attackWeaponSkillsByEntity.get(firstProjectile)).toEqual({
      classSkillId: staticPistol.weaponClassSkillId,
      typeSkillId: staticPistol.weaponTypeSkillId,
    });

    world.elapsedMs += 100;
    weaponSystem(world);
    expect(query(world.ecs, [Projectile]).length).toBe(1);

    const generationBeforeSwitch = getActiveWeaponGeneration(world);
    setActiveWeaponFromGeneratedInstance(world, second.instanceId);
    weaponSystem(world);
    const projectiles = Array.from(query(world.ecs, [Projectile, Damage]));
    const secondProjectile = projectiles.find((eid) => eid !== firstProjectile)!;

    expect(projectiles).toHaveLength(2);
    expect(world.stores.damage.amount[secondProjectile]).toBe(29);
    expect(getActiveWeaponGeneration(world)).toBe(generationBeforeSwitch + 1);
    expect(getActiveWeaponDef(world)?.id).toBe(staticPistol.id);
    expect(getActiveWeaponSnapshot(world)?.generatedEquipmentInstanceId).toBe(second.instanceId);
    expect(getWeaponDef('pistol')).toBe(staticPistol);
  });
});
