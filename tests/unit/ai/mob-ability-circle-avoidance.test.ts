import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import {
  createClockworkKillSawDefinition,
  createDonPacoBigGobDefinition,
  createVerdigrisGlamourDefinition,
  spawnBehaviorEnemy,
} from '../../../src/core/index.js';
import { spawnPlayer } from '../../../src/core/spawners/combatants.js';
import { createInputState } from '../../../src/shared/input.js';
import { getWeaponDef } from '../../../src/shared/weaponDefs.js';
import { createTestWorld } from '../../helpers/world-factory.js';
import { AI_TYPE } from '../../../src/game/enemyAISystem.js';
import { setActiveWeapon } from '../../../src/game/weaponSystem.js';
import {
  initializeFloor1Scenario,
  selectFloor1StarterWeapon,
} from '../../../src/game/floorScenario.js';

describe('BehaviorTreeAI mob-ability circle avoidance', () => {
  it('treats the exact telegraph boundary as dangerous and dodges outward', () => {
    const world = createTestWorld({ seed: 42 });
    world.elapsedMs = 5000;
    const player = spawnPlayer(world, 12, 0);
    world.stores.position.x[player] = 12;
    world.stores.position.y[player] = 0;
    spawnBehaviorEnemy(world, 20, 0, 40, AI_TYPE.RANGED, 5, 200, 160);
    setActiveWeapon(world, getWeaponDef('sword')!);
    const def = createVerdigrisGlamourDefinition();
    world.mobAbilities.cues.push({
      abilityId: def.abilityId,
      casterEid: 99,
      phase: 'telegraph',
      telegraphProgress: 0.5,
      geometry: { kind: 'circle', x: 0, y: 0, radiusFt: 12 },
      dangerColor: def.dangerColor,
      announcementText: def.announcementText,
    });

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);

    const debug = ai.getOpportunisticDebug();
    expect(debug.dodgeX).toBeGreaterThan(0);
    expect(debug.dodgeY).toBeCloseTo(0, 10);
  });

  it('treats a committed lane as dangerous and dodges sideways out of it', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 1);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    world.stores.position.x[player] = 0;
    world.stores.position.y[player] = 1;
    const def = createClockworkKillSawDefinition();
    world.mobAbilities.cues.push({
      abilityId: def.abilityId,
      casterEid: 99,
      phase: 'telegraph',
      telegraphProgress: 0.5,
      geometry: {
        kind: 'lane',
        originX: -16,
        originY: 0,
        endX: 16,
        endY: 0,
        dirX: 1,
        dirY: 0,
        widthFt: 6,
        lengthFt: 32,
      },
      dangerColor: def.dangerColor,
      announcementText: def.announcementText,
    });

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);

    const debug = ai.getOpportunisticDebug();
    expect(debug.dodgeX).toBeCloseTo(0, 10);
    expect(Math.abs(debug.dodgeY)).toBeGreaterThan(0);
  });

  it('keeps dodging a lane that is already in its active damaging phase', () => {
    // Regression: travel steering used to wipe the mob-ability dodge vector for
    // any cue whose phase was not `telegraph`. The Clockwork Kill-Saw stays lethal
    // through `outbound`/`hold`/`return`, so the AI would walk into the moving blade
    // the instant the telegraph ended.
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);

    const ai = new BehaviorTreeAI({ seed: 42 });
    const input = createInputState();
    // Warm-up poll: put the AI into quest-navigation EXPLORE with a real heading
    // so predictive travel steering (not the raw objective heading) drives the
    // next poll — that is the only path that can wipe the dodge vector.
    ai.poll(input, world);

    const px = world.stores.position.x[player]!;
    const py = world.stores.position.y[player]!;
    const def = createClockworkKillSawDefinition();
    // Lane running along +X straight through the player, already mid-swing.
    world.mobAbilities.cues.push({
      abilityId: def.abilityId,
      casterEid: 99,
      phase: 'outbound',
      telegraphProgress: 1,
      geometry: {
        kind: 'lane',
        originX: px - 16,
        originY: py,
        endX: px + 16,
        endY: py,
        dirX: 1,
        dirY: 0,
        widthFt: 6,
        lengthFt: 32,
      },
      dangerColor: def.dangerColor,
      announcementText: def.announcementText,
      projectileX: px,
      projectileY: py,
    });

    ai.poll(input, world);

    // Travel steering must actually drive this poll, otherwise the regression
    // (steering wiping the dodge) is not exercised at all.
    expect(ai.getTravelSteeringDebug()).not.toBeNull();
    const debug = ai.getOpportunisticDebug();
    expect(debug.dodgeX).toBeCloseTo(0, 10);
    expect(Math.abs(debug.dodgeY)).toBeGreaterThan(0);
  });

  it('uses spawn-circle telegraphs as danger cues and dodges from the committed circle', () => {
    const world = createTestWorld({ seed: 42 });
    world.elapsedMs = 5000;
    const player = spawnPlayer(world, 10, 10);
    world.stores.position.x[player] = 10;
    world.stores.position.y[player] = 10;
    spawnBehaviorEnemy(world, 20, 0, 40, AI_TYPE.RANGED, 5, 200, 160);
    setActiveWeapon(world, getWeaponDef('sword')!);
    world.mobAbilities.cues.push({
      abilityId: 'plague-boss-squick-undercity-mob-call',
      casterEid: 88,
      phase: 'telegraph',
      telegraphProgress: 0.4,
      geometry: {
        kind: 'spawn-circles',
        circles: [
          { kind: 'circle', x: 10, y: 10, radiusFt: 4 },
          { kind: 'circle', x: 18, y: 10, radiusFt: 4 },
          { kind: 'circle', x: 14, y: 17, radiusFt: 4 },
        ],
      },
      dangerColor: 'hostile-red',
      announcementText: 'UNDERCITY MOB CALL — The guild always collects!',
    });

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);

    const debug = ai.getOpportunisticDebug();
    expect(Math.hypot(debug.dodgeX, debug.dodgeY)).toBeGreaterThan(0);
  });

  it('preserves sovereign cloud-zone dodge while travel steering is active', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    const ai = new BehaviorTreeAI({ seed: 42 });
    const input = createInputState();
    ai.poll(input, world);

    const playerX = world.stores.position.x[player] ?? 0;
    const playerY = world.stores.position.y[player] ?? 0;
    world.mobAbilities.ownedZones.push({
      id: 1,
      abilityId: 'sovereign-cap-spore-bloom',
      casterEid: 99,
      sourceId: 'mob-ability:sovereign-cap-spore-bloom:99',
      geometry: {
        kind: 'multi-circle',
        circles: [
          { kind: 'circle', x: playerX, y: playerY, radiusFt: 8 },
          { kind: 'circle', x: playerX + 6, y: playerY, radiusFt: 8 },
          { kind: 'circle', x: playerX - 6, y: playerY, radiusFt: 8 },
        ],
      },
      durationMs: 4000,
      tickIntervalMs: 500,
      elapsedMs: 0,
      nextTickAtMs: 500,
      tick: () => {},
    });

    ai.poll(createInputState(), world);

    expect(ai.getTravelSteeringDebug()).not.toBeNull();
    const debug = ai.getOpportunisticDebug();
    expect(Math.hypot(debug.dodgeX, debug.dodgeY)).toBeGreaterThan(0);
  });

  it('treats committed lane telegraphs as danger cues and sidesteps laterally', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 15, 10);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    world.stores.position.x[player] = 15;
    world.stores.position.y[player] = 10;
    world.mobAbilities.cues.push({
      abilityId: 'big-mama-bufo-tongue-repossession',
      casterEid: 77,
      phase: 'telegraph',
      telegraphProgress: 0.6,
      geometry: {
        kind: 'lane',
        originX: 10,
        originY: 10,
        endX: 30,
        endY: 10,
        dirX: 1,
        dirY: 0,
        widthFt: 3,
        lengthFt: 20,
      },
      dangerColor: 'hostile-red',
      announcementText: "TONGUE REPOSSESSION — Big Mama wants what's hers!",
    });

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);

    const debug = ai.getOpportunisticDebug();
    expect(Math.abs(debug.dodgeY)).toBeGreaterThan(0.1);
  });

  it('uses radial-projectile telegraphs as danger cues and sidesteps out of a spoke lane', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 8, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    world.stores.position.x[player] = 8;
    world.stores.position.y[player] = 0;
    world.mobAbilities.cues.push({
      abilityId: 'king-skritt-roman-candle-coronation',
      casterEid: 77,
      phase: 'telegraph',
      telegraphProgress: 0.5,
      geometry: {
        kind: 'radial-projectiles',
        casterX: 0,
        casterY: 0,
        count: 12,
        spokeLengthFt: 28,
        offsetDeg: 0,
      },
      dangerColor: 'hostile-red',
      announcementText: 'ROMAN-CANDLE CORONATION — All hail the Unburnt!',
    });

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);

    const debug = ai.getOpportunisticDebug();
    expect(Math.hypot(debug.dodgeX, debug.dodgeY)).toBeGreaterThan(0);
    expect(Math.abs(debug.dodgeY)).toBeGreaterThan(Math.abs(debug.dodgeX));
  });

  it('uses projectile-fan telegraphs to dodge laterally out of the locked cone', () => {
    const world = createTestWorld({ seed: 42 });
    world.elapsedMs = 5000;
    spawnPlayer(world, 0, 10);
    spawnBehaviorEnemy(world, 20, 0, 40, AI_TYPE.RANGED, 5, 200, 160);
    setActiveWeapon(world, getWeaponDef('sword')!);
    const def = createDonPacoBigGobDefinition();
    world.mobAbilities.cues.push({
      abilityId: def.abilityId,
      casterEid: 77,
      phase: 'telegraph',
      telegraphProgress: 0.5,
      geometry: {
        kind: 'projectile-fan',
        originX: 0,
        originY: 0,
        facingRad: Math.PI / 2,
        coneAngleDeg: 70,
        rangeFt: 30,
        paths: [
          {
            kind: 'projectile-path',
            startX: 0,
            startY: 0,
            endX: -17.21,
            endY: 24.57,
            impactRadiusFt: 3,
          },
          {
            kind: 'projectile-path',
            startX: 0,
            startY: 0,
            endX: -9.01,
            endY: 28.61,
            impactRadiusFt: 3,
          },
          { kind: 'projectile-path', startX: 0, startY: 0, endX: 0, endY: 30, impactRadiusFt: 3 },
          {
            kind: 'projectile-path',
            startX: 0,
            startY: 0,
            endX: 9.01,
            endY: 28.61,
            impactRadiusFt: 3,
          },
          {
            kind: 'projectile-path',
            startX: 0,
            startY: 0,
            endX: 17.21,
            endY: 24.57,
            impactRadiusFt: 3,
          },
        ],
      },
      dangerColor: def.dangerColor,
      announcementText: def.announcementText,
    });

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);

    const debug = ai.getOpportunisticDebug();
    expect(Math.abs(debug.dodgeX)).toBeGreaterThan(0);
    expect(debug.dodgeY).toBeCloseTo(0, 6);
  });

  it('dodges outward from active mob-ability slick zones', () => {
    const world = createTestWorld({ seed: 42 });
    world.elapsedMs = 5000;
    spawnPlayer(world, 1, 0);
    spawnBehaviorEnemy(world, 20, 0, 40, AI_TYPE.RANGED, 5, 200, 160);
    setActiveWeapon(world, getWeaponDef('sword')!);
    world.mobAbilities.activeZones.push({
      abilityId: 'don-paco-the-big-gob',
      casterEid: 77,
      sourceId: 'mob-ability:don-paco-the-big-gob:77:slick',
      circle: { kind: 'circle', x: 0, y: 0, radiusFt: 3 },
      remainingMs: 4000,
      slowMultiplier: 0.65,
    });

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);

    const debug = ai.getOpportunisticDebug();
    expect(debug.dodgeX).toBeGreaterThan(0);
    expect(debug.dodgeY).toBeCloseTo(0, 6);
  });
});
