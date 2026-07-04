import { describe, expect, it } from 'vitest';
import {
  NPC_INTERACTION_COOLDOWN,
  autoAllocateStatPoints,
  autoNpcInteractionSystem,
} from '../../src/game/ai/auto-progression.js';
import { AIState, type AIDecision, type AIInputProvider } from '../../src/game/ai/types.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import type { NpcInstance } from '../../src/shared/npc-types.js';
import type { GameWorld } from '../../src/core/world.js';
import { createTestWorld } from '../helpers/world-factory.js';

function fakeProvider(decision: AIDecision): AIInputProvider {
  return {
    poll: () => {},
    getDecision: () => decision,
    reset: () => {},
  };
}

function decision(partial: Partial<AIDecision>): AIDecision {
  return {
    state: AIState.EXPLORE,
    targetEid: null,
    targetX: null,
    targetY: null,
    reason: 'test',
    debug: null,
    ...partial,
  };
}

function addNpc(world: GameWorld, eid: number, instance: Partial<NpcInstance>): void {
  world.npcs.set(eid, {
    defId: 'tutorial-goon',
    dialogueIndex: 0,
    quests: [],
    nearbyPlayer: true,
    ...instance,
  });
}

describe('autoNpcInteractionSystem', () => {
  it('returns the last interaction frame while still on cooldown', () => {
    const world = createTestWorld();
    const provider = fakeProvider(decision({ state: AIState.INTERACT, targetEid: 5 }));
    expect(autoNpcInteractionSystem(world, provider, 100, 110, NPC_INTERACTION_COOLDOWN)).toBe(100);
  });

  it('does nothing when the AI is not in the INTERACT state', () => {
    const world = createTestWorld();
    const provider = fakeProvider(decision({ state: AIState.ENGAGE, targetEid: 5 }));
    expect(autoNpcInteractionSystem(world, provider, 0, 100, 30)).toBe(0);
  });

  it('does nothing when the target eid is missing or invalid', () => {
    const world = createTestWorld();
    expect(
      autoNpcInteractionSystem(
        world,
        fakeProvider(decision({ state: AIState.INTERACT, targetEid: null })),
        0,
        100,
        30,
      ),
    ).toBe(0);
    expect(
      autoNpcInteractionSystem(
        world,
        fakeProvider(decision({ state: AIState.INTERACT, targetEid: -1 })),
        0,
        100,
        30,
      ),
    ).toBe(0);
  });

  it('does nothing when the targeted NPC is unknown or not nearby', () => {
    const world = createTestWorld();
    // No NPC registered for eid 7.
    expect(
      autoNpcInteractionSystem(
        world,
        fakeProvider(decision({ state: AIState.INTERACT, targetEid: 7 })),
        0,
        100,
        30,
      ),
    ).toBe(0);
    // Registered but not nearby.
    addNpc(world, 8, { nearbyPlayer: false });
    expect(
      autoNpcInteractionSystem(
        world,
        fakeProvider(decision({ state: AIState.INTERACT, targetEid: 8 })),
        0,
        100,
        30,
      ),
    ).toBe(0);
  });

  it('meets the tutorial goon and advances the interaction frame', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    addNpc(world, 9, { defId: 'tutorial-goon', nearbyPlayer: true });
    const result = autoNpcInteractionSystem(
      world,
      fakeProvider(decision({ state: AIState.INTERACT, targetEid: 9 })),
      0,
      100,
      30,
    );
    expect(result).toBe(100);
    // meetTutorialGoon unlocks drops.
    expect(world.goalFlags.get('floor1-drops-unlocked')).toBe(true);
  });

  it('ignores NPCs with an unrecognized defId', () => {
    const world = createTestWorld();
    addNpc(world, 10, { defId: 'mystery-npc', nearbyPlayer: true });
    expect(
      autoNpcInteractionSystem(
        world,
        fakeProvider(decision({ state: AIState.INTERACT, targetEid: 10 })),
        0,
        100,
        30,
      ),
    ).toBe(0);
  });

  it('meets the shopkeeper NPC', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    addNpc(world, 11, { defId: 'shopkeeper', nearbyPlayer: true });
    expect(
      autoNpcInteractionSystem(
        world,
        fakeProvider(decision({ state: AIState.INTERACT, targetEid: 11 })),
        0,
        100,
        30,
      ),
    ).toBe(100);
  });

  it('meets the spell-quest-giver NPC', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    addNpc(world, 12, { defId: 'spell-quest-giver', nearbyPlayer: true });
    expect(
      autoNpcInteractionSystem(
        world,
        fakeProvider(decision({ state: AIState.INTERACT, targetEid: 12 })),
        0,
        100,
        30,
      ),
    ).toBe(100);
  });
});

describe('autoAllocateStatPoints', () => {
  it('is a no-op when there are no unspent points', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    world.playerLevel.unspentPoints = 0;
    expect(() => autoAllocateStatPoints(world, player)).not.toThrow();
  });

  it('spends available points (strength (→ armor) is front-loaded for survival)', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    world.playerLevel.unspentPoints = 5;
    const armorBefore = world.stores.coreStatPoints.strength[player] ?? 0;

    autoAllocateStatPoints(world, player);

    expect(world.stores.coreStatPoints.strength[player]).toBeGreaterThan(armorBefore);
  });
});
