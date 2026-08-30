import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import { applyDamage } from '../../src/core/apply-damage.js';
import type { FloorMap } from '../../src/core/map/FloorMap.js';
import type { GameWorld } from '../../src/core/world.js';
import { createFloorMainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { AIState, type AIDecision, type AIInputProvider } from '../../src/game/ai/types.js';
import {
  getFloor5RunOutcome,
  getFloor5SiegeRunStats,
  siegeDirectorSystem,
} from '../../src/game/floor5Scenario.js';
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
      maxFrames: 0,
      questStallFrames: 0,
      onFinish: (world) => {
        headlessMap = serializeFloor5Map(world.floorMap);
      },
    });

    expect(headless.floor5Siege).toEqual(windowedStats);
    expect(headless.floor5Siege?.trace).toEqual([]);
    expect(headlessMap).toEqual(serializeFloor5Map(windowedWorld.floorMap));
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

  it('resolves live Command Post structure destruction on the same post-damage tick', () => {
    const world = createTestWorld({ seed: 5 });
    const player = spawnPlayer(world, 0, 0);
    createFloorMainSceneOptions('floor5').configureWorld!(world, player);
    const state = world.floorExtendedState!.floor5Siege!;
    const commandPost = state.structures['command-post'].eid;

    world.frameCount = 99;
    world.elapsedMs = 12_000;
    applyDamage(
      world,
      commandPost,
      world.stores.health.current[commandPost] ?? 0,
      world.stores.position.x[commandPost] ?? 0,
      world.stores.position.y[commandPost] ?? 0,
      { origin: 'environment', affinity: 'physical', scaleWithPrimary: false, canCrit: false },
    );
    world.floorObjectiveTick!(world);

    expect(state.phase.kind).toBe('DEFEAT');
    expect(getFloor5RunOutcome(world)).toBe('failed_timeout');
    expect(getFloor5SiegeRunStats(world)?.trace.at(-1)).toMatchObject({
      phase: { kind: 'DEFEAT' },
      reason: 'command-post-destroyed',
      frame: 99,
      worldElapsedMs: 12_000,
      commandPostHealth: 0,
    });
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
