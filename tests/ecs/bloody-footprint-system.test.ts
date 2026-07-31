import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import { bloodyFootprintSystem } from '../../src/core/systems/bloodyFootprintSystem.js';
import { createTestWorld } from '../helpers/world-factory.js';
import {
  BLOODY_FOOTPRINT_EMIT_DISTANCE_FT,
  BLOODY_FOOTPRINT_SOURCE_LIFETIME_MS,
  createBloodPoolSurface,
  mixBloodColors,
} from '../../src/shared/blood-surfaces.js';

const GREEN_BLOOD = 0x22aa44;
const BLUE_BLOOD = 0x4466cc;
/**
 * One walk step. Slightly over the emit threshold because `Math.hypot` can
 * return marginally under an exact-threshold delta (e.g. 2.0999999999999996
 * for a 2.1 ft move), which would round the emit count down to zero.
 */
const STEP_FT = BLOODY_FOOTPRINT_EMIT_DISTANCE_FT * 1.05;

describe('bloodyFootprintSystem', () => {
  it('activates a footprint source from a blood pool and stamps colored footprints while moving', () => {
    const world = createTestWorld({ seed: 11 });
    const pool = createBloodPoolSurface({
      worldSeed: world.seed,
      poolId: world.bloodyFootprintState.nextPoolId++,
      x: 0,
      y: 0,
      color: GREEN_BLOOD,
      createdAtMs: world.elapsedMs,
    });
    const playerEid = spawnPlayer(
      world,
      pool.x + pool.renderOffsetXFt,
      pool.y + pool.renderOffsetYFt,
    );
    world.bloodPools.push(pool);

    bloodyFootprintSystem(world);
    expect(world.bloodyFootprintState.source?.color).toBe(GREEN_BLOOD);

    world.stores.position.x[playerEid] = STEP_FT;
    world.elapsedMs += 200;
    bloodyFootprintSystem(world);

    expect(world.bloodyFootprints.length).toBeGreaterThan(0);
    expect(new Set(world.bloodyFootprints.map((footprint) => footprint.color))).toEqual(
      new Set([GREEN_BLOOD]),
    );
  });

  it('mixes colors when a different blood pool is contacted while the source window is active', () => {
    const world = createTestWorld({ seed: 23 });
    const greenPool = createBloodPoolSurface({
      worldSeed: world.seed,
      poolId: world.bloodyFootprintState.nextPoolId++,
      x: 0,
      y: 0,
      color: GREEN_BLOOD,
      createdAtMs: world.elapsedMs,
    });
    const playerEid = spawnPlayer(
      world,
      greenPool.x + greenPool.renderOffsetXFt,
      greenPool.y + greenPool.renderOffsetYFt,
    );
    world.bloodPools.push(greenPool);

    bloodyFootprintSystem(world);
    const bluePool = createBloodPoolSurface({
      worldSeed: world.seed,
      poolId: world.bloodyFootprintState.nextPoolId++,
      x: 3,
      y: 0,
      color: BLUE_BLOOD,
      createdAtMs: world.elapsedMs,
    });
    world.bloodPools.push(bluePool);

    world.stores.position.x[playerEid] = bluePool.x + bluePool.renderOffsetXFt;
    world.stores.position.y[playerEid] = bluePool.y + bluePool.renderOffsetYFt;
    world.elapsedMs += 400;
    bloodyFootprintSystem(world);

    const mixed = mixBloodColors(GREEN_BLOOD, BLUE_BLOOD);
    expect(world.bloodyFootprintState.source?.color).toBe(mixed);
    expect(world.bloodyFootprints[world.bloodyFootprints.length - 1]?.color).toBe(mixed);
  });

  it('expires the source window after roughly five seconds without fresh pool contact', () => {
    const world = createTestWorld({ seed: 31 });
    const pool = createBloodPoolSurface({
      worldSeed: world.seed,
      poolId: world.bloodyFootprintState.nextPoolId++,
      x: 0,
      y: 0,
      color: GREEN_BLOOD,
      createdAtMs: world.elapsedMs,
    });
    const playerEid = spawnPlayer(
      world,
      pool.x + pool.renderOffsetXFt,
      pool.y + pool.renderOffsetYFt,
    );
    world.bloodPools.push(pool);

    bloodyFootprintSystem(world);
    world.stores.position.x[playerEid] = 20;
    world.elapsedMs += BLOODY_FOOTPRINT_SOURCE_LIFETIME_MS + 1;
    bloodyFootprintSystem(world);

    expect(world.bloodyFootprintState.source).toBeNull();
  });

  it('snaps the trail forward on large teleports instead of backfilling a line across the map', () => {
    const world = createTestWorld({ seed: 41 });
    const pool = createBloodPoolSurface({
      worldSeed: world.seed,
      poolId: world.bloodyFootprintState.nextPoolId++,
      x: 0,
      y: 0,
      color: GREEN_BLOOD,
      createdAtMs: world.elapsedMs,
    });
    const playerEid = spawnPlayer(
      world,
      pool.x + pool.renderOffsetXFt,
      pool.y + pool.renderOffsetYFt,
    );
    world.bloodPools.push(pool);

    bloodyFootprintSystem(world);
    world.stores.position.x[playerEid] = 50;
    world.elapsedMs += 100;
    bloodyFootprintSystem(world);

    expect(world.bloodyFootprints).toHaveLength(0);
    expect(world.bloodyFootprintState.source?.lastEmitX).toBe(50);
    expect(world.bloodyFootprintState.source?.lastEmitY).toBe(world.stores.position.y[playerEid]);
  });

  it('prunes expired pools and footprints in place before processing the current frame', () => {
    const world = createTestWorld({ seed: 47 });
    const expiredPool = createBloodPoolSurface({
      worldSeed: world.seed,
      poolId: world.bloodyFootprintState.nextPoolId++,
      x: 0,
      y: 0,
      color: GREEN_BLOOD,
      createdAtMs: 0,
    });
    const freshPool = createBloodPoolSurface({
      worldSeed: world.seed,
      poolId: world.bloodyFootprintState.nextPoolId++,
      x: 2,
      y: 0,
      color: BLUE_BLOOD,
      createdAtMs: 20_000,
    });
    expiredPool.expiresAtMs = 10;
    world.bloodPools.push(expiredPool, freshPool);
    world.bloodyFootprints.push({
      id: 1,
      x: 0,
      y: 0,
      color: GREEN_BLOOD,
      createdAtMs: 0,
      expiresAtMs: 10,
      angleRad: 0,
      heelRadiusXFt: 0.1,
      heelRadiusYFt: 0.1,
      toeRadiusXFt: 0.1,
      toeRadiusYFt: 0.1,
      toeOffsetFt: 0.1,
      smearLengthFt: 0,
      smearWidthFt: 0,
    });

    world.elapsedMs = 100;
    bloodyFootprintSystem(world);

    expect(world.bloodPools).toEqual([freshPool]);
    expect(world.bloodyFootprints).toHaveLength(0);
  });
});
