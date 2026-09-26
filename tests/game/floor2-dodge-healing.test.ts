import { describe, expect, it } from 'vitest';
import { spawnBehaviorEnemy, spawnPlayer, spawnDroppedItem } from '../../src/core/helpers.js';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runSimulationStep } from '../../src/game/ai/simulation-step.js';
import { AI_TYPE } from '../../src/game/enemyAISystem.js';
import { setActiveWeapon, weaponSystem } from '../../src/game/weaponSystem.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { getItemIndex } from '../../src/shared/items.js';
import { createInputState } from '../../src/shared/input.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { getBodyRadius } from '../../src/core/physics-body.js';
import { makeWalledMap } from '../helpers/map-fixtures.js';
import { hasClearLineOfSight } from '../../src/game/ai/bt-ai-geometry.js';
import { spawnEnemyProjectile } from '../../src/core/spawners/projectiles.js';
import type { MobAbilityGeometry } from '../../src/core/mob-abilities/types.js';

function fixture(x = 3, y = 0) {
  const world = createTestWorld({ seed: 42, floor: 2 });
  world.floorId = 'floor2';
  world.elapsedMs = 5000;
  const player = spawnPlayer(world, x, y);
  // Pursuit points inward, directly opposing the required circle escape.
  spawnBehaviorEnemy(world, -20, 0, 1000, AI_TYPE.RANGED, 0, 200, 160);
  setActiveWeapon(world, getWeaponDef('sword')!);
  const ai = new BehaviorTreeAI({ seed: 42 });
  return { world, player, ai };
}

