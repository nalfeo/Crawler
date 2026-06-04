import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { AreaDamage, Lifetime, Owner, Position, Team } from '../../src/core/components.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { setActiveWeapon, weaponSystem } from '../../src/game/weaponSystem.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('melee weapons', () => {
  it('sword spawns an AreaDamage entity at player position', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 100, 100);
    const def = getWeaponDef('sword')!;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);

    const areas = Array.from(query(world.ecs, [AreaDamage, Position, Lifetime, Owner]));
    expect(areas).toHaveLength(1);
    const aoe = areas[0]!;
    expect(world.stores.position.x[aoe]).toBe(100);
    expect(world.stores.position.y[aoe]).toBe(100);
    expect(world.stores.areaDamage.damage[aoe]).toBe(def.baseDamage);
    expect(world.stores.areaDamage.radius[aoe]).toBe(def.aoeRadius);
    expect(world.stores.owner.eid[aoe]).toBe(player);
  });

  it('sword respects cooldown', () => {
    const world = createTestWorld();
    spawnPlayer(world, 100, 100);
    const def = getWeaponDef('sword')!;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);
    world.elapsedMs += def.cooldownMs / 2;
    weaponSystem(world);

    expect(query(world.ecs, [AreaDamage]).length).toBe(1);
  });

  it('knife has faster cooldown than sword', () => {
    const knife = getWeaponDef('knife')!;
    const sword = getWeaponDef('sword')!;
    expect(knife.cooldownMs).toBeLessThan(sword.cooldownMs);
  });

  it('hammer has higher damage and longer cooldown', () => {
    const hammer = getWeaponDef('hammer')!;
    const sword = getWeaponDef('sword')!;
    expect(hammer.baseDamage).toBeGreaterThan(sword.baseDamage);
    expect(hammer.cooldownMs).toBeGreaterThan(sword.cooldownMs);
  });

  it('melee attack has Team component for friendly fire prevention', () => {
    const world = createTestWorld();
    spawnPlayer(world, 50, 50);
    setActiveWeapon(world, getWeaponDef('sword')!);
    world.elapsedMs = 1000;

    weaponSystem(world);

    const areas = Array.from(query(world.ecs, [AreaDamage, Team]));
    expect(areas).toHaveLength(1);
  });
});

describe('unarmed weapons', () => {
  it('punch spawns a short-range AreaDamage', () => {
    const world = createTestWorld();
    spawnPlayer(world, 200, 200);
    const def = getWeaponDef('punch')!;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);

    const areas = Array.from(query(world.ecs, [AreaDamage, Position]));
    expect(areas).toHaveLength(1);
    expect(world.stores.areaDamage.radius[areas[0]!]).toBe(def.aoeRadius);
    expect(world.stores.areaDamage.damage[areas[0]!]).toBe(def.baseDamage);
  });

  it('kick has shorter cooldown range than punch', () => {
    const punch = getWeaponDef('punch')!;
    const kick = getWeaponDef('kick')!;
    expect(kick.cooldownMs).toBeGreaterThan(punch.cooldownMs);
    expect(kick.baseDamage).toBeGreaterThan(punch.baseDamage);
  });
});
