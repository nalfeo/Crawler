/**
 * Integration test for the spawner battle-arena feature.
 *
 * Verifies the full loop end-to-end:
 *   1. Spawn a spawner + player far apart.
 *   2. Move the player into the arena disc → assert arenaState 0 → 1 and that
 *      VFX + announcement events were pushed.
 *   3. Kill the spawner → assert `deathResolved === 1` and, on the next arena
 *      tick, arenaState 2 + banked XP gem spawned at the spawner's position.
 *
 * We drive the systems directly (`spawnerArenaSystem`, `spawnerSystem`,
 * `dropSystem`) so the test stays fast; the wired pipelines are covered by
 * the visual/preSystems contract tests.
 */
import { addComponent, hasComponent, query, set, setComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Enemy, Health, Owner, Position, Spawner, XpGem } from '../../src/core/components.js';
import { spawnBehaviorEnemy, spawnPlayer, spawnSpawner } from '../../src/core/helpers.js';
import { dropSystem } from '../../src/core/systems/dropSystem.js';
import { spawnerArenaSystem } from '../../src/game/spawners/spawnerArenaSystem.js';
import { getSpawnerArchetype, getSpawnerArchetypeIndex } from '../../src/game/spawners/registry.js';
import { AI_TYPE } from '../../src/game/index.js';
import { createTestWorld } from '../helpers/world-factory.js';

const RATS_NEST_INDEX = getSpawnerArchetypeIndex('rats-nest');
const RATS_NEST = getSpawnerArchetype('rats-nest')!;

describe('spawner arena — integration', () => {
  it('runs the idle → locked → resolved lifecycle and grants banked XP on resolve', () => {
    const world = createTestWorld();
    const playerEid = spawnPlayer(world, 200, 200);
    const spawnerEid = spawnSpawner(world, 100, 100, RATS_NEST.hp, {
      defIndex: RATS_NEST_INDEX,
      contactDamage: RATS_NEST.contactDamage,
      arenaRadiusFt: RATS_NEST.arenaRadiusFt,
    });

    // ── (1) Player is far away — arena stays idle.
    spawnerArenaSystem(world);
    expect(world.stores.spawner.arenaState[spawnerEid]).toBe(0);
    expect(world.vfxEvents.filter((e) => e.kind === 'spawnerArenaStart').length).toBe(0);

    // ── (2) Move the player into the arena disc — trigger the arena.
    world.stores.position.x[playerEid] = 102;
    world.stores.position.y[playerEid] = 102;
    spawnerArenaSystem(world);
    expect(world.stores.spawner.arenaState[spawnerEid]).toBe(1);
    expect(world.vfxEvents.filter((e) => e.kind === 'spawnerArenaStart').length).toBe(1);
    expect(world.announcements.filter((a) => a.kind === 'spawnerArenaStart').length).toBe(1);

    // ── (3) Kill a child mob so XP is banked on the spawner.
    const childEid = spawnBehaviorEnemy(world, 120, 120, 10, AI_TYPE.CHASE, 1, 200, 0);
    addComponent(world.ecs, childEid, set(Owner, { eid: spawnerEid }));
    setComponent(world.ecs, childEid, Health, { current: 0, max: 10 });
    world.frameCount += 1;
    const xpBefore = query(world.ecs, [XpGem]).length;
    dropSystem(world);
    // No new XP gem — the drop was banked instead.
    expect(query(world.ecs, [XpGem]).length).toBe(xpBefore);
    const bankedAfterChild = world.stores.spawner.bankedXp[spawnerEid] ?? 0;
    expect(bankedAfterChild).toBeGreaterThan(0);
    expect(world.stores.spawner.bankedChildren[spawnerEid] ?? 0).toBe(1);

    // ── (4) Kill the spawner + set deathResolved (as spawnerSystem would).
    world.stores.health.current[spawnerEid] = 0;
    world.stores.spawner.deathResolved[spawnerEid] = 1;
    spawnerArenaSystem(world);
    expect(world.stores.spawner.arenaState[spawnerEid]).toBe(2);
    expect(world.vfxEvents.filter((e) => e.kind === 'spawnerArenaEnd').length).toBe(1);
    expect(world.announcements.filter((a) => a.kind === 'spawnerArenaEnd').length).toBe(1);

    // The banked XP was granted as a single new XpGem at the spawner's position.
    const gemsAfterResolve = query(world.ecs, [XpGem, Position]);
    expect(gemsAfterResolve.length).toBe(xpBefore + 1);
    const gemEid = gemsAfterResolve[gemsAfterResolve.length - 1]!;
    expect(world.stores.xpGem.value[gemEid]).toBe(bankedAfterChild);
    expect(world.stores.position.x[gemEid]).toBeCloseTo(100, 4);
    expect(world.stores.position.y[gemEid]).toBeCloseTo(100, 4);

    // No further arena events after resolution (state=2 is terminal).
    const vfxCountBefore = world.vfxEvents.length;
    const annCountBefore = world.announcements.length;
    spawnerArenaSystem(world);
    expect(world.vfxEvents.length).toBe(vfxCountBefore);
    expect(world.announcements.length).toBe(annCountBefore);

    // Sanity: the spawner still has its Spawner tag so downstream systems can
    // introspect the terminal state.
    expect(hasComponent(world.ecs, spawnerEid, Spawner)).toBe(true);
    expect(hasComponent(world.ecs, spawnerEid, Enemy)).toBe(true);
  });
});
