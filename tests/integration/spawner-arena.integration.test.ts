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
import {
  DeathTimer,
  Enemy,
  Health,
  Owner,
  Position,
  Spawner,
  XpGem,
} from '../../src/core/components.js';
import { applyDamage, DEFAULT_DAMAGE_OPTIONS } from '../../src/core/apply-damage.js';
import { spawnBehaviorEnemy, spawnPlayer, spawnSpawner } from '../../src/core/helpers.js';
import { deathTimerSystem } from '../../src/core/systems/deathTimerSystem.js';
import { dropSystem } from '../../src/core/systems/dropSystem.js';
import { spawnerArenaSystem } from '../../src/game/spawners/spawnerArenaSystem.js';
import { spawnerSystem } from '../../src/game/spawners/spawnerSystem.js';
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

  it('a burst hit on the lingering spawner corpse does not orphan the locked arena', () => {
    // Regression guard for the corpse-step interference bug: a dying spawner
    // lingers as an Enemy+DeathTimer corpse only so its scripted death handshake
    // can run (spawnerSystem sets deathResolved next tick → spawnerArenaSystem
    // moves LOCKED → RESOLVED). If a burst hit (corpseStepSystem, or any stray
    // AoE/beam funnelling through applyDamage) reaps the corpse early, the
    // entity is destroyed before the handshake completes and the locked arena is
    // orphaned forever — the player is trapped. This drives the REAL systems to
    // prove the guard in applyDamage keeps the invariant across the kill frame.
    const world = createTestWorld();
    const playerEid = spawnPlayer(world, 200, 200);
    const spawnerEid = spawnSpawner(world, 100, 100, RATS_NEST.hp, {
      defIndex: RATS_NEST_INDEX,
      contactDamage: RATS_NEST.contactDamage,
      arenaRadiusFt: RATS_NEST.arenaRadiusFt,
    });

    // ── Lock the arena: move the player into the disc.
    world.stores.position.x[playerEid] = 102;
    world.stores.position.y[playerEid] = 102;
    spawnerArenaSystem(world);
    expect(world.stores.spawner.arenaState[spawnerEid]).toBe(1); // LOCKED

    // ── Kill the spawner; it lingers as an Enemy+DeathTimer corpse (as the
    //    death/linger path would leave it) while the handshake plays out.
    world.stores.health.current[spawnerEid] = 0;
    addComponent(world.ecs, spawnerEid, set(DeathTimer, { remainingMs: 500 }));

    // ── A burst attempt lands on the spawner corpse this frame — the exact path
    //    corpseStepSystem or a stray AoE/beam funnels through. The guard in
    //    applyDamage must skip it, so the death timer is NOT zeroed.
    applyDamage(world, spawnerEid, 1, 100, 100, DEFAULT_DAMAGE_OPTIONS);
    expect(world.stores.deathTimer.remainingMs[spawnerEid]).toBe(500);
    expect(world.combatEvents.some((e) => e.type === 'corpseExplode')).toBe(false);

    // ── deathTimerSystem must NOT reap the spawner early (timer intact) …
    deathTimerSystem(world);
    expect(query(world.ecs, [Spawner]).includes(spawnerEid)).toBe(true);

    // ── … so the scripted handshake still runs: spawnerSystem sets
    //    deathResolved, then spawnerArenaSystem moves LOCKED → RESOLVED.
    spawnerSystem(world);
    expect(world.stores.spawner.deathResolved[spawnerEid]).toBe(1);
    spawnerArenaSystem(world);
    expect(world.stores.spawner.arenaState[spawnerEid]).toBe(2); // RESOLVED
    expect(world.vfxEvents.filter((e) => e.kind === 'spawnerArenaEnd').length).toBe(1);
  });
});
