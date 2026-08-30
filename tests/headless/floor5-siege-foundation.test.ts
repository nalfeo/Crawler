import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import type { FloorMap } from '../../src/core/map/FloorMap.js';
import type { GameWorld } from '../../src/core/world.js';
import { createFloorMainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { AIState, type AIDecision, type AIInputProvider } from '../../src/game/ai/types.js';
import {
  FLOOR5_RAM_COMPONENT_CLASSES,
  FLOOR5_SIEGE_GOAL_IDS,
  FLOOR5_SLICE3_QUEST_IDS,
  completeFloor5FieldTask,
  getFloor5RunOutcome,
  getFloor5SiegeRunStats,
  recoverFloor5RamComponent,
  requestFloor5RamConstruction,
  setFloor5BuildSiteUnderAttack,
  siegeDirectorSystem,
} from '../../src/game/floor5Scenario.js';
import { createTestWorld } from '../helpers/world-factory.js';
import type { InputState } from '../../src/shared/input.js';
import { addItem, cloneInventoryBag } from '../../src/shared/inventory.js';
import { getQuestDef, SHOPKEEPER_FETCH_ITEM_ID } from '../../src/shared/quest-types.js';

class IdleFloor5Provider implements AIInputProvider {
  private readonly decision: AIDecision = {
    state: AIState.EXPLORE,
    targetEid: null,
    targetX: null,
    targetY: null,
    reason: 'floor5 foundation observation',
    npcInteraction: null,
    debug: null,
  };

  poll(_input: InputState, _world: GameWorld): void {}

  getDecision(): AIDecision {
    return this.decision;
  }

  reset(): void {}
}

function serializeFloor5Map(map: FloorMap | null | undefined) {
  expect(map).toBeDefined();
  return {
    config: map!.config,
    playerSpawn: map!.playerSpawn,
    rooms: map!.rooms.map((room) => ({
      id: room.id,
      bounds: room.bounds,
      role: room.role,
      label: room.label,
      neighbors: [...room.neighbors],
    })),
    tileFlags: [...map!.tileMap.flags],
    terrain: [...map!.terrain],
  };
}

function completeFloor5RamPrerequisites(world: GameWorld): void {
  completeFloor5FieldTask(world, 'openingPush');
  completeFloor5FieldTask(world, 'siegeYard');
  for (const componentClass of FLOOR5_RAM_COMPONENT_CLASSES) {
    recoverFloor5RamComponent(world, componentClass);
  }
  completeFloor5FieldTask(world, 'checkpoint');
}

describe('Floor 5 siege foundation real pipeline', () => {
  it('binds Slice 3 quests to the canonical Floor 5 goal IDs', () => {
    const slice3GoalIds = [
      FLOOR5_SIEGE_GOAL_IDS.openingPushRepelled,
      FLOOR5_SIEGE_GOAL_IDS.yardSecured,
      FLOOR5_SIEGE_GOAL_IDS.componentsReady,
      FLOOR5_SIEGE_GOAL_IDS.checkpointCleared,
      FLOOR5_SIEGE_GOAL_IDS.ramBuilt,
    ];
    const questGoalIds = FLOOR5_SLICE3_QUEST_IDS.flatMap((questId) => {
      const quest = getQuestDef(questId);
      expect(quest).toBeDefined();
      return quest!.objectives.map((objective) => objective.goalId);
    });

    expect(questGoalIds).toEqual(slice3GoalIds);
    expect(Object.values(FLOOR5_SIEGE_GOAL_IDS)).toEqual([
      'floor5.siege.openingPushRepelled',
      'floor5.siege.yardSecured',
      'floor5.siege.componentsReady',
      'floor5.siege.ramBuilt',
      'floor5.siege.checkpointCleared',
      'floor5.siege.wallBreached',
      'floor5.siege.courtyardCleared',
      'floor5.siege.regentDefeated',
      'floor5.siege.castleCaptured',
    ]);
  });

  it('wires siegeDirectorSystem through the windowed scene options', () => {
    const options = createFloorMainSceneOptions('floor5');
    expect(options.preSystems).toContain(siegeDirectorSystem);

    const world = createTestWorld({ seed: 5 });
    const untouched = createTestWorld({ seed: 5 });
    const player = spawnPlayer(world, 0, 0);
    options.configureWorld!(world, player);

    expect(world.floorId).toBe('floor5');
    expect(world.floorExtendedState?.floor5Siege?.phase.kind).toBe('MUSTER');
    expect(getFloor5SiegeRunStats(world)?.trace).toEqual([]);
    expect(world.floorMap?.rooms.some((room) => room.label === 'throne-room')).toBe(true);
    expect(world.rng.next()).toBe(untouched.rng.next());
  });

  it('emits the same empty deterministic phase trace in windowed and headless setup', async () => {
    const windowedWorld = createTestWorld({ seed: 505 });
    const player = spawnPlayer(windowedWorld, 0, 0);
    createFloorMainSceneOptions('floor5').configureWorld!(windowedWorld, player);
    const windowedStats = getFloor5SiegeRunStats(windowedWorld);

    let headlessMap: ReturnType<typeof serializeFloor5Map> | undefined;
    const headless = await runHeadless(new IdleFloor5Provider(), {
      floorId: 'floor5',
      seed: 505,
      maxFrames: 5,
      questStallFrames: 0,
      onFinish: (world) => {
        headlessMap = serializeFloor5Map(world.floorMap);
      },
    });

    expect(headless.floor5Siege).toEqual(windowedStats);
    expect(headless.floor5Siege?.trace).toEqual([]);
    expect(headlessMap).toEqual(serializeFloor5Map(windowedWorld.floorMap));
  });

  it('completes every Slice 3 task contract through the real headless pipeline', async () => {
    let requested = false;
    const headless = await runHeadless(new IdleFloor5Provider(), {
      floorId: 'floor5',
      seed: 505,
      maxFrames: 260,
      questStallFrames: 0,
      simulationOptions: {
        postSystems: [
          (world) => {
            if (requested) return;
            completeFloor5RamPrerequisites(world);
            requested = requestFloor5RamConstruction(world);
          },
        ],
      },
      stopWhen: (world) => world.floorExtendedState?.floor5Siege?.engineState === 'READY',
    });

    expect(requested).toBe(true);
    expect(headless.floor5Siege?.phase.kind).toBe('BUILD');
    expect(headless.floor5Siege?.engineState).toBe('READY');
    expect(headless.floor5Siege?.tasks).toEqual({
      openingPushRepelled: true,
      yardSecured: true,
      recoveredComponents: [...FLOOR5_RAM_COMPONENT_CLASSES],
      componentsReady: true,
      checkpointCleared: true,
      allPrerequisitesMet: true,
    });
    expect(headless.floor5Siege?.requisition).toEqual({
      milestones: ['opening-push', 'siege-yard', 'components', 'checkpoint'],
      completedMilestones: 4,
      requiredMilestones: 4,
      ready: true,
    });
    expect(headless.floor5Siege?.construction).toMatchObject({
      progressMs: 3000,
      requiredMs: 3000,
      buildSiteUnderAttack: false,
      pausedMs: 0,
      attempts: 1,
      deniedAttempts: 0,
    });
    for (const questId of FLOOR5_SLICE3_QUEST_IDS) {
      expect(headless.quests.questLogCompletions[questId]).toBeGreaterThan(0);
    }
  });

  it('cannot build the Ratings Ram early and never consumes persistent inventory or gold', () => {
    const world = createTestWorld({ seed: 5 });
    const player = spawnPlayer(world, 0, 0);
    createFloorMainSceneOptions('floor5').configureWorld!(world, player);
    const bag = world.inventories.get(player)!;
    addItem(bag, SHOPKEEPER_FETCH_ITEM_ID, 2);
    world.playerGold = 77;
    const inventoryBefore = cloneInventoryBag(bag);

    expect(requestFloor5RamConstruction(world)).toBe(false);
    expect(world.floorExtendedState?.floor5Siege?.engineState).toBe('LOCKED');
    expect(world.floorExtendedState?.floor5Siege?.construction).toMatchObject({
      attempts: 1,
      deniedAttempts: 1,
      progressMs: 0,
    });
    expect(world.playerGold).toBe(77);
    expect(cloneInventoryBag(bag)).toEqual(inventoryBefore);

    completeFloor5RamPrerequisites(world);
    expect(requestFloor5RamConstruction(world)).toBe(true);
    expect(requestFloor5RamConstruction(world)).toBe(true);
    expect(world.floorExtendedState?.floor5Siege?.construction).toMatchObject({
      attempts: 3,
      deniedAttempts: 1,
      progressMs: 0,
    });
    expect(world.playerGold).toBe(77);
    expect(cloneInventoryBag(bag)).toEqual(inventoryBefore);

    const state = world.floorExtendedState!.floor5Siege!;
    state.engineState = 'DESTROYED';
    state.construction.progressMs = state.construction.requiredMs;
    state.construction.completedFrame = 42;
    world.frameCount = 99;
    expect(requestFloor5RamConstruction(world)).toBe(true);
    expect(state.engineState).toBe('BUILDING');
    expect(state.construction.progressMs).toBe(0);
    expect(state.construction.startedFrame).toBe(99);
    expect(state.construction.completedFrame).toBeNull();
    expect(world.playerGold).toBe(77);
    expect(cloneInventoryBag(bag)).toEqual(inventoryBefore);
  });

  it('pauses and resumes construction deterministically while the build site is under attack', async () => {
    let requested = false;
    const headless = await runHeadless(new IdleFloor5Provider(), {
      floorId: 'floor5',
      seed: 505,
      maxFrames: 320,
      questStallFrames: 0,
      simulationOptions: {
        postSystems: [
          (world) => {
            if (!requested) {
              completeFloor5RamPrerequisites(world);
              requested = requestFloor5RamConstruction(world);
              setFloor5BuildSiteUnderAttack(world, true);
              return;
            }
            if (world.frameCount === 80) {
              setFloor5BuildSiteUnderAttack(world, false);
            }
          },
        ],
      },
      stopWhen: (world) => world.floorExtendedState?.floor5Siege?.engineState === 'READY',
    });

    expect(headless.floor5Siege?.engineState).toBe('READY');
    expect(headless.floor5Siege?.construction.progressMs).toBe(3000);
    expect(headless.floor5Siege?.construction.pausedMs).toBeCloseTo((79 * 1000) / 60, 5);
    expect(headless.floor5Siege?.construction.completedFrame).toBeGreaterThan(80);
  });

  it('records exactly one DEFEAT transition when the Command Post is destroyed', () => {
    const world = createTestWorld({ seed: 5 });
    const player = spawnPlayer(world, 0, 0);
    createFloorMainSceneOptions('floor5').configureWorld!(world, player);
    const state = world.floorExtendedState!.floor5Siege!;

    world.frameCount = 42;
    world.elapsedMs = 7_000;
    state.commandPostHealth = 0;
    siegeDirectorSystem(world);

    expect(state.phase.kind).toBe('DEFEAT');
    expect(state.lastWorldElapsedMs).toBe(7_000);
    expect(getFloor5SiegeRunStats(world)?.trace).toEqual([
      {
        phase: { kind: 'DEFEAT' },
        reason: 'command-post-destroyed',
        frame: 42,
        worldElapsedMs: 7_000,
        commandPostHealth: 0,
        engineState: 'LOCKED',
        breachState: 'SEALED',
        heroState: 'PENDING',
      },
    ]);
    expect(getFloor5RunOutcome(world)).toBe('failed_timeout');

    // Terminal phases are absorbing: further ticks must not append trace entries
    // or advance the recorded elapsed time.
    world.frameCount = 43;
    world.elapsedMs = 9_000;
    siegeDirectorSystem(world);

    expect(state.trace).toHaveLength(1);
    expect(state.lastWorldElapsedMs).toBe(7_000);
  });

  it('does not transition while the run is not playing or the Command Post survives', () => {
    const world = createTestWorld({ seed: 5 });
    const player = spawnPlayer(world, 0, 0);
    createFloorMainSceneOptions('floor5').configureWorld!(world, player);
    const state = world.floorExtendedState!.floor5Siege!;

    state.commandPostHealth = 0;
    world.state = 'paused';
    siegeDirectorSystem(world);
    expect(state.phase.kind).toBe('MUSTER');
    expect(state.trace).toEqual([]);

    world.state = 'playing';
    state.commandPostHealth = 1;
    siegeDirectorSystem(world);
    expect(state.phase.kind).toBe('MUSTER');
    expect(state.trace).toEqual([]);
  });
});
