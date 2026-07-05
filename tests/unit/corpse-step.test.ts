/**
 * Unit tests for `corpseStepSystem` — the 10% "player stepped on a corpse"
 * detonation.
 *
 * Guarantees:
 *  1. Exposes the documented trigger chance and range.
 *  2. A player outside the corpse's step range never triggers a burst.
 *  3. Standing still on a corpse (already-overlapping last frame) does NOT
 *     re-roll — only fresh enter-transitions can trigger.
 *  4. A successful roll emits a `corpseExplode` combat event AND zeros the
 *     corpse's `DeathTimer.remainingMs` (matching the weapon-hit corpse path
 *     in `applyDamage`).
 *  5. Empirically ~10% of enter-transitions trigger across many rolls.
 *  6. Deterministic: same (seed, frame, corpseEid) → same outcome, and the
 *     roll never consumes from `world.rng`.
 */
import { addComponent, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { DeathTimer, Enemy, Player, Position } from '../../src/core/components.js';
import { createEntity } from '../../src/core/helpers.js';
import {
  CORPSE_STEP_RANGE_FT,
  CORPSE_STEP_TRIGGER_CHANCE,
  _resetCorpseStepTrackingForTest,
  corpseStepSystem,
} from '../../src/core/systems/corpseStepSystem.js';
import { createTestWorld } from '../helpers/world-factory.js';

type TestWorld = ReturnType<typeof createTestWorld>;

function spawnPlayer(world: TestWorld, x: number, y: number): number {
  const eid = createEntity(world);
  addComponent(world.ecs, eid, Player);
  addComponent(world.ecs, eid, set(Position, { x, y }));
  return eid;
}

function spawnCorpse(world: TestWorld, x: number, y: number, remainingMs = 500): number {
  const eid = createEntity(world);
  addComponent(world.ecs, eid, Enemy);
  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(world.ecs, eid, set(DeathTimer, { remainingMs }));
  return eid;
}

/**
 * Advance frames until the enter-transition rolls a trigger, or the budget
 * runs out. Each iteration wipes the previous-overlap tracker so every frame
 * is treated as a fresh step; the corpse's timer is re-armed the same way.
 */
function findTriggerFrame(world: TestWorld, corpseEid: number, budget = 1000): number {
  for (let i = 0; i < budget; i++) {
    _resetCorpseStepTrackingForTest(world);
    world.stores.deathTimer.remainingMs[corpseEid] = 500;
    world.combatEvents.length = 0;
    corpseStepSystem(world);
    if (world.combatEvents.length > 0) return i;
    world.frameCount++;
  }
  return -1;
}

describe('corpseStepSystem', () => {
  it('exposes the documented trigger chance and range', () => {
    expect(CORPSE_STEP_TRIGGER_CHANCE).toBe(0.1);
    expect(CORPSE_STEP_RANGE_FT).toBeGreaterThan(0);
  });

  it('never triggers when the player is outside the step range', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const corpse = spawnCorpse(world, CORPSE_STEP_RANGE_FT * 4, 0);

    for (let i = 0; i < 200; i++) {
      _resetCorpseStepTrackingForTest(world);
      world.stores.deathTimer.remainingMs[corpse] = 500;
      world.combatEvents.length = 0;
      corpseStepSystem(world);
      expect(world.combatEvents).toHaveLength(0);
      world.frameCount++;
    }
  });

  it('does not re-roll while the player stands still on a corpse', () => {
    const world = createTestWorld();
    spawnPlayer(world, 10, 10);
    const corpse = spawnCorpse(world, 10, 10);

    // Prime the tracker: first frame is the enter — it MAY trigger, so we
    // consume/ignore that outcome and reset the world state before checking
    // the standing-still property.
    corpseStepSystem(world);
    world.combatEvents.length = 0;
    world.stores.deathTimer.remainingMs[corpse] = 500;

    // Now spin many frames with player unmoved. Because prevOverlap contains
    // the corpse, none of these frames should re-roll — no events, ever.
    for (let i = 0; i < 200; i++) {
      world.frameCount++;
      corpseStepSystem(world);
      expect(world.combatEvents).toHaveLength(0);
    }
  });

  it('emits corpseExplode and zeros the timer on a successful roll', () => {
    const world = createTestWorld();
    spawnPlayer(world, 5, 5);
    const corpse = spawnCorpse(world, 5, 5);

    const frame = findTriggerFrame(world, corpse);
    expect(frame).toBeGreaterThanOrEqual(0);
    expect(world.combatEvents).toHaveLength(1);
    expect(world.combatEvents[0]).toMatchObject({
      type: 'corpseExplode',
      targetType: 'enemy',
      targetEid: corpse,
    });
    expect(world.stores.deathTimer.remainingMs[corpse]).toBe(0);
  });

  it('triggers roughly ~10% of enter-transitions across many rolls', () => {
    const world = createTestWorld();
    spawnPlayer(world, 5, 5);
    const corpse = spawnCorpse(world, 5, 5);

    const TRIALS = 400;
    let hits = 0;
    for (let i = 0; i < TRIALS; i++) {
      _resetCorpseStepTrackingForTest(world);
      world.stores.deathTimer.remainingMs[corpse] = 500;
      world.combatEvents.length = 0;
      corpseStepSystem(world);
      if (world.combatEvents.length > 0) hits++;
      world.frameCount++;
    }

    const rate = hits / TRIALS;
    // Wide band — the hash is uniform enough that 400 rolls land solidly in
    // [3%, 20%], but the test isn't asserting a specific PRNG.
    expect(rate).toBeGreaterThan(0.03);
    expect(rate).toBeLessThan(0.2);
  });

  it('is deterministic: same seed+frame+corpseEid → same outcome, no world.rng consumption', () => {
    const buildWorld = (): { world: TestWorld; corpse: number } => {
      const world = createTestWorld({ seed: 12345 });
      spawnPlayer(world, 0, 0);
      const corpse = spawnCorpse(world, 0, 0);
      world.frameCount = 77;
      return { world, corpse };
    };

    const a = buildWorld();
    const rngBeforeA = a.world.rng.next();
    // Rebuild so the .next() above doesn't advance the shared stream we
    // measure below; we just wanted a sample of "what would rng.next return".
    const a2 = buildWorld();
    corpseStepSystem(a2.world);
    const rngAfterA = a2.world.rng.next();
    // Cosmetic system must not touch the seeded gameplay RNG stream.
    expect(rngAfterA).toBe(rngBeforeA);

    const outcomeA = a2.world.combatEvents.length > 0;

    const b = buildWorld();
    corpseStepSystem(b.world);
    const outcomeB = b.world.combatEvents.length > 0;

    expect(outcomeB).toBe(outcomeA);
  });
});
