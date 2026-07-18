import { describe, expect, it, vi } from 'vitest';
import { createTestWorld } from '../helpers/world-factory.js';
import { ftToPx } from '../../src/shared/units.js';
import { createMobAbilityVfx } from '../../src/engine/MobAbilityVfx.js';
import { applyStatusEffect, spawnPlayer } from '../../src/core/index.js';

function createGraphicsStub() {
  return {
    clear: vi.fn(),
    lineStyle: vi.fn(),
    fillStyle: vi.fn(),
    strokeCircle: vi.fn(),
    fillCircle: vi.fn(),
    lineBetween: vi.fn(),
    setDepth: vi.fn().mockReturnThis(),
    setBlendMode: vi.fn().mockReturnThis(),
    destroy: vi.fn(),
  };
}

function createCircleStub() {
  return {
    setStrokeStyle: vi.fn().mockReturnThis(),
    setFillStyle: vi.fn().mockReturnThis(),
    setDepth: vi.fn().mockReturnThis(),
    setBlendMode: vi.fn().mockReturnThis(),
    destroy: vi.fn(),
  };
}

function createSceneStub() {
  const circles: Array<{ x: number; y: number; r: number }> = [];
  const graphicsObjects: ReturnType<typeof createGraphicsStub>[] = [];
  const scene = {
    add: {
      graphics: vi.fn(() => {
        const gfx = createGraphicsStub();
        graphicsObjects.push(gfx);
        return gfx;
      }),
      circle: vi.fn((x: number, y: number, r: number) => {
        circles.push({ x, y, r });
        return createCircleStub();
      }),
    },
    tweens: {
      add: vi.fn((config: { onComplete?: () => void }) => {
        config.onComplete?.();
        return { remove: vi.fn() };
      }),
    },
    cameras: { getCamera: vi.fn(() => null) },
  };
  return {
    scene: scene as unknown as Parameters<typeof createMobAbilityVfx>[0],
    circles,
    graphicsObjects,
  };
}

function mockInstance() {
  return {
    definition: {
      abilityId: 'queen-mab-verdigris-glamour',
      bossArchetypeKey: 'faerie-boss',
      firstEligibleAfterMs: 9000,
      cooldownMs: 9000,
      telegraphDurationMs: 1500,
      dangerColor: 'hostile-red',
      announcementText: 'VERDIGRIS GLAMOUR — All that glitters will corrode!',
      geometry: { kind: 'circle', radiusFt: 12 },
      resolve: vi.fn(),
    },
    phase: 'telegraph',
    timerMs: 1000,
    committedGeometry: { kind: 'circle', x: 40, y: 40, radiusFt: 12 },
    committedTargetEid: 1,
    resolvedCasts: 0,
    announcementsEmitted: 1,
    registrationToken: 1,
  } as const;
}

describe('MobAbilityVfx', () => {
  it('draws the exact committed telegraph geometry footprint', () => {
    const { scene, graphicsObjects } = createSceneStub();
    const world = createTestWorld();
    world.mobAbilities.cues.push({
      abilityId: 'queen-mab-verdigris-glamour',
      casterEid: 7,
      phase: 'telegraph',
      telegraphProgress: 0.5,
      geometry: { kind: 'circle', x: 40, y: 40, radiusFt: 12 },
      dangerColor: 'hostile-red',
      announcementText: 'VERDIGRIS GLAMOUR — All that glitters will corrode!',
    });
    world.mobAbilities.byEntity.set(7, mockInstance());

    const vfx = createMobAbilityVfx(scene);
    vfx.update(world);

    const telegraphGfx = graphicsObjects[0];
    expect(telegraphGfx).toBeDefined();
    expect(telegraphGfx!.strokeCircle).toHaveBeenCalledWith(ftToPx(40), ftToPx(40), ftToPx(12));
  });

  it('uses cached tarnish coordinates for cleanup poof when entity position no longer exists', () => {
    const { scene, circles } = createSceneStub();
    const world = createTestWorld();
    const player = spawnPlayer(world, 10, 20);

    applyStatusEffect(world, player, {
      stat: 'speed',
      op: 'multiply',
      value: 0.7,
      durationMs: 4000,
      sourceType: 'ability',
      sourceId: 'mob-ability:queen-mab-verdigris-glamour:42',
      stackRule: { mode: 'replace' },
    });

    const vfx = createMobAbilityVfx(scene);
    vfx.update(world); // cache tarnish position

    world.statusEffectsByEntity.delete(player);
    world.stores.position.x[player] = 0;
    world.stores.position.y[player] = 0;
    vfx.update(world); // retire + cleanup poof

    const cleanupPoof = circles[circles.length - 1];
    expect(cleanupPoof).toBeDefined();
    expect(cleanupPoof!.x).toBe(ftToPx(10));
    expect(cleanupPoof!.y).toBe(ftToPx(20));
  });
});
