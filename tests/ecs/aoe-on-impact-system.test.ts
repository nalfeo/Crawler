import { addComponent, query, removeEntity } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { AreaDamage, EnemyProjectile } from '../../src/core/components.js';
import { spawnAoeProjectile, spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import {
  aoeOnImpactPostDamage,
  aoeOnImpactPreDamage,
} from '../../src/core/systems/aoeOnImpactSystem.js';
import { areaDamageSystem } from '../../src/core/systems/areaDamageSystem.js';
import { collisionSystem } from '../../src/core/systems/collisionSystem.js';
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
    const explosionEid = explosions[0]!;
    expect(world.attackWeaponSkillsByEntity.get(explosionEid)).toEqual(skillIds);
  });

  it('attributes AoE splash damage to the original shooter archetype after shooter recycling', () => {
    const world = createTestWorld();

    // Spawn the player as the AoE splash target at the origin.
    spawnPlayer(world, 0, 0);

    // Spawn an enemy as the AoE shooter and label it 'fireball-mage'.
    const shooterEid = spawnEnemy(world, 50, 50, 10); // far from player — no contact damage
    world.enemyAppearanceKeys.set(shooterEid, 'fireball-mage');

    // Spawn an enemy AoE projectile adjacent to the player so the explosion
    // splash reaches the player (radius 10 >> 0.5 ft distance).
    const proj = spawnAoeProjectile(world, 0.5, 0, 0, 0, 5, 10, 5, shooterEid, TeamId.ENEMY);
    addComponent(world.ecs, proj, EnemyProjectile);
    expect(world.enemyProjectileArchetypeKeys.get(proj)).toBe('fireball-mage');

    // Simulate shooter death + EID recycled by a different archetype ('recycled-mob').
    world.enemyAppearanceKeys.delete(shooterEid);
    world.enemyAppearanceKeys.set(shooterEid, 'recycled-mob');

    // Run the AoE pipeline: snapshot → destroy projectile → spawn explosion.
    aoeOnImpactPreDamage(world);
    removeEntity(world.ecs, proj);
    aoeOnImpactPostDamage(world);

    // Run area damage — explosion should splash the player.
    areaDamageSystem(world, collisionSystem(world));

    const splashHit = world.combatEvents.find((e) => e.type === 'hit' && e.targetType === 'player');
    expect(splashHit).toBeDefined();
    // Attribution must use the snapshotted key 'fireball-mage', not 'recycled-mob'.
    expect(splashHit!.sourceArchetypeKey).toBe('fireball-mage');
  });
});