describe('Floor 2 final-input safety', () => {
  it.each([
    { kind: 'annulus', x: 0, y: 0, innerRadiusFt: 6, outerRadiusFt: 15 },
    {
      kind: 'sweeping-arc',
      originX: 0,
      originY: 0,
      facingRad: Math.PI,
      angleDeg: 100,
      rangeFt: 14,
      sweepAngleDeg: 360,
      direction: -1,
    },
    {
      kind: 'composite',
      shapes: [
        {
          kind: 'lane',
          originX: -5,
          originY: -20,
          endX: -5,
          endY: 20,
          dirX: 0,
          dirY: 1,
          widthFt: 6,
          lengthFt: 40,
        },
        { kind: 'circle', x: 0, y: 0, radiusFt: 14 },
      ],
    },
  ] satisfies MobAbilityGeometry[])('escapes the new $kind public footprint', (geometry) => {
    const { world, ai } = fixture(13);
    world.mobAbilities.cues.push({
      abilityId: 'new-signature',
      casterEid: 99,
      phase: 'telegraph',
      telegraphProgress: 0.5,
      geometry,
      dangerColor: 'hostile-red',
      announcementText: 'Dodge',
    });
    const input = createInputState();
    ai.poll(input, world);
    expect(input.moveX).toBeGreaterThan(0.9);
  });

  it('dodges a persistent fire lane after its telegraph disappears', () => {
    const { world, ai } = fixture(8, 0.5);
    world.mobAbilities.ownedZones.push({
      id: 0,
      abilityId: 'fire',
      casterEid: 99,
      sourceId: 'fire',
      durationMs: 4000,
      tickIntervalMs: 500,
      elapsedMs: 1000,
      nextTickAtMs: 1500,
      tick: () => {},
      geometry: {
        kind: 'lane',
        originX: 0,
        originY: 0,
        endX: 30,
        endY: 0,
        dirX: 1,
        dirY: 0,
        lengthFt: 30,
        widthFt: 6,
      },
    });
    const input = createInputState();
    ai.poll(input, world);
    expect(input.moveY).toBeGreaterThan(0.9);
  });

  it('approaches a large boss diagonally and lands melee hits without contact damage', () => {
    const world = createTestWorld({ seed: 42, floor: 2 });
    world.floorId = 'floor2';
    world.elapsedMs = 5000;
    const player = spawnPlayer(world, 12, 12);
    const boss = spawnBehaviorEnemy(world, 0, 0, 1000, AI_TYPE.CHASE, 0, 200, 0);
    world.stores.size.radius[boss] = 6;
    world.stores.size.halfWidth[boss] = 0;
    world.stores.size.halfHeight[boss] = 0;
    setActiveWeapon(world, getWeaponDef('sword')!);
    const ai = new BehaviorTreeAI({ seed: 42 });
    const initialHP = world.stores.health.current[player];
    for (let frame = 0; frame < 180; frame++) {
      const input = createInputState();
      ai.poll(input, world);
      runSimulationStep(world, input, 1000 / 60, { preSystems: [weaponSystem] });
    }
    expect(world.stores.health.current[player]).toBe(initialHP);
    expect(world.stores.health.current[boss]).toBeLessThan(1000);
  });

  it('does not approach through the contact AABB corner of a circular boss', () => {
    const { world, ai } = fixture(6, 6);
    const boss = spawnBehaviorEnemy(world, 0, 0, 1000, AI_TYPE.CHASE, 0, 200, 0);
    world.stores.size.radius[boss] = 6;
    world.stores.size.halfWidth[boss] = 0;
    world.stores.size.halfHeight[boss] = 0;
    const input = createInputState();
    ai.poll(input, world);
    expect(Math.max(input.moveX, input.moveY)).toBeGreaterThan(0.1);
    expect(Math.hypot(input.moveX, input.moveY)).toBeGreaterThan(0);
  });

  it('uses an open projectile escape when the preferred side is walled', () => {
    const { world, ai } = fixture(18, 14);
    world.floorMap = makeWalledMap({ tileSizeFt: 4 });
    spawnEnemyProjectile(world, 17.75, 6, 0, 0.5, 8);
    const input = createInputState();
    ai.poll(input, world);
    expect(input.moveX).toBeLessThan(-0.9);
  });

  it('uses the open side of a telegraphed lane when the closest side is walled', () => {
    const { world, ai } = fixture(18, 14);
    world.floorMap = makeWalledMap({ tileSizeFt: 4 });
    world.mobAbilities.cues.push({
      abilityId: 'wall-lane',
      casterEid: 99,
      phase: 'telegraph',
      telegraphProgress: 0.5,
      geometry: {
        kind: 'lane',
        originX: 17.75,
        originY: 4,
        endX: 17.75,
        endY: 30,
        dirX: 0,
        dirY: 1,
        widthFt: 2,
        lengthFt: 26,
      },
      dangerColor: 'hostile-red',
      announcementText: 'Lane',
    });
    const input = createInputState();
    ai.poll(input, world);
    expect(input.moveX).toBeLessThan(-0.9);
  });

  it('does not let an overlapping circle reverse a lane escape', () => {
    const { world, ai } = fixture(8, 0.25);
    world.mobAbilities.cues.push(
      {
        abilityId: 'lane',
        casterEid: 99,
        phase: 'telegraph',
        telegraphProgress: 0.5,
        geometry: {
          kind: 'lane',
          originX: 0,
          originY: 0,
          endX: 20,
          endY: 0,
          dirX: 1,
          dirY: 0,
          widthFt: 2,
          lengthFt: 20,
        },
        dangerColor: 'hostile-red',
        announcementText: 'Lane',
      },
      {
        abilityId: 'circle',
        casterEid: 99,
        phase: 'telegraph',
        telegraphProgress: 0.5,
        geometry: { kind: 'circle', x: 8, y: 5, radiusFt: 8 },
        dangerColor: 'hostile-red',
        announcementText: 'Circle',
      },
    );
    const input = createInputState();
    ai.poll(input, world);
    expect(input.moveY).toBeGreaterThan(0.9);
  });

  it('finds a joint escape from two overlapping enemy bodies', () => {
    const { world, ai } = fixture(0);
    for (const x of [-5, 5]) {
      const enemy = spawnBehaviorEnemy(world, x, 0, 1000, AI_TYPE.CHASE, 0, 200, 0);
      world.stores.size.radius[enemy] = 6;
      world.stores.size.halfWidth[enemy] = 0;
      world.stores.size.halfHeight[enemy] = 0;
    }
    const input = createInputState();
    ai.poll(input, world);
    expect(Math.abs(input.moveX)).toBeLessThan(0.01);
    expect(Math.abs(input.moveY)).toBeGreaterThan(0.9);
  });

  it('escapes along a wall instead of being pushed into it by a large body', () => {
    const { world, ai } = fixture(18, 14);
    world.floorMap = makeWalledMap({ tileSizeFt: 4 });
    const enemy = spawnBehaviorEnemy(world, 13, 14, 1000, AI_TYPE.CHASE, 0, 200, 0);
    world.stores.size.radius[enemy] = 6;
    world.stores.size.halfWidth[enemy] = 0;
    world.stores.size.halfHeight[enemy] = 0;
    world.mobAbilities.cues.push({
      abilityId: 'wall-circle',
      casterEid: enemy,
      phase: 'telegraph',
      telegraphProgress: 0.5,
      geometry: { kind: 'circle', x: 13, y: 14, radiusFt: 8 },
      dangerColor: 'hostile-red',
      announcementText: 'Danger',
    });
    const input = createInputState();
    ai.poll(input, world);
    expect(Math.hypot(input.moveX, input.moveY)).toBeGreaterThan(0.9);
    expect(
      hasClearLineOfSight(world.floorMap, 18, 14, 18 + input.moveX * 3.5, 14 + input.moveY * 3.5),
    ).toBe(true);
    expect(input.moveX).toBeGreaterThanOrEqual(-0.01);
  });

  it('escapes overlapping circles without bouncing between their centers', () => {
    const { world, ai } = fixture(0);
    world.mobAbilities.cues.push({
      abilityId: 'overlapping-circles',
      casterEid: 99,
      phase: 'telegraph',
      telegraphProgress: 0.5,
      geometry: {
        kind: 'multi-circle',
        circles: [
          { kind: 'circle', x: -2, y: 0, radiusFt: 4 },
          { kind: 'circle', x: 2, y: 0, radiusFt: 4 },
        ],
      },
      dangerColor: 'hostile-red',
      announcementText: 'Danger',
    });
    const input = createInputState();
    ai.poll(input, world);
    expect(Math.abs(input.moveY)).toBeGreaterThan(0.9);
    expect(Math.abs(input.moveX)).toBeLessThan(0.1);
  });

  it('escapes a telegraph at full speed despite inward pursuit and previous smoothing', () => {
    const { world, player, ai } = fixture();
    const input = createInputState();
    ai.poll(input, world);
    world.mobAbilities.cues.push({
      abilityId: 'queen-mab-verdigris-glamour',
      casterEid: 99,
      phase: 'telegraph',
      telegraphProgress: 0.5,
      geometry: { kind: 'circle', x: 0, y: 0, radiusFt: 12 },
      dangerColor: 'hostile-red',
      announcementText: 'VERDIGRIS GLAMOUR',
    });
    ai.poll(input, world);
    expect(input.moveX).toBeCloseTo(1);
    expect(input.moveY).toBeCloseTo(0);
    const before = world.stores.position.x[player]!;
    runSimulationStep(world, input, 1000 / 60);
    expect(world.stores.position.x[player]).toBeGreaterThan(before);
  });

  it('continues escaping when only the player body overlaps the circle', () => {
    const { world, ai } = fixture(12.5);
    world.mobAbilities.cues.push({
      abilityId: 'queen-mab-verdigris-glamour',
      casterEid: 99,
      phase: 'telegraph',
      telegraphProgress: 0.5,
      geometry: { kind: 'circle', x: 0, y: 0, radiusFt: 12 },
      dangerColor: 'hostile-red',
      announcementText: 'VERDIGRIS GLAMOUR',
    });
    const input = createInputState();
    ai.poll(input, world);
    expect(input.moveX).toBeCloseTo(1);
  });

  it.each([-0.25, 0.25])('dodges away from the spoke centerline at y=%s', (y) => {
    const { world, ai } = fixture(8, y);
    world.mobAbilities.cues.push({
      abilityId: 'spokes',
      casterEid: 99,
      phase: 'telegraph',
      telegraphProgress: 0.5,
      geometry: {
        kind: 'radial-projectiles',
        casterX: 0,
        casterY: 0,
        count: 8,
        offsetDeg: 0,
        spokeLengthFt: 20,
      },
      dangerColor: 'hostile-red',
      announcementText: 'Spokes',
    });
    const input = createInputState();
    ai.poll(input, world);
    expect(input.moveY * y).toBeGreaterThan(0);
  });

  it('moves out of a large enemy body instead of pursuing its center', () => {
    const { world, player, ai } = fixture(0);
    const boss = spawnBehaviorEnemy(world, 5, 0, 1000, AI_TYPE.CHASE, 0, 200, 0);
    world.stores.size.radius[boss] = 6;
    world.stores.size.halfWidth[boss] = 0;
    world.stores.size.halfHeight[boss] = 0;
    const input = createInputState();
    ai.poll(input, world);
    expect(input.moveX).toBeLessThan(0);
    const before = Math.abs(world.stores.position.x[player]! - 5);
    runSimulationStep(world, input, 1000 / 60);
    expect(Math.abs(world.stores.position.x[player]! - 5)).toBeGreaterThan(before);
    expect(getBodyRadius(world, boss)).toBe(6);
  });

  it('does not target a potion at full health, but can collect it when wounded', () => {
    const world = createTestWorld({ seed: 42, floor: 2 });
    world.floorId = 'floor2';
    const player = spawnPlayer(world, 0, 0);
    const potion = spawnDroppedItem(world, 4, 0, getItemIndex('health-vial'));
    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);
    expect(ai.getDecision().targetEid).not.toBe(potion);
    world.stores.health.current[player] = world.stores.health.max[player]! / 2;
    ai.poll(createInputState(), world);
    expect(ai.getDecision().targetEid).toBe(potion);
  });
});
