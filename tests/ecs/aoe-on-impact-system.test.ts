import { query, removeEntity } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { AreaDamage } from '../../src/core/components.js';
import { spawnAoeProjectile, spawnPlayer } from '../../src/core/helpers.js';
import {
  aoeOnImpactPostDamage,
  aoeOnImpactPreDamage,
} from '../../src/core/systems/aoeOnImpactSystem.js';
import { TeamId } from '../../src/shared/constants.js';
import { makeMapWithSafeRoom } from '../helpers/map-fixtures.js';
import { createTestWorld } from '../helpers/world-factory.js';

const SAFE_FT = { x: 3 * 32 + 16, y: 3 * 32 + 16 };

function countAreaAttacks(world: ReturnType<typeof createTestWorld>): number {
  return Array.from(query(world.ecs, [AreaDamage])).length;
}

describe('aoeOnImpactSystem', () => {
  it('spawns an area attack when a destroyed AoE projectile had a radius', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 200, 200);
    const proj = spawnAoeProjectile(world, 100, 100, 1, 0, 10, 30, 20, player, TeamId.PLAYER);

    aoeOnImpactPreDamage(world);
    // Simulate the projectile being destroyed by damageSystem.
    removeEntity(world.ecs, proj);
    aoeOnImpactPostDamage(world);

    expect(countAreaAttacks(world)).toBe(1);
  });

  it('does not spawn an explosion while the projectile is still alive', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 200, 200);
    spawnAoeProjectile(world, 100, 100, 1, 0, 10, 30, 20, player, TeamId.PLAYER);

    aoeOnImpactPreDamage(world);
    aoeOnImpactPostDamage(world);

    expect(countAreaAttacks(world)).toBe(0);
  });

  it('suppresses the explosion when the owner is inside a safe room', () => {
    const world = createTestWorld();
    world.floorMap = makeMapWithSafeRoom();
    const player = spawnPlayer(world, SAFE_FT.x, SAFE_FT.y);
    const proj = spawnAoeProjectile(
      world,
      SAFE_FT.x,
      SAFE_FT.y,
      1,
      0,
      10,
      30,
      20,
      player,
      TeamId.PLAYER,
    );

    aoeOnImpactPreDamage(world);
    removeEntity(world.ecs, proj);
    aoeOnImpactPostDamage(world);

    expect(countAreaAttacks(world)).toBe(0);
  });

  it('is a no-op when there are no AoE projectiles', () => {
    const world = createTestWorld();
    aoeOnImpactPreDamage(world);
    expect(() => aoeOnImpactPostDamage(world)).not.toThrow();
    expect(countAreaAttacks(world)).toBe(0);
  });

  it('propagates source skill IDs to the spawned explosion AreaDamage entity', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 200, 200);
    const proj = spawnAoeProjectile(world, 100, 100, 1, 0, 10, 30, 20, player, TeamId.PLAYER);

    const skillIds = { classSkillId: 'blade', typeSkillId: 'sword' };
    world.attackWeaponSkillsByEntity.set(proj, skillIds);

    aoeOnImpactPreDamage(world);
    removeEntity(world.ecs, proj);
    aoeOnImpactPostDamage(world);

    const explosions = Array.from(query(world.ecs, [AreaDamage]));
    expect(explosions).toHaveLength(1);
    const explosionEid = explosions[0];
    expect(world.attackWeaponSkillsByEntity.get(explosionEid)).toEqual(skillIds);
  });
});
