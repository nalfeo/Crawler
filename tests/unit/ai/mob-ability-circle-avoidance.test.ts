import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import {
  createClockworkKillSawDefinition,
  createVerdigrisGlamourDefinition,
} from '../../../src/core/index.js';
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
        endpointX: 16,
        endpointY: 0,
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
});
