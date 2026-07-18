import { describe, expect, it } from 'vitest';
import { createPlayerTrailVfx } from '../../src/engine/PlayerTrailVfx.js';
import { createBloodFootprintSurface } from '../../src/shared/blood-surfaces.js';
import { createSceneStub } from '../fixtures/phaser-bridge-harness.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('PlayerTrailVfx', () => {
  it('fades authoritative footprints from sim time even when render time is ahead', () => {
    const { scene, graphics } = createSceneStub({ withGraphics: true });
    Object.assign(scene as object, { cameras: { getCamera: () => null } });
    const vfx = createPlayerTrailVfx(scene);
    const world = createTestWorld({ seed: 42 });

    world.elapsedMs = 1000;
    world.bloodyFootprints.push(
      createBloodFootprintSurface({
        worldSeed: world.seed,
        footprintId: world.bloodyFootprintState.nextFootprintId++,
        stampId: world.bloodyFootprintState.nextStampId++,
        color: 0xaa2233,
        fromX: 0,
        fromY: 0,
        toX: 0.42,
        toY: 0,
        createdAtMs: world.elapsedMs,
      }),
    );

    vfx.update(world, world.elapsedMs + 4_000);

    expect(graphics).toHaveLength(1);
    expect(graphics[0]!.alpha).toBeCloseTo(0.58);

    world.elapsedMs = 1000 + 2_500;
    vfx.update(world, world.elapsedMs + 4_000);

    expect(graphics[0]!.alpha).toBeCloseTo(0.29);
  });
});
