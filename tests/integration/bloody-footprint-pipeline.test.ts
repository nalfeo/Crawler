import { setComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Health } from '../../src/core/components.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { runSimulationStep as runVisualStep } from '../../src/engine/sim/simulation-step.js';
import { runSimulationStep as runHeadlessStep } from '../../src/game/ai/simulation-step.js';
import { createInputState } from '../../src/shared/input.js';
import { GAME } from '../../src/shared/constants.js';
import { BLOODY_FOOTPRINT_EMIT_DISTANCE_FT } from '../../src/shared/blood-surfaces.js';
import { createTestWorld } from '../helpers/world-factory.js';

const GREEN_BLOOD = 0x22aa44;

/** Per-frame walk distance for the straight-line trail probe (ft). */
const WALK_STEP_FT = 0.35;
/** Frames walked — long enough to lay several strides at any tuned spacing. */
const WALK_FRAMES = 60;
/**
 * One walk step. Slightly over the emit threshold because `Math.hypot` can
 * return marginally under an exact-threshold delta (e.g. 2.0999999999999996
 * for a 2.1 ft move), which would round the emit count down to zero.
 */
const STEP_FT = BLOODY_FOOTPRINT_EMIT_DISTANCE_FT * 1.05;

function runVisualFrame(world: ReturnType<typeof createTestWorld>): void {
  world.frameCount += 1;
  world.elapsedMs += GAME.DELTA_MS;
  runVisualStep(world, createInputState());
}

function summarizeWithVisualPipeline() {
  const world = createTestWorld({ seed: 13 });
  const playerEid = spawnPlayer(world, 0, 0);
  const enemyEid = spawnEnemy(world, 0, 0, 10, 120, GREEN_BLOOD);
  setComponent(world.ecs, enemyEid, Health, { current: 0, max: 10 });

  runVisualFrame(world);
  world.stores.position.x[playerEid] = STEP_FT;
  runVisualFrame(world);

  return {
    poolCount: world.bloodPools.length,
    sourceColor: world.bloodyFootprintState.source?.color ?? null,
    footprintCount: world.bloodyFootprints.length,
    footprintColor: world.bloodyFootprints[0]?.color ?? null,
  };
}

function summarizeWithHeadlessPipeline() {
  const world = createTestWorld({ seed: 13 });
  const playerEid = spawnPlayer(world, 0, 0);
  const enemyEid = spawnEnemy(world, 0, 0, 10, 120, GREEN_BLOOD);
  setComponent(world.ecs, enemyEid, Health, { current: 0, max: 10 });

  runHeadlessStep(world, createInputState(), GAME.DELTA_MS);
  world.stores.position.x[playerEid] = STEP_FT;
  runHeadlessStep(world, createInputState(), GAME.DELTA_MS);

  return {
    poolCount: world.bloodPools.length,
    sourceColor: world.bloodyFootprintState.source?.color ?? null,
    footprintCount: world.bloodyFootprints.length,
    footprintColor: world.bloodyFootprints[0]?.color ?? null,
  };
}

/**
 * Walks the player due east through the REAL visual simulation pipeline and
 * returns every footprint it laid, ordered along the path.
 */
function walkStraightLineTrail() {
  const world = createTestWorld({ seed: 13 });
  const playerEid = spawnPlayer(world, 0, 0);
  const enemyEid = spawnEnemy(world, 0, 0, 10, 120, GREEN_BLOOD);
  setComponent(world.ecs, enemyEid, Health, { current: 0, max: 10 });

  runVisualFrame(world);
  for (let frame = 0; frame < WALK_FRAMES; frame += 1) {
    world.stores.position.x[playerEid] = (frame + 1) * WALK_STEP_FT;
    runVisualFrame(world);
  }

  return [...world.bloodyFootprints].sort((a, b) => a.x - b.x);
}

describe('bloody footprints pipeline wiring', () => {
  it('runs in both visual and headless simulation wrappers', () => {
    const visual = summarizeWithVisualPipeline();
    const headless = summarizeWithHeadlessPipeline();

    expect(visual.poolCount).toBe(1);
    expect(visual.sourceColor).toBe(GREEN_BLOOD);
    expect(visual.footprintCount).toBeGreaterThan(0);
    expect(visual.footprintColor).toBe(GREEN_BLOOD);
    expect(visual).toEqual(headless);
  });

  // Regression gate for the sprite-recalibration bug: the constants were tuned
  // for the retired 3.2 ft Kenney knight, so stride spacing (0.42 ft) was
  // SHORTER than a single print (0.52-0.64 ft) and consecutive prints
  // physically overlapped into a continuous streak instead of reading as
  // discrete alternating steps under the 5.2 ft `rhea-vale-v1` player.
  it('lays discrete, non-overlapping prints along a straight walk', () => {
    const trail = walkStraightLineTrail();

    expect(trail.length).toBeGreaterThan(2);

    // Heading is due east, so each print occupies
    // [x - heelRadiusXFt, x + toeOffsetFt + toeRadiusXFt] along the path.
    for (let i = 1; i < trail.length; i += 1) {
      const previous = trail[i - 1]!;
      const current = trail[i]!;
      const previousFrontEdge =
        previous.x + previous.toeOffsetFt + previous.toeRadiusXFt + previous.smearLengthFt;
      const currentBackEdge = current.x - current.heelRadiusXFt;
      expect(currentBackEdge).toBeGreaterThan(previousFrontEdge);
    }
  });

  it('alternates prints to either side of the path so the track reads as two feet', () => {
    const trail = walkStraightLineTrail();
    const sides = trail.map((footprint) => Math.sign(footprint.y));

    for (let i = 1; i < sides.length; i += 1) {
      expect(sides[i]).toBe(-sides[i - 1]!);
    }
    // Track width must be wide enough that the two rows are visually distinct
    // rather than a single smudged line down the centre.
    const trackWidthFt = Math.max(...trail.map((f) => Math.abs(f.y))) * 2;
    expect(trackWidthFt).toBeGreaterThan(BLOODY_FOOTPRINT_EMIT_DISTANCE_FT * 0.25);
  });
});
