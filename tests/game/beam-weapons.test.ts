import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Lifetime, LineDamage, Position } from '../../src/core/components.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { beamSystem } from '../../src/core/systems/beamSystem.js';
import { setActiveWeapon, weaponSystem } from '../../src/game/weaponSystem.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('beam weapons', () => {
  it('laser spawns a LineDamage entity', () => {
    const world = createTestWorld();
    spawnPlayer(world, 100, 100);
    spawnEnemy(world, 200, 100, 30);
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
    const enemy = spawnEnemy(world, 50, 0, 100);
    const def = getWeaponDef('laser')!;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);
    beamSystem(world);

    const hp = world.stores.health.current[enemy] ?? 0;
    expect(hp).toBeLessThan(100);
    expect(hp).toBe(100 - def.baseDamage);
  });

  it('beam respects tick interval for repeated damage', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnEnemy(world, 50, 0, 100);
    const def = getWeaponDef('laser')!;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);
    beamSystem(world);

    const hpAfterFirst = world.stores.health.current[enemy] ?? 0;

    // Advance less than tickMs — should not deal damage again
    world.elapsedMs += def.beamTickMs / 2;
    beamSystem(world);
    expect(world.stores.health.current[enemy]).toBe(hpAfterFirst);

    // Advance past tickMs — should deal damage
    world.elapsedMs += def.beamTickMs;
    beamSystem(world);
    expect(world.stores.health.current[enemy]!).toBeLessThan(hpAfterFirst);
  });
});
