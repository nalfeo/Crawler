import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import type { FloorMap } from '../../src/core/map/FloorMap.js';
import type { GameWorld } from '../../src/core/world.js';
import { createFloorMainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { AIState, type AIDecision, type AIInputProvider } from '../../src/game/ai/types.js';
import {
  buildFloor5AiRouteGraph,
  FLOOR5_AI_TASK_CONFIG,
} from '../../src/game/scenarios/floor5AiTasks.js';
import { getFloor5SiegeRunStats, siegeDirectorSystem } from '../../src/game/floor5Scenario.js';
import { createTestWorld } from '../helpers/world-factory.js';
import type { InputState } from '../../src/shared/input.js';

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

describe('Floor 5 siege foundation real pipeline', () => {
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

  it('declares a minimal scenario-AI route from base defense through throne capture', () => {
    expect(FLOOR5_AI_TASK_CONFIG.scenarioId).toBe('floor5');
    const graph = buildFloor5AiRouteGraph({
      openingPushRepelled: false,
      yardSecured: false,
      componentsReady: false,
      ramBuilt: false,
      checkpointCleared: false,
      wallBreached: false,
      breachEntered: false,
      courtyardCleared: false,
      regentDefeated: false,
      castleCaptured: false,
    });

    expect(graph.goals.map((goal) => goal.id)).toEqual([
      'defend-command-post',
      'secure-siege-yard',
      'recover-ram-components',
      'clear-forward-checkpoint',
      'build-ratings-ram',
      'escort-ratings-ram',
      'enter-breach',
      'clear-courtyard',
      'defeat-regent',
      'capture-throne',
    ]);
    expect(graph.locations.has('commandPost')).toBe(true);
    expect(graph.locations.has('throneRoom')).toBe(true);
  });
});
