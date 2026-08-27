import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Lifetime, LineDamage, Position } from '../../src/core/components.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { beamSystem } from '../../src/core/systems/beamSystem.js';
import { lifetimeSystem } from '../../src/core/systems/lifetimeSystem.js';
import { setActiveWeapon, weaponSystem } from '../../src/game/weaponSystem.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('beam weapons', () => {
  it('laser spawns a LineDamage entity', () => {
    const world = createTestWorld();
    spawnPlayer(world, 12.5, 12.5);
    spawnEnemy(world, 25, 12.5, 30);
    const def = getWeaponDef('laser')!;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);

    const beams = Array.from(query(world.ecs, [LineDamage, Position, Lifetime]));
    expect(beams).toHaveLength(1);
    const b = beams[0]!;
    expect(world.stores.lineDamage.length[b]).toBe(def.beamLength);
    expect(world.stores.lineDamage.damage[b]).toBe(def.baseDamage);
    expect(world.stores.lineDamage.tickMs[b]).toBe(def.beamTickMs);
  });

  it('beam damages enemies along its line', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnEnemy(world, 6.25, 0, 100);
    const def = getWeaponDef('laser')!;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);
    beamSystem(world);

    const hp = world.stores.health.current[enemy] ?? 0;
    expect(hp).toBeLessThan(100);
    expect(hp).toBe(100 - def.baseDamage);
  });

  it('damages each enemy once per firing while still hitting late entrants', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const firstEnemy = spawnEnemy(world, 6.25, 0, 100);
    const def = { ...getWeaponDef('laser')!, baseAccuracy: 1 };
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);
    beamSystem(world);

    expect(world.stores.health.current[firstEnemy]).toBe(100 - def.baseDamage);

    const lateEnemy = spawnEnemy(world, 12.5, 0, 100);
    world.elapsedMs += def.beamTickMs;
    beamSystem(world);
    expect(world.stores.health.current[firstEnemy]).toBe(100 - def.baseDamage);
    expect(world.stores.health.current[lateEnemy]).toBe(100 - def.baseDamage);

    world.elapsedMs += def.durationMs - def.beamTickMs;
    beamSystem(world);
    expect(world.stores.health.current[firstEnemy]).toBe(100 - def.baseDamage);
    expect(world.stores.health.current[lateEnemy]).toBe(100 - def.baseDamage);
    lifetimeSystem(world);

    world.elapsedMs = def.cooldownMs * 2;
    weaponSystem(world);
    beamSystem(world);

    expect(world.stores.health.current[firstEnemy]).toBe(100 - def.baseDamage * 2);
    expect(world.stores.health.current[lateEnemy]).toBe(100 - def.baseDamage * 2);
  });
});
