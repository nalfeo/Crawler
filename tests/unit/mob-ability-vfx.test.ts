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

function createShapeStub() {
  return {
    setAngle: vi.fn().mockReturnThis(),
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
      rectangle: vi.fn(() => createShapeStub()),
      ellipse: vi.fn(() => createShapeStub()),
    },
    tweens: {
      add: vi.fn((config: { onComplete?: () => void }) => {
        config.onComplete?.();
        return { stop: vi.fn(), remove: vi.fn() };
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
    committedTargetGeneration: null,
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

  it('draws the Tarnished indicator ring for debuffed entities', () => {
    const { scene, graphicsObjects } = createSceneStub();
    const world = createTestWorld();
    const player = spawnPlayer(world, 30, 25);

    applyStatusEffect(world, player, {
      stat: 'speed',
      op: 'multiply',
      value: 0.7,
      durationMs: 4000,
      sourceType: 'ability',
      sourceId: 'mob-ability:queen-mab-verdigris-glamour:7',
      stackRule: { mode: 'replace' },
    });

    const vfx = createMobAbilityVfx(scene);
    vfx.update(world);

    // A graphics object must be created for the Tarnished indicator.
    expect(graphicsObjects.length).toBeGreaterThan(0);
    const tarnishGfx = graphicsObjects[0]!;
    // The Tarnished ring is drawn centred on the entity's pixel position.
    expect(tarnishGfx.strokeCircle).toHaveBeenCalledWith(ftToPx(30), ftToPx(25), ftToPx(1.4));
  });

  it('fires a resolution burst when a geometry is enqueued in pendingBursts', () => {
    const { scene, circles } = createSceneStub();
    const world = createTestWorld();
    const inst = { ...mockInstance(), resolvedCasts: 0 };
    world.mobAbilities.byEntity.set(7, inst);
    // Give the caster a last-known geometry via a telegraph cue first.
    world.mobAbilities.cues.push({
      abilityId: 'queen-mab-verdigris-glamour',
      casterEid: 7,
      phase: 'telegraph',
      telegraphProgress: 1,
      geometry: { kind: 'circle', x: 40, y: 40, radiusFt: 12 },
      dangerColor: 'hostile-red',
      announcementText: 'VERDIGRIS GLAMOUR — All that glitters will corrode!',
    });
    const vfx = createMobAbilityVfx(scene);
    vfx.update(world); // prime lastGeom

    const circlesBeforeBurst = circles.length;

    // Simulate resolution: runtime pushes committed geometry to pendingBursts
    // (instead of the old resolvedCasts polling which broke when byEntity was
    // cleared before PhaserBridge.sync ran).
    world.mobAbilities.cues.length = 0;
    world.mobAbilities.pendingBursts.push({ kind: 'circle', x: 40, y: 40, radiusFt: 12 });
    vfx.update(world);

    // Resolution burst emits rings (circles/tweened objects).
    expect(circles.length).toBeGreaterThan(circlesBeforeBurst);
  });

  it('retires telegraph graphics when the cue ends', () => {
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
    vfx.update(world); // telegraph graphics created

    const telegraphGfx = graphicsObjects[0]!;
    expect(telegraphGfx.destroy).not.toHaveBeenCalled();

    // Cue ends (e.g. resolution) — next update should destroy the graphic.
    world.mobAbilities.cues.length = 0;
    world.mobAbilities.byEntity.delete(7);
    vfx.update(world);

    expect(telegraphGfx.destroy).toHaveBeenCalled();
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

  it('emits deterministic berserk motif shapes for active bamboo-fed buffs', () => {
    const { scene } = createSceneStub();
    const world = createTestWorld();
    const eid = spawnPlayer(world, 15, 15);
    world.frameCount = 12;
    world.mobAbilities.activeBuffsByEntity.set(eid, {
      abilityId: 'big-panda-wei-bamboo-fed-berserk',
      sourceId: 'mob-ability:big-panda-wei-bamboo-fed-berserk:1',
      remainingMs: 3000,
      movementSpeedMultiplier: 1.4,
      meleeDamageMultiplier: 1.4,
      knockbackResistanceMultiplier: 0.35,
      auraRadiusFt: 10,
    });

    const vfx = createMobAbilityVfx(scene);
    vfx.update(world);

    expect(scene.add.rectangle).toHaveBeenCalled();
    expect(scene.add.ellipse).toHaveBeenCalled();
  });
});
