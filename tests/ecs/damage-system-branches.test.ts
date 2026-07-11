import { addComponent, entityExists } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Stats } from '../../src/core/components.js';
import {
  spawnEnemy,
  spawnEnemyProjectile,
  spawnMeleeSwing,
  spawnPlayer,
  spawnProjectile,
} from '../../src/core/helpers.js';
import { collisionSystem } from '../../src/core/systems/collisionSystem.js';
import { damageSystem } from '../../src/core/systems/damageSystem.js';
import { makeMapWithSafeRoom } from '../helpers/map-fixtures.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('damageSystem enemy-projectile and safe-space branches', () => {
  it('damages the player and destroys an enemy projectile on hit', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    const projectile = spawnEnemyProjectile(world, 0.5, 0, 0, 0, 7);

    damageSystem(world, collisionSystem(world));

    expect(world.stores.health.current[player]).toBeLessThan(100);
    expect(entityExists(world.ecs, projectile)).toBe(false);
  });

  it('destroys an enemy projectile without damage when the player is in a safe space', () => {
    const world = createTestWorld();
    world.floorMap = makeMapWithSafeRoom({
      widthTiles: 12,
      heightTiles: 12,
      tileSizeFt: 4,
      maxRooms: 2,
      spawn: { x: 2, y: 2 },
    });
    // Tile (2,2) centre -> inside the safe room.
    const player = spawnPlayer(world, 2 * 4 + 2, 2 * 4 + 2);
    const projectile = spawnEnemyProjectile(world, 2 * 4 + 2.25, 2 * 4 + 2, 0, 0, 7);

    damageSystem(world, collisionSystem(world));

    expect(world.stores.health.current[player]).toBe(100);
    expect(entityExists(world.ecs, projectile)).toBe(false);
  });

  it('blocks an enemy projectile during the invincibility window', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    spawnEnemyProjectile(world, 0.5, 0, 0, 0, 7);

    damageSystem(world, collisionSystem(world));
    const healthAfterFirst = world.stores.health.current[player]!;
    world.combatEvents.length = 0;

    // Second projectile within the invincibility window is blocked.
    spawnEnemyProjectile(world, 0.5, 0, 0, 0, 7);
    world.elapsedMs += 50;
    damageSystem(world, collisionSystem(world));

    expect(world.stores.health.current[player]).toBe(healthAfterFirst);
    expect(world.combatEvents.some((e) => e.type === 'blocked')).toBe(true);
  });

  it('does not damage the player from enemy contact while in a safe space', () => {
    const world = createTestWorld();
    world.floorMap = makeMapWithSafeRoom({
      widthTiles: 12,
      heightTiles: 12,
      tileSizeFt: 4,
      maxRooms: 2,
      spawn: { x: 2, y: 2 },
    });
    const player = spawnPlayer(world, 2 * 4 + 2, 2 * 4 + 2);
    spawnEnemy(world, 2 * 4 + 2.25, 2 * 4 + 2, 25);

    damageSystem(world, collisionSystem(world));

    expect(world.stores.health.current[player]).toBe(100);
  });

  it('reduces contact damage by the player armor stat (min 1)', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    // Stats component gates armor mitigation; the armor value lives in the stats store.
    addComponent(world.ecs, player, Stats);
    world.stores.stats.armor[player] = 100;
    spawnEnemy(world, 1, 0, 25);

    damageSystem(world, collisionSystem(world));

    expect(world.stores.health.current[player]).toBe(99);
  });
});

describe('damageSystem hit-gated weapon-skill XP', () => {
  it('emits weapon_fired events for both skills when a player-owned projectile hits an enemy', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    const enemy = spawnEnemy(world, 100, 0, 50);
    // Spawn projectile and register skill source keyed by the attack entity EID.
    const projectile = spawnProjectile(world, 100, 0, 0, 0, 10, 0, 0, 1, player);
    world.attackSkillSources.set(projectile, {
      attackerEid: player,
      classSkillId: 'slashing',
      typeSkillId: 'sword',
    });

    damageSystem(world, collisionSystem(world));

    expect(world.stores.health.current[enemy]).toBeLessThan(50);
    const fired = world.skillUsageEvents.filter((e) => e.metric === 'weapon_fired');
    expect(fired).toHaveLength(2);
    expect(fired.map((e) => e.skillId).sort()).toEqual(['slashing', 'sword']);
    expect(fired.every((e) => e.holderEid === player)).toBe(true);
  });

  it('emits no skill events when an owner-less projectile hits an enemy (-1 guard)', () => {
    const world = createTestWorld();
    const enemy = spawnEnemy(world, 100, 0, 50);
    // No Owner component → ownerEid resolves to -1 and the emission is skipped.
    spawnProjectile(world, 100, 0, 0, 0, 10);

    damageSystem(world, collisionSystem(world));

    expect(world.stores.health.current[enemy]).toBeLessThan(50);
    expect(world.skillUsageEvents).toHaveLength(0);
  });

  it('emits no skill events when the owner has no registered weapon skills', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    const enemy = spawnEnemy(world, 100, 0, 50);
    // Owner present but attackSkillSources not populated for this projectile (no prior dispatch).
    spawnProjectile(world, 100, 0, 0, 0, 10, 0, 0, 1, player);

    damageSystem(world, collisionSystem(world));

    expect(world.stores.health.current[enemy]).toBeLessThan(50);
    expect(world.skillUsageEvents).toHaveLength(0);
  });

  it('credits weapon A skills even after the player switches to weapon B mid-flight (per-attack attribution)', () => {
    // Regression test for issue #292: projectile-outlives-weapon-switch.
    // Weapon A (ranged/bow) fires a slow projectile, the player immediately switches
    // to weapon B (sword), and weapon B lands a hit — the original slow projectile
    // must still credit weapon A's skills, not weapon B's.
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    const enemy = spawnEnemy(world, 100, 0, 50);

    // Weapon A fires a slow projectile and registers its skill source per-attack.
    const projectileA = spawnProjectile(world, 100, 0, 0, 0, 10, 0, 0, 1, player);
    world.attackSkillSources.set(projectileA, {
      attackerEid: player,
      classSkillId: 'ranged-class',
      typeSkillId: 'bow',
    });

    // Weapon B is now active and fires (simulating a weapon switch + fire).
    // Its skill source is registered for a different attack entity.
    const swingB = spawnMeleeSwing(world, 50, 0, player, 5, 2, 200, 1, 0, 120, 0);
    world.attackSkillSources.set(swingB, {
      attackerEid: player,
      classSkillId: 'melee-class',
      typeSkillId: 'sword',
    });

    // Now the original slow projectile lands — damageSystem resolves the hit.
    damageSystem(world, collisionSystem(world));

    // The hit should credit weapon A's skills ('bow'), NOT weapon B's ('sword').
    expect(world.stores.health.current[enemy]).toBeLessThan(50); // projectile hit
    const fired = world.skillUsageEvents.filter((e) => e.metric === 'weapon_fired');
    expect(fired).toHaveLength(2);
    expect(fired.map((e) => e.skillId).sort()).toEqual(['bow', 'ranged-class']);
    expect(fired.every((e) => e.holderEid === player)).toBe(true);
  });
});
