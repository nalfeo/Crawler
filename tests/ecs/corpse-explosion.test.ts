import { addComponent, hasComponent, query, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  BloodColor,
  DeathTimer,
  Enemy,
  Health,
  Invincible,
  Player,
  Spawner,
} from '../../src/core/components.js';
import { applyDamage, DEFAULT_DAMAGE_OPTIONS } from '../../src/core/apply-damage.js';
import { createEntity } from '../../src/core/helpers.js';
import { deathTimerSystem } from '../../src/core/systems/deathTimerSystem.js';
import { createTestWorld } from '../helpers/world-factory.js';

/** A corpse: a dead enemy still in its death-linger window. */
function makeCorpse(world: ReturnType<typeof createTestWorld>, remainingMs = 500): number {
  const eid = createEntity(world);
  addComponent(world.ecs, eid, set(Health, { current: 0, max: 50 }));
  addComponent(world.ecs, eid, Enemy);
  addComponent(world.ecs, eid, set(DeathTimer, { remainingMs }));
  return eid;
}

/**
 * A dying Spawner structure (rats-nest / slime-pit) lingering as a corpse:
 * `Enemy` + `DeathTimer` like any corpse, but ALSO carrying `Spawner`. It must
 * survive its full linger so its scripted death handshake (finale wave + arena
 * LOCKED→RESOLVED) can complete, so the corpse choke point must never burst it.
 */
function makeSpawnerCorpse(world: ReturnType<typeof createTestWorld>, remainingMs = 500): number {
  const eid = makeCorpse(world, remainingMs);
  addComponent(world.ecs, eid, set(Spawner, {}));
  return eid;
}

