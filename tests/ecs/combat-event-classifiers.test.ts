import { addComponent, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  AoeOnImpact,
  Enemy,
  EnemyProjectile,
  Player,
  Projectile,
  Returning,
} from '../../src/core/components.js';
import {
  resolveProjectileWeaponType,
  resolveTargetMaterial,
} from '../../src/core/combat-event-classifiers.js';
import { createEntity } from '../../src/core/helpers.js';
import { setEntityTags } from '../../src/core/systems/equipmentSystem.js';
import { WeaponType } from '../../src/shared/constants.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('combat event classifiers', () => {
  it('classifies target material from tags with mechanical precedence', () => {
    const world = createTestWorld();
    const livingEnemy = createEntity(world);
    addComponent(world.ecs, livingEnemy, Enemy);

    const undeadEnemy = createEntity(world);
    addComponent(world.ecs, undeadEnemy, Enemy);
    setEntityTags(world, undeadEnemy, ['undead']);

    const mixedEnemy = createEntity(world);
    addComponent(world.ecs, mixedEnemy, Enemy);
    setEntityTags(world, mixedEnemy, ['undead', 'mechanical']);

    expect(resolveTargetMaterial(world, livingEnemy)).toBe('living');
    expect(resolveTargetMaterial(world, undeadEnemy)).toBe('undead');
    expect(resolveTargetMaterial(world, mixedEnemy)).toBe('mechanical');
  });

  it('classifies players as living regardless of tags', () => {
    const world = createTestWorld();
    const player = createEntity(world);
    addComponent(world.ecs, player, Player);
    setEntityTags(world, player, ['undead', 'mechanical']);

    expect(resolveTargetMaterial(world, player)).toBe('living');
  });

  it('classifies projectile weapon type from projectile components', () => {
    const world = createTestWorld();

    const enemyProj = createEntity(world);
    addComponent(world.ecs, enemyProj, set(Projectile, { pierce: 0, hitCount: 0 }));
    addComponent(world.ecs, enemyProj, EnemyProjectile);

    const magicProj = createEntity(world);
    addComponent(world.ecs, magicProj, set(Projectile, { pierce: 0, hitCount: 0 }));
    addComponent(world.ecs, magicProj, set(AoeOnImpact, { radius: 10, damage: 5 }));

    const thrownProj = createEntity(world);
    addComponent(world.ecs, thrownProj, set(Projectile, { pierce: 0, hitCount: 0 }));
    addComponent(
      world.ecs,
      thrownProj,
      set(Returning, { returnSpeed: 2, isReturning: 0, maxRange: 100, originX: 0, originY: 0 }),
    );

    const rangedProj = createEntity(world);
    addComponent(world.ecs, rangedProj, set(Projectile, { pierce: 0, hitCount: 0 }));

    expect(resolveProjectileWeaponType(world, enemyProj)).toBe('enemy-projectile');
    expect(resolveProjectileWeaponType(world, magicProj)).toBe(WeaponType.MAGIC);
    expect(resolveProjectileWeaponType(world, thrownProj)).toBe(WeaponType.THROWN);
    expect(resolveProjectileWeaponType(world, rangedProj)).toBe(WeaponType.RANGED);
  });
});
