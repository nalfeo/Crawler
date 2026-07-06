import { describe, expect, it } from 'vitest';
import {
  NPC_INTERACTION_COOLDOWN,
  autoAllocateStatPoints,
  autoFloor1ProgressionSystem,
  autoNpcInteractionSystem,
} from '../../src/game/ai/auto-progression.js';
import { AIState, type AIDecision, type AIInputProvider } from '../../src/game/ai/types.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import type { NpcInstance } from '../../src/shared/npc-types.js';
import type { GameWorld } from '../../src/core/world.js';
import type { FloorScenarioState } from '../../src/shared/floor-types.js';
import { createTestWorld } from '../helpers/world-factory.js';

function makeFloor1(overrides: Partial<FloorScenarioState['objective']> = {}): FloorScenarioState {
  return {
    protagonistName: 'Test',
    starterWeaponPool: [],
    starterChoices: [],
    selectedWeaponId: null,
    selectedChoiceIndex: null,
    baseStatBonuses: { maxHp: 0, moveSpeed: 0, pickupRange: 0 },
    enemyArchetypes: new Map(),
    guideNpcEid: null,
    spellQuestGiverNpcEid: null,
    shopkeeperNpcEid: null,
    questItemEid: null,
    bossRoomDoorEids: new Map(),
    objective: {
      requiredRats: 6,
      requiredSlimes: 4,
      requiredGold: 50,
      requiredJunk: 2,
      deadlineMs: 600_000,
      staircaseSpawnCountdownMs: 30_000,
      safeRoomPos: { x: 0, y: 0 },
      staircasePos: { x: 100, y: 100 },
      welcomeOfficePos: { x: 10, y: 0 },
      slimeRatRoomPos: { x: 50, y: 0 },
      spellQuestGiverPos: { x: 40, y: 0 },
      shopRoomPos: { x: 20, y: 0 },
      questItemPos: { x: 30, y: 0 },
      markerRadiusFt: 4,
      questAccepted: false,
      questCompleted: false,
      ratsKilled: 0,
      slimesKilled: 0,
      goldCollected: 0,
      junkCollected: 0,
      safeRoomDiscovered: false,
      staircaseSpawnStartedMs: null,
      staircaseSpawnRemainingMs: null,
      staircaseSpawned: false,
      staircaseLocked: false,
      staircaseUnlocked: false,
      staircaseDiscovered: false,
      bossBattles: new Map(),
      ...overrides,
    },
    failReason: null,
    runSummary: null,
  };
}

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

describe('autoFloor1ProgressionSystem', () => {
  it('is a no-op when floor1 is null', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    world.floorScenario = null;
    expect(() => autoFloor1ProgressionSystem(world, player)).not.toThrow();
  });

  it('selects the heal spell when boss battle is complete and spells not unlocked', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    world.floorScenario = makeFloor1();
    world.goalFlags.set('floor1-boss-battle-complete', true);
    world.featureUnlocks.spells = false;
    // selectSpellFromBossBattle should not throw
    expect(() => autoFloor1ProgressionSystem(world, player)).not.toThrow();
    // Spell unlocks should be set after the call
    expect(world.featureUnlocks.spells).toBe(true);
  });

  it('does not attempt staircase descend when staircase is not unlocked', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    world.floorScenario = makeFloor1({ staircaseUnlocked: false });
    expect(() => autoFloor1ProgressionSystem(world, player)).not.toThrow();
    // No staircase action should have been taken (floor1 state unchanged)
    expect(world.floorScenario.objective.staircaseDiscovered).toBe(false);
  });

  it('does not descend when staircase is already discovered', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    world.floorScenario = makeFloor1({ staircaseUnlocked: true, staircaseDiscovered: true });
    expect(() => autoFloor1ProgressionSystem(world, player)).not.toThrow();
  });

  it('triggers staircase descend when player is inside the marker radius', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    // Position player exactly at the staircase (100, 100) in feet
    world.stores.position.x[player] = 100;
    world.stores.position.y[player] = 100;
    world.state = 'playing';
    world.floorScenario = makeFloor1({
      staircaseUnlocked: true,
      staircaseDiscovered: false,
      staircaseSpawned: true,
      staircasePos: { x: 100, y: 100 },
    });
    autoFloor1ProgressionSystem(world, player);
    // confirmFloor1StairDescend sets staircaseDiscovered
    expect(world.floorScenario.objective.staircaseDiscovered).toBe(true);
  });
});
