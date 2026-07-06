import { describe, expect, it } from 'vitest';
import { addComponent, hasComponent, set } from 'bitecs';
import { knockbackSystem } from '../../../src/core/systems/knockbackSystem.js';
import { Immovable, Knockback } from '../../../src/core/components.js';
import {
  IMMOVABLE_THRESHOLD,
  KNOCKBACK_WEIGHT_BASELINE_LB,
  KNOCKBACK_WEIGHT_SCALE_MAX,
} from '../../../src/core/physics-defs.js';
import { spawnEnemy } from '../../../src/core/spawners/combatants.js';
import { createTestWorld } from '../../helpers/world-factory.js';

/**
 * Slice-2 (ADR 0044) unit tests for weight-scaled knockback in
 * `knockbackSystem`. Covers spec R5:
 *
 *   knockback distance ∝ (BASELINE / weight)
 *
 * Every test pins `weight.value[eid]` directly after spawn because
 * `spawnEnemy` → `initializeEnemyAppearance` jitters weight by sizeScale
 * [0.9, 1.1]. Pinning removes the jitter so the identity + ratio assertions
 * are exact.
 */
describe('knockbackSystem - weight scaling (Slice 2)', () => {
  /**
   * Run one impulse to completion (many frames) and return the total
   * displacement magnitude from the entity's starting position. `speed` is
   * kept small vs `remaining` so a single frame doesn't exhaust the impulse
   * and the sub-step passability logic still applies (it uses `step`).
   */
  function runToCompletion(
    weightLb: number,
    knockbackConfig: { dirX: number; dirY: number; remaining: number; speed: number },
    startX = 100,
    startY = 100,
  ): number {
    const world = createTestWorld();
    // Very large floor so wall clamps never fire, isolating the weight scale.
    // No floorMap set → the "no-floor" branch runs (unclamped displacement).
    const eid = spawnEnemy(world, startX, startY, 100);
    world.stores.weight.value[eid] = weightLb;
    addComponent(world.ecs, eid, set(Knockback, knockbackConfig));

    // Impulse duration is weight-invariant (spec R5 docblock): frames =
    // ceil(remaining / min(speed, remaining)). A generous ceiling protects
    // us from any accidental off-by-one — the assertion is on total
    // displacement anyway.
    const maxFrames = Math.max(
      32,
      Math.ceil(knockbackConfig.remaining / Math.max(1e-6, knockbackConfig.speed)) + 8,
    );
    let frames = 0;
    while (hasComponent(world.ecs, eid, Knockback) && frames < maxFrames) {
      knockbackSystem(world);
      frames += 1;
    }
    // Guard against runaway loops if the impulse ever fails to clear.
    expect(hasComponent(world.ecs, eid, Knockback)).toBe(false);

    const dx = (world.stores.position.x[eid] ?? startX) - startX;
    const dy = (world.stores.position.y[eid] ?? startY) - startY;
    return Math.hypot(dx, dy);
  }

  it('120 lb target: identity displacement (bit-parity vs pre-Slice-2)', () => {
    // Pre-Slice-2 code: step = min(speed, remaining); total = remaining.
    const total = runToCompletion(KNOCKBACK_WEIGHT_BASELINE_LB, {
      dirX: 1,
      dirY: 0,
      remaining: 10,
      speed: 2,
    });
    expect(total).toBeCloseTo(10, 5);
  });

  it('60 lb target: 2× total displacement vs baseline (spec R5, uncapped)', () => {
    // 60 lb → rawScale = 120/60 = 2.0 ≤ KNOCKBACK_WEIGHT_SCALE_MAX (2.5),
    // so no cap. This is the boundary data anchor: any target ≥48 lb scales
    // linearly; only sub-48 lb clamps to 2.5×.
    const total = runToCompletion(60, {
      dirX: 1,
      dirY: 0,
      remaining: 10,
      speed: 2,
    });
    expect(total).toBeCloseTo(20, 5);
  });

  it('6 lb target: clamped to KNOCKBACK_WEIGHT_SCALE_MAX (2.5×), NOT 20× (ADR 0044 Slice 2 refinement)', () => {
    // 6 lb (rat) → rawScale = 120/6 = 20 → clamped to 2.5.
    // Without the cap, a rat would be punted 200ft on a 10ft base impulse,
    // which visibly breaks game feel. Cap gives 25 ft = same distance as
    // any sub-48 lb light mob (slimes @ 20 lb also clamp).
    const total = runToCompletion(6, {
      dirX: 1,
      dirY: 0,
      remaining: 10,
      speed: 2,
    });
    expect(total).toBeCloseTo(10 * KNOCKBACK_WEIGHT_SCALE_MAX, 5);
    expect(total).toBeCloseTo(25, 5);
  });

  it('240 lb target: 0.5× total displacement vs baseline (spec R5)', () => {
    const total = runToCompletion(240, {
      dirX: 1,
      dirY: 0,
      remaining: 10,
      speed: 2,
    });
    expect(total).toBeCloseTo(5, 5);
  });

  it('Immovable tag: zero displacement, component removed same frame', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 100, 100, 100);
    world.stores.weight.value[eid] = 60; // deliberately light — would move 2× if not immovable
    addComponent(world.ecs, eid, Immovable);
    addComponent(world.ecs, eid, set(Knockback, { dirX: 1, dirY: 0, remaining: 10, speed: 2 }));

    knockbackSystem(world);

    expect(world.stores.position.x[eid]).toBeCloseTo(100, 6);
    expect(world.stores.position.y[eid]).toBeCloseTo(100, 6);
    expect(hasComponent(world.ecs, eid, Knockback)).toBe(false);
  });

  it('weight ≥ IMMOVABLE_THRESHOLD: zero displacement, component removed same frame', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 100, 100, 100);
    world.stores.weight.value[eid] = IMMOVABLE_THRESHOLD; // walls / statues
    addComponent(world.ecs, eid, set(Knockback, { dirX: 1, dirY: 0, remaining: 10, speed: 2 }));

    knockbackSystem(world);

    expect(world.stores.position.x[eid]).toBeCloseTo(100, 6);
    expect(world.stores.position.y[eid]).toBeCloseTo(100, 6);
    expect(hasComponent(world.ecs, eid, Knockback)).toBe(false);
  });

  it('impulse DURATION in frames is weight-invariant (only distance scales)', () => {
    // Duration invariance is the docblock contract: heavy targets aren't
    // dragged out over more frames, they just cover less distance in the
    // same number of frames. Guards against a regression where scaling
    // `remaining` accidentally scales duration too.
    function countFrames(weightLb: number): number {
      const world = createTestWorld();
      const eid = spawnEnemy(world, 100, 100, 100);
      world.stores.weight.value[eid] = weightLb;
      addComponent(world.ecs, eid, set(Knockback, { dirX: 1, dirY: 0, remaining: 10, speed: 2 }));
      let f = 0;
      while (hasComponent(world.ecs, eid, Knockback) && f < 32) {
        knockbackSystem(world);
        f += 1;
      }
      return f;
    }
    const frames120 = countFrames(120);
    expect(countFrames(60)).toBe(frames120);
    expect(countFrames(240)).toBe(frames120);
  });

  it('zero weight defaults to baseline (guard against divide-by-zero, and clamped)', () => {
    // A spawner regression that leaves weight = 0 must not divide-by-zero.
    // The reader clamps with max(1, weight): weight of 0 → rawScale = 120,
    // then clamped by KNOCKBACK_WEIGHT_SCALE_MAX = 2.5. Same clamp as any
    // sub-48 lb entity. Safety net; check:weight-coverage is the real
    // line of defense.
    const total = runToCompletion(0, {
      dirX: 1,
      dirY: 0,
      remaining: 10,
      speed: 2,
    });
    expect(Number.isFinite(total)).toBe(true);
    expect(total).toBeCloseTo(10 * KNOCKBACK_WEIGHT_SCALE_MAX, 5);
  });
});
