/**
 * Real-pipeline knockback weight asymmetry guard (Slice 2, ADR 0044).
 *
 * Spec `.specify/specs/entity-physics.md` R5 requires that identical
 * knockback impulses produce visibly different displacements on light vs
 * heavy targets. The unit-level test
 * (`tests/unit/core/knockback.weight.test.ts`) already proves the math in
 * isolation. This guard raises confidence up a layer: it exercises the
 * *real* spawner + `knockbackSystem` pair against a `GameWorld` created by
 * the shipped `createGameWorld` factory, using a fixed room-free position
 * so a floormap can't clamp movement.
 *
 * Placed under `tests/headless/` (not `tests/e2e/`) because the codebase's
 * `tests/e2e/` project is Playwright-only: it boots a Vite lab server per
 * spec via `global-setup.ts`. A deterministic simulation test that never
 * touches the DOM doesn't fit that project and would be needlessly slow.
 * The spec's requirement is "deterministic, not a lab, exercises the real
 * pipeline" — this satisfies all three.
 *
 * Rule #10 note: this drives the shipping `knockbackSystem` function (not a
 * lab-mocked variant) against a shipping `createGameWorld` — so it is a
 * real-pipeline artifact, not a lab-only proof.
 */
import { addComponent, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Knockback } from '../../src/core/components.js';
import { createGameWorld } from '../../src/core/world.js';
import { knockbackSystem } from '../../src/core/systems/knockbackSystem.js';
import { spawnEnemy } from '../../src/core/spawners/combatants.js';

// Same impulse for both mobs: knockback speed (ft/frame) and total distance
// (ft) before the component expires. Values chosen to be small enough that
// even 2x scaling stays inside a bounded arena (no floormap present) and
// large enough that fractional-frame effects are irrelevant.
const KNOCKBACK_SPEED_FT_PER_FRAME = 4;
const KNOCKBACK_DISTANCE_FT = 10;
const FRAMES_TO_RUN = 20; // 4 ft/frame × 3-4 frames should always exhaust 10 ft * 2

function stepUntilKnockbackClears(world: ReturnType<typeof createGameWorld>): void {
  for (let i = 0; i < FRAMES_TO_RUN; i++) {
    knockbackSystem(world);
  }
}

describe('knockback weight asymmetry (Slice 2, real pipeline)', () => {
  it('heavy mob moves less than light mob under identical impulse', () => {
    // Deterministic seed. `createGameWorld` uses `SeededRandom`, and no
    // Math.random is called along the code path this test exercises.
    const world = createGameWorld({ seed: 42 });

    // Spawn a light mob (60 lb) and a heavy mob (240 lb) at (100, 100) and
    // (200, 100). Y-coord is arbitrary; distance in x measures displacement.
    // `spawnEnemy` sets Weight to 120 by default and then
    // `initializeEnemyAppearance` jitters it by a per-eid sizeScale — so we
    // must pin the store *after* spawn to keep the impulse deterministic.
    const lightEid = spawnEnemy(world, 100, 100, /* hp */ 100, /* weight */ 60);
    const heavyEid = spawnEnemy(world, 200, 100, /* hp */ 100, /* weight */ 240);

    // Pin weights (overwrite the jitter — `initializeEnemyAppearance` uses a
    // seeded RNG but the exact result depends on eid ordering, so pinning is
    // both cleaner and immune to future spawn-order refactors).
    world.stores.weight.value[lightEid] = 60;
    world.stores.weight.value[heavyEid] = 240;

    // Record starting positions.
    const lightStartX = world.stores.position.x[lightEid]!;
    const heavyStartX = world.stores.position.x[heavyEid]!;

    // Apply IDENTICAL knockback to both: same direction (+x), same speed,
    // same total distance. Any asymmetry in final displacement is entirely
    // attributable to the weight-scaling divisor in knockbackSystem.
    addComponent(
      world.ecs,
      lightEid,
      set(Knockback, {
        dirX: 1,
        dirY: 0,
        speed: KNOCKBACK_SPEED_FT_PER_FRAME,
        remaining: KNOCKBACK_DISTANCE_FT,
      }),
    );
    addComponent(
      world.ecs,
      heavyEid,
      set(Knockback, {
        dirX: 1,
        dirY: 0,
        speed: KNOCKBACK_SPEED_FT_PER_FRAME,
        remaining: KNOCKBACK_DISTANCE_FT,
      }),
    );

    // Run until both impulses have fully drained.
    stepUntilKnockbackClears(world);

    const lightDisplacement = world.stores.position.x[lightEid]! - lightStartX;
    const heavyDisplacement = world.stores.position.x[heavyEid]! - heavyStartX;

    // Core spec R5 assertion: heavy mob moves strictly less than light mob.
    expect(heavyDisplacement).toBeLessThan(lightDisplacement);

    // Ratio sanity: 60 lb → 2×, 240 lb → 0.5×, so ratio should be 4:1.
    // Guard against floormap/clamp bugs quietly reducing the delta.
    const ratio = lightDisplacement / heavyDisplacement;
    expect(ratio).toBeGreaterThan(3.5);
    expect(ratio).toBeLessThan(4.5);

    // Absolute sanity: light mob should have moved ~20 ft (10 ft * 2×
    // weight scale); heavy mob should have moved ~5 ft (10 ft * 0.5×).
    expect(lightDisplacement).toBeGreaterThan(19);
    expect(lightDisplacement).toBeLessThan(21);
    expect(heavyDisplacement).toBeGreaterThan(4.5);
    expect(heavyDisplacement).toBeLessThan(5.5);
  });
});
