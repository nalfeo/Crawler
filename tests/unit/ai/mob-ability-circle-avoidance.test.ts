import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import { createVerdigrisGlamourDefinition } from '../../../src/core/index.js';
import { spawnPlayer } from '../../../src/core/spawners/combatants.js';
import { createInputState } from '../../../src/shared/input.js';
import { createTestWorld } from '../../helpers/world-factory.js';
import {
  initializeFloor1Scenario,
  selectFloor1StarterWeapon,
} from '../../../src/game/floorScenario.js';

describe('BehaviorTreeAI mob-ability circle avoidance', () => {
  it('treats the exact telegraph boundary as dangerous and dodges outward', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 12, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    world.stores.position.x[player] = 12;
    world.stores.position.y[player] = 0;
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

  it('treats active sovereign cloud zones as dangerous and dodges outward', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    world.stores.position.x[player] = 0;
    world.stores.position.y[player] = 0;
    world.mobAbilities.ownedZones.push({
      id: 1,
      abilityId: 'sovereign-cap-spore-bloom',
      casterEid: 99,
      sourceId: 'mob-ability:sovereign-cap-spore-bloom:99',
      geometry: {
        kind: 'multi-circle',
        circles: [
          { kind: 'circle', x: 0, y: 0, radiusFt: 8 },
          { kind: 'circle', x: 6, y: 0, radiusFt: 8 },
          { kind: 'circle', x: -6, y: 0, radiusFt: 8 },
        ],
      },
      durationMs: 4000,
      tickIntervalMs: 500,
      elapsedMs: 0,
      nextTickAtMs: 500,
      tick: () => {},
    });

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);

    const debug = ai.getOpportunisticDebug();
    expect(Math.hypot(debug.dodgeX, debug.dodgeY)).toBeGreaterThan(0);
  });

  it('uses spawn-circle telegraphs as danger cues and dodges from the committed circle', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 10, 10);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    world.stores.position.x[player] = 10;
    world.stores.position.y[player] = 10;
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
});
