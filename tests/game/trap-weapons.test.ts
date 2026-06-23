import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { AreaDamage, Position, Trap } from '../../src/core/components.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { collisionSystem } from '../../src/core/systems/collisionSystem.js';
import { trapSystem } from '../../src/core/systems/trapSystem.js';
import { setActiveWeapon, weaponSystem } from '../../src/game/weaponSystem.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('trap weapons', () => {
  it('landmine spawns a Trap entity at player position', () => {
    const world = createTestWorld();
    spawnPlayer(world, 25, 25);
    const def = getWeaponDef('landmine')!;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);

    const traps = Array.from(query(world.ecs, [Trap, Position]));
    expect(traps).toHaveLength(1);
    const t = traps[0]!;
    expect(world.stores.position.x[t]).toBe(25);
    expect(world.stores.position.y[t]).toBe(25);
    expect(world.stores.trap.triggerRadius[t]).toBe(def.trapTriggerRadius);
    expect(world.stores.trap.explosionRadius[t]).toBe(def.trapExplosionRadius);
  });

  it('trap does not trigger before arm time', () => {
    const world = createTestWorld();
    spawnPlayer(world, 25, 25);
    const def = getWeaponDef('landmine')!;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);

    // Place enemy on top of trap immediately
    spawnEnemy(world, 25, 25, 50);

    // Run trap system before arm time elapses
    const collision = collisionSystem(world);
    trapSystem(world, collision);

    // Trap should still exist
    expect(query(world.ecs, [Trap]).length).toBe(1);
  });

  it('trap triggers when enemy enters radius after arming', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const def = getWeaponDef('landmine')!;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);

    // Advance past arm time
    world.elapsedMs += def.trapArmMs + 1;

    // Spawn enemy within trigger radius of trap (trap is at player position 0,0)
    spawnEnemy(world, 0.625, 0, 50);

    const collision = collisionSystem(world);
    trapSystem(world, collision);

    // Trap should be destroyed and an AreaDamage explosion spawned
    expect(query(world.ecs, [Trap]).length).toBe(0);
    const explosions = Array.from(query(world.ecs, [AreaDamage]));
    expect(explosions.length).toBeGreaterThanOrEqual(1);
  });
});
