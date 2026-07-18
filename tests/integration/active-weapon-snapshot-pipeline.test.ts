import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { AoeOnImpact, Projectile } from '../../src/core/components.js';
import {
  createActiveWeaponSnapshotV1,
  createGeneratedEquipmentInstance,
  generatedEquipmentInstanceKey,
} from '../../src/core/generated-equipment-registry.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { setActiveWeapon, weaponSystem } from '../../src/game/weaponSystem.js';
import {
  FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
  GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
  type ActiveWeaponSnapshotV1,
  type GeneratedEquipmentCreateInputV1,
} from '../../src/shared/generated-equipment-types.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { createTestWorld } from '../helpers/world-factory.js';

function createInput(snapshot: ActiveWeaponSnapshotV1): GeneratedEquipmentCreateInputV1 {
  return {
    baseId: 'weapon.fireball-test',
    itemLevel: 6,
    rarity: 'uncommon',
    enhancementLevel: 0,
    resolvedEffects: [
      {
        schemaVersion: GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
        effectId: 'sturdy',
        effectOrdinal: 0,
        unitCost: 1,
        kind: 'stat',
        stat: 'armor',
        operation: 'add',
        value: 2,
      },
    ],
    frozen: {
      schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
      displayName: snapshot.name,
      artKey: 'weapon.fireball-test',
      slots: ['mainHand'],
      tags: ['weapon', 'magic'],
      weightLb: 2,
      statBonuses: {},
      abilityGrants: [],
      passiveGrants: [],
      activeWeaponSnapshot: snapshot,
    },
  };
}

describe('active weapon snapshot pipeline', () => {
  it('treats same-base snapshot replacements as real switches and fires with snapshot stats', () => {
    const fireball = getWeaponDef('fireball');
    if (!fireball) throw new Error('Expected fireball weapon definition');

    const world = createTestWorld({ generatedEquipmentRunKey: 'run-pipeline-snapshots' });
    spawnPlayer(world, 0, 0);
    spawnEnemy(world, 12.5, 0, 50);

    const firstSnapshot = createActiveWeaponSnapshotV1(
      { instanceId: generatedEquipmentInstanceKey('run-pipeline-snapshots', 0) },
      fireball,
      { name: 'Ashen Fireball', baseDamage: fireball.baseDamage + 5, cooldownMs: 400 },
    );
    const secondSnapshot = createActiveWeaponSnapshotV1(
      { instanceId: generatedEquipmentInstanceKey('run-pipeline-snapshots', 1) },
      fireball,
      { name: 'Storm Fireball', baseDamage: fireball.baseDamage + 12, cooldownMs: 250 },
    );
    createGeneratedEquipmentInstance(world, createInput(firstSnapshot));
    createGeneratedEquipmentInstance(world, createInput(secondSnapshot));

    setActiveWeapon(world, firstSnapshot);
    world.elapsedMs = firstSnapshot.cooldownMs;
    weaponSystem(world);

    setActiveWeapon(world, secondSnapshot);
    weaponSystem(world);

    const projectiles = Array.from(query(world.ecs, [Projectile, AoeOnImpact]));
    expect(projectiles).toHaveLength(2);
    const damages = projectiles.map((eid) => world.stores.aoeOnImpact.damage[eid]);
    expect(damages).toContain(firstSnapshot.baseDamage);
    expect(damages).toContain(secondSnapshot.baseDamage);
  });
});
