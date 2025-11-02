import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { setActiveWeaponDef } from '../../src/core/active-weapon.js';
import { Damage, Projectile } from '../../src/core/components.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import {
  grantEquipmentAbilitySources,
  revokeEquipmentAbilitySources,
} from '../../src/game/equipment-ability-grants.js';
import { generateEquipmentInstance } from '../../src/game/generated-equipment-generator.js';
import { getOrCreateAbilityState } from '../../src/game/systems/abilitySystem.js';
import { weaponSystem } from '../../src/game/weaponSystem.js';
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

    // Use the snapshot as the active weapon def (it extends WeaponDef)
    setActiveWeaponDef(world, generated.frozen.activeWeaponSnapshot!);
    world.elapsedMs = 10_000;
    weaponSystem(world);

    const projectile = query(world.ecs, [Projectile, Damage])[0]!;
    expect(world.stores.damage.amount[projectile]).toBe(
      generated.frozen.activeWeaponSnapshot?.baseDamage,
    );
    // Static weapon def remains unchanged — no mutation
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
    'applies and revokes a generated $kind grant through source tracking',
    ({ seed, kind, abilityId }) => {
      const world = createTestWorld({
        seed,
        generatedEquipmentRunKey: `generator-runtime-${kind}`,
      });
      const player = spawnPlayer(world, 0, 0);
      const generated = generateEquipmentInstance(world, GENERATED_ACCESSORY_REQUEST);

      grantEquipmentAbilitySources(world, player, generated.instanceId);
      const granted = getOrCreateAbilityState(world, player);
      if (kind === 'active') {
        expect(granted.equippedActiveAbilityIds).toContain(abilityId);
        const sources = granted.activeAbilityGrantSources.get(abilityId);
        expect(
          sources?.some(
            (s) => s.kind === 'generated-equipment' && s.instanceId === generated.instanceId,
          ),
        ).toBe(true);
      } else {
        expect(granted.passiveAbilityIds).toContain(abilityId);
        const sources = granted.passiveAbilityGrantSources.get(abilityId);
        expect(
          sources?.some(
            (s) => s.kind === 'generated-equipment' && s.instanceId === generated.instanceId,
          ),
        ).toBe(true);
      }

      revokeEquipmentAbilitySources(world, player, generated.instanceId);
      const revoked = getOrCreateAbilityState(world, player);
      if (kind === 'active') {
        expect(revoked.equippedActiveAbilityIds).not.toContain(abilityId);
      } else {
        expect(revoked.passiveAbilityIds).not.toContain(abilityId);
      }
    },
  );
});
