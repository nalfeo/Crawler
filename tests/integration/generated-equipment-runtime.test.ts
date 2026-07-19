import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  getActiveWeaponSnapshot,
  setActiveWeaponFromGeneratedInstance,
} from '../../src/core/active-weapon.js';
import { Damage, Projectile } from '../../src/core/components.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import {
  grantEquipmentAbilitySources,
  revokeEquipmentAbilitySources,
} from '../../src/game/equipment-ability-grants.js';
import { generateEquipmentInstance } from '../../src/game/generated-equipment-generator.js';
import { getOrCreateAbilityState } from '../../src/game/systems/abilitySystem.js';
import { weaponSystem } from '../../src/game/weaponSystem.js';
import { equipmentAbilityGrantSourceId } from '../../src/shared/abilities.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import {
  GENERATED_ACCESSORY_REQUEST,
  GENERATED_WEAPON_REQUEST,
} from '../fixtures/generated-equipment.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('generated equipment runtime integration', () => {
  it('registers and fires a generated weapon through the real weapon pipeline', () => {
    const world = createTestWorld({
      seed: 42,
      generatedEquipmentRunKey: 'generator-runtime-weapon',
    });
    spawnPlayer(world, 0, 0);
    spawnEnemy(world, 10, 0, 100);
    const staticPistol = getWeaponDef('pistol')!;
    const staticDamage = staticPistol.baseDamage;
    const generated = generateEquipmentInstance(world, GENERATED_WEAPON_REQUEST);

    setActiveWeaponFromGeneratedInstance(world, generated.instanceId);
    world.elapsedMs = 10_000;
    weaponSystem(world);

    const projectile = query(world.ecs, [Projectile, Damage])[0]!;
    expect(world.stores.damage.amount[projectile]).toBe(
      generated.frozen.activeWeaponSnapshot?.baseDamage,
    );
    expect(getActiveWeaponSnapshot(world)).toEqual(generated.frozen.activeWeaponSnapshot);
    expect(getWeaponDef('pistol')).toBe(staticPistol);
    expect(getWeaponDef('pistol')?.baseDamage).toBe(staticDamage);
  });

  it.each([
    {
      seed: 2,
      kind: 'active' as const,
      abilityId: 'fireball',
    },
    {
      seed: 1,
      kind: 'passive' as const,
      abilityId: 'veteran-instinct',
    },
  ])(
    'applies and revokes a generated $kind grant through source ownership',
    ({ seed, kind, abilityId }) => {
      const world = createTestWorld({
        seed,
        generatedEquipmentRunKey: `generator-runtime-${kind}`,
      });
      const player = spawnPlayer(world, 0, 0);
      const generated = generateEquipmentInstance(world, GENERATED_ACCESSORY_REQUEST);
      const effect = generated.resolvedEffects.find(
        (candidate) =>
          'kind' in candidate &&
          (candidate.kind === 'abilityGrant' || candidate.kind === 'passiveGrant'),
      )!;
      if (!('effectOrdinal' in effect)) {
        throw new Error('Expected generated accessory grant effect');
      }
      const sourceId = equipmentAbilityGrantSourceId(generated.instanceId, effect.effectOrdinal);

      grantEquipmentAbilitySources(world, player, generated.instanceId);
      const granted = getOrCreateAbilityState(world, player);
      const sources =
        kind === 'active'
          ? granted.grantOwnership.activeSourcesByAbilityId
          : granted.grantOwnership.passiveSourcesByAbilityId;
      expect(sources.get(abilityId)).toEqual(new Set([sourceId]));

      revokeEquipmentAbilitySources(world, player, generated.instanceId);
      const revoked = getOrCreateAbilityState(world, player);
      const revokedSources =
        kind === 'active'
          ? revoked.grantOwnership.activeSourcesByAbilityId
          : revoked.grantOwnership.passiveSourcesByAbilityId;
      expect(revokedSources.has(abilityId)).toBe(false);
    },
  );
});