describe('corpse explosion (applyDamage corpse choke point)', () => {
  it('emits a corpseExplode event and expires the corpse when a corpse is hit', () => {
    const world = createTestWorld();
    world.elapsedMs = 999;
    const corpse = makeCorpse(world, 500);

    const dealt = applyDamage(world, corpse, 25, 10, 20, DEFAULT_DAMAGE_OPTIONS);

    // The blow is consumed by the drama, not the (already 0) HP.
    expect(dealt).toBe(0);
    expect(world.stores.health.current[corpse]).toBe(0);
    // Timer zeroed so deathTimerSystem reaps the corpse this same frame.
    expect(world.stores.deathTimer.remainingMs[corpse]).toBe(0);

    expect(world.combatEvents).toHaveLength(1);
    expect(world.combatEvents[0]).toMatchObject({
      type: 'corpseExplode',
      x: 10,
      y: 20,
      amount: 25,
      targetType: 'enemy',
      targetEid: corpse,
      timestamp: 999,
    });
  });

  it('reads the corpse blood colour and sprite variant into the event', () => {
    const world = createTestWorld();
    const corpse = makeCorpse(world, 500);
    addComponent(world.ecs, corpse, BloodColor);
    world.stores.bloodColor.r[corpse] = 0x33;
    world.stores.bloodColor.g[corpse] = 0x66;
    world.stores.bloodColor.b[corpse] = 0x99;
    world.stores.sprite.textureId[corpse] = 2;

    applyDamage(world, corpse, 10, 0, 0, DEFAULT_DAMAGE_OPTIONS);

    expect(world.combatEvents[0]).toMatchObject({
      bloodColor: 0x336699,
      spriteTextureId: 2,
    });
  });

  it('defaults blood colour to red when the corpse has no BloodColor component', () => {
    const world = createTestWorld();
    const corpse = makeCorpse(world, 500);

    applyDamage(world, corpse, 10, 0, 0, DEFAULT_DAMAGE_OPTIONS);

    expect(world.combatEvents[0]!.bloodColor).toBe(0xcc0000);
  });

  it('sprays shards away from the attacker (normalised source→target direction)', () => {
    const world = createTestWorld();
    const corpse = makeCorpse(world, 500);

    // Attacker below the corpse; the blow travels straight up (+y).
    applyDamage(world, corpse, 10, 10, 20, {
      ...DEFAULT_DAMAGE_OPTIONS,
      sourceX: 10,
      sourceY: 0,
    });

    const event = world.combatEvents[0]!;
    expect(event.knockbackDirX).toBeCloseTo(0);
    expect(event.knockbackDirY).toBeCloseTo(1);
  });

  it('leaves the spray direction neutral when no source position is given', () => {
    const world = createTestWorld();
    const corpse = makeCorpse(world, 500);

    applyDamage(world, corpse, 10, 10, 20, DEFAULT_DAMAGE_OPTIONS);

    const event = world.combatEvents[0]!;
    expect(event.knockbackDirX).toBe(0);
    expect(event.knockbackDirY).toBe(0);
  });

  it('is idempotent: a second hit the same frame does not emit a duplicate', () => {
    const world = createTestWorld();
    const corpse = makeCorpse(world, 500);

    applyDamage(world, corpse, 10, 0, 0, DEFAULT_DAMAGE_OPTIONS);
    applyDamage(world, corpse, 10, 0, 0, DEFAULT_DAMAGE_OPTIONS);

    expect(world.combatEvents).toHaveLength(1);
  });

  it('does not explode a corpse whose timer has already expired', () => {
    const world = createTestWorld();
    const corpse = makeCorpse(world, 0);

    const dealt = applyDamage(world, corpse, 10, 0, 0, DEFAULT_DAMAGE_OPTIONS);

    expect(dealt).toBe(0);
    expect(world.combatEvents).toHaveLength(0);
  });

  it('does not explode a living enemy (no DeathTimer) — it takes a normal hit', () => {
    const world = createTestWorld();
    const enemy = createEntity(world);
    addComponent(world.ecs, enemy, set(Health, { current: 30, max: 30 }));
    addComponent(world.ecs, enemy, Enemy);

    const dealt = applyDamage(world, enemy, 10, 0, 0, DEFAULT_DAMAGE_OPTIONS);

    expect(dealt).toBe(10);
    expect(world.stores.health.current[enemy]).toBe(20);
    expect(world.combatEvents[0]!.type).toBe('hit');
  });

  it('does not explode a dead Player in linger (corpse drama is enemy-only)', () => {
    const world = createTestWorld();
    const eid = createEntity(world);
    addComponent(world.ecs, eid, set(Health, { current: 0, max: 50 }));
    addComponent(world.ecs, eid, Player);
    addComponent(world.ecs, eid, set(DeathTimer, { remainingMs: 500 }));

    applyDamage(world, eid, 10, 0, 0, DEFAULT_DAMAGE_OPTIONS);

    expect(world.combatEvents.some((e) => e.type === 'corpseExplode')).toBe(false);
  });

  it('respects Invincible: an invincible corpse is not detonated', () => {
    const world = createTestWorld();
    const corpse = makeCorpse(world, 500);
    addComponent(world.ecs, corpse, Invincible);

    applyDamage(world, corpse, 10, 0, 0, DEFAULT_DAMAGE_OPTIONS);

    expect(world.combatEvents).toHaveLength(0);
    expect(world.stores.deathTimer.remainingMs[corpse]).toBe(500);
  });

  it('lets deathTimerSystem reap the detonated corpse the same frame', () => {
    const world = createTestWorld();
    const corpse = makeCorpse(world, 500);

    applyDamage(world, corpse, 10, 0, 0, DEFAULT_DAMAGE_OPTIONS);
    // remainingMs is now 0; deathTimerSystem decrements and removes when <= 0.
    deathTimerSystem(world);

    expect(hasComponent(world.ecs, corpse, DeathTimer)).toBe(false);
    expect(query(world.ecs, [Enemy]).includes(corpse)).toBe(false);
  });

  it('does NOT detonate a Spawner corpse — preserves its timer for the death handshake', () => {
    const world = createTestWorld();
    const spawnerCorpse = makeSpawnerCorpse(world, 500);

    const dealt = applyDamage(world, spawnerCorpse, 25, 10, 20, DEFAULT_DAMAGE_OPTIONS);

    // Blow is absorbed (corpse at 0 HP) but the burst is skipped entirely.
    expect(dealt).toBe(0);
    expect(world.combatEvents.some((e) => e.type === 'corpseExplode')).toBe(false);
    // Timer untouched so the spawner survives its full linger and its scripted
    // death handshake (deathResolved → arena RESOLVED) can complete.
    expect(world.stores.deathTimer.remainingMs[spawnerCorpse]).toBe(500);
  });

  it('does NOT reap a Spawner corpse the frame it is hit (no early reap → no orphaned arena)', () => {
    const world = createTestWorld();
    const spawnerCorpse = makeSpawnerCorpse(world, 500);

    // A stray hit (footstep burst, AoE, beam) on the lingering spawner corpse…
    applyDamage(world, spawnerCorpse, 10, 0, 0, DEFAULT_DAMAGE_OPTIONS);
    // …must NOT let deathTimerSystem reap it this frame (timer still > 0).
    deathTimerSystem(world);

    expect(hasComponent(world.ecs, spawnerCorpse, DeathTimer)).toBe(true);
    expect(query(world.ecs, [Enemy]).includes(spawnerCorpse)).toBe(true);
  });
});
