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
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    fillPath: vi.fn(),
    strokeCircle: vi.fn(),
    fillCircle: vi.fn(),
    fillPoints: vi.fn(),
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
    ownedEntityGenerations: new Map<number, number>(),
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

  it('draws each committed spawn-circle in a multi-circle telegraph', () => {
    const { scene, graphicsObjects } = createSceneStub();
    const world = createTestWorld();
    world.mobAbilities.cues.push({
      abilityId: 'plague-boss-squick-undercity-mob-call',
      casterEid: 11,
      phase: 'telegraph',
      telegraphProgress: 0.25,
      geometry: {
        kind: 'spawn-circles',
        circles: [
          { kind: 'circle', x: 32, y: 32, radiusFt: 4 },
          { kind: 'circle', x: 40, y: 32, radiusFt: 4 },
          { kind: 'circle', x: 36, y: 39, radiusFt: 4 },
        ],
      },
      dangerColor: 'hostile-red',
      announcementText: 'UNDERCITY MOB CALL — The guild always collects!',
    });
    world.mobAbilities.byEntity.set(11, mockInstance());

    const vfx = createMobAbilityVfx(scene);
    vfx.update(world);

    const telegraphGfx = graphicsObjects[0];
    expect(telegraphGfx).toBeDefined();
    expect(telegraphGfx!.strokeCircle).toHaveBeenCalledTimes(3);
  });

  it('draws committed lane telegraphs using the same locked endpoints', () => {
    const { scene, graphicsObjects } = createSceneStub();
    const world = createTestWorld();
    world.mobAbilities.cues.push({
      abilityId: 'big-mama-bufo-tongue-repossession',
      casterEid: 19,
      phase: 'telegraph',
      telegraphProgress: 0.4,
      geometry: {
        kind: 'lane',
        originX: 10,
        originY: 20,
        endX: 30,
        endY: 20,
        dirX: 1,
        dirY: 0,
        widthFt: 3,
        lengthFt: 20,
      },
      dangerColor: 'ability-theme',
      announcementText: "TONGUE REPOSSESSION — Big Mama wants what's hers!",
    });
    world.mobAbilities.byEntity.set(19, mockInstance());

    const vfx = createMobAbilityVfx(scene);
    vfx.update(world);

    const telegraphGfx = graphicsObjects[0];
    expect(telegraphGfx).toBeDefined();
    expect(telegraphGfx!.beginPath).toHaveBeenCalledTimes(1);
    expect(telegraphGfx!.moveTo).toHaveBeenCalledWith(ftToPx(10), ftToPx(21.5));
    expect(telegraphGfx!.lineTo).toHaveBeenCalledWith(ftToPx(30), ftToPx(21.5));
    expect(telegraphGfx!.lineTo).toHaveBeenCalledWith(ftToPx(30), ftToPx(18.5));
    expect(telegraphGfx!.lineTo).toHaveBeenCalledWith(ftToPx(10), ftToPx(18.5));
    expect(telegraphGfx!.closePath).toHaveBeenCalledTimes(1);
    expect(telegraphGfx!.fillPath).toHaveBeenCalledTimes(1);
    expect(telegraphGfx!.fillStyle).toHaveBeenCalledWith(0x59c36a, expect.any(Number));
    expect(telegraphGfx!.lineBetween).toHaveBeenCalled();
  });

  it('draws Don Paco projectile-fan telegraphs with five landing circles and path lines', () => {
    const { scene, graphicsObjects } = createSceneStub();
    const world = createTestWorld();
    world.mobAbilities.cues.push({
      abilityId: 'don-paco-the-big-gob',
      casterEid: 14,
      phase: 'telegraph',
      telegraphProgress: 0.5,
      geometry: {
        kind: 'projectile-fan',
        originX: 40,
        originY: 10,
        facingRad: Math.PI / 2,
        coneAngleDeg: 70,
        rangeFt: 30,
        paths: [
          {
            kind: 'projectile-path',
            startX: 40,
            startY: 10,
            endX: 22.79,
            endY: 34.57,
            impactRadiusFt: 3,
          },
          {
            kind: 'projectile-path',
            startX: 40,
            startY: 10,
            endX: 30.99,
            endY: 38.61,
            impactRadiusFt: 3,
          },
          {
            kind: 'projectile-path',
            startX: 40,
            startY: 10,
            endX: 40,
            endY: 40,
            impactRadiusFt: 3,
          },
          {
            kind: 'projectile-path',
            startX: 40,
            startY: 10,
            endX: 49.01,
            endY: 38.61,
            impactRadiusFt: 3,
          },
          {
            kind: 'projectile-path',
            startX: 40,
            startY: 10,
            endX: 57.21,
            endY: 34.57,
            impactRadiusFt: 3,
          },
        ],
      },
      dangerColor: 'hostile-red',
      announcementText: "THE BIG GOB — Don Paco's painting the whole block!",
    });
    world.mobAbilities.byEntity.set(14, mockInstance());

    const vfx = createMobAbilityVfx(scene);
    vfx.update(world);

    const telegraphGfx = graphicsObjects[0];
    expect(telegraphGfx).toBeDefined();
    expect(telegraphGfx!.strokeCircle).toHaveBeenCalledTimes(5);
    expect(telegraphGfx!.lineBetween).toHaveBeenCalled();
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
    world.mobAbilities.pendingBursts.push({
      abilityId: 'queen-mab-verdigris-glamour',
      geometry: { kind: 'circle', x: 40, y: 40, radiusFt: 12 },
    });
    vfx.update(world);

    // Resolution burst emits rings (circles/tweened objects).
    expect(circles.length).toBeGreaterThan(circlesBeforeBurst);
  });

  it('dispatches Squick bursts through the undercity-specific renderer path', () => {
    const { scene, circles } = createSceneStub();
    const world = createTestWorld();
    const vfx = createMobAbilityVfx(scene);

    world.mobAbilities.pendingBursts.push({
      abilityId: 'queen-mab-verdigris-glamour',
      geometry: { kind: 'circle', x: 40, y: 40, radiusFt: 12 },
    });
    vfx.update(world);
    const genericCircleCount = circles.length;

    world.mobAbilities.pendingBursts.push({
      abilityId: 'plague-boss-squick-undercity-mob-call',
      geometry: { kind: 'circle', x: 42, y: 39, radiusFt: 12 },
    });
    vfx.update(world);
    const undercityCircleCount = circles.length - genericCircleCount;

    expect(undercityCircleCount).toBeGreaterThan(genericCircleCount);
  });

  it('renders Tongue Repossession lane bursts through the dedicated committed-lane VFX path', () => {
    const { scene, circles } = createSceneStub();
    const world = createTestWorld();
    const vfx = createMobAbilityVfx(scene);
    const laneGeometry = {
      kind: 'lane' as const,
      originX: 10,
      originY: 10,
      endX: 20,
      endY: 10,
      dirX: 1,
      dirY: 0,
      widthFt: 3,
      lengthFt: 10,
    };

    world.mobAbilities.pendingBursts.push({
      abilityId: 'queen-mab-verdigris-glamour',
      geometry: laneGeometry,
    });
    vfx.update(world);
    const genericLaneBurstCircleCount = circles.length;

    world.mobAbilities.pendingBursts.push({
      abilityId: 'big-mama-bufo-tongue-repossession',
      geometry: laneGeometry,
    });
    vfx.update(world);
    const tongueLaneBurstCircleCount = circles.length - genericLaneBurstCircleCount;

    expect(tongueLaneBurstCircleCount).toBeGreaterThan(0);
    expect(scene.add.rectangle).toHaveBeenCalled();
    expect(scene.add.ellipse).toHaveBeenCalled();
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

  it('draws persistent sovereign cloud rims for runtime-owned zones', () => {
    const { scene, graphicsObjects } = createSceneStub();
    const world = createTestWorld();
    world.mobAbilities.ownedZones.push({
      id: 42,
      abilityId: 'sovereign-cap-spore-bloom',
      casterEid: 9,
      sourceId: 'mob-ability:sovereign-cap-spore-bloom:9',
      geometry: {
        kind: 'multi-circle',
        circles: [
          { kind: 'circle', x: 30, y: 30, radiusFt: 8 },
          { kind: 'circle', x: 35, y: 28, radiusFt: 8 },
          { kind: 'circle', x: 25, y: 28, radiusFt: 8 },
        ],
      },
      durationMs: 4000,
      tickIntervalMs: 500,
      elapsedMs: 1500,
      nextTickAtMs: 2000,
      tick: () => {},
    });
    const vfx = createMobAbilityVfx(scene);
    vfx.update(world);
    const cloudGfx = graphicsObjects[0]!;
    expect(cloudGfx.strokeCircle).toHaveBeenCalledWith(ftToPx(30), ftToPx(30), ftToPx(8));
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

  it('draws persistent slick rims for active Don Paco zones', () => {
    const { scene, graphicsObjects } = createSceneStub();
    const world = createTestWorld();
    world.mobAbilities.activeZones.push({
      abilityId: 'don-paco-the-big-gob',
      casterEid: 5,
      sourceId: 'mob-ability:don-paco-the-big-gob:5:slick',
      circle: { kind: 'circle', x: 30, y: 35, radiusFt: 3 },
      remainingMs: 4000,
      slowMultiplier: 0.65,
    });

    const vfx = createMobAbilityVfx(scene);
    vfx.update(world);

    const slick = graphicsObjects[0];
    expect(slick).toBeDefined();
    expect(slick!.strokeCircle).toHaveBeenCalledWith(ftToPx(30), ftToPx(35), ftToPx(3));
  });
});
