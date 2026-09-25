import { addComponent, query, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Health, Position, SiegeHero, SiegeMinion } from '../../src/core/components.js';
import { createEntity, spawnPlayer } from '../../src/core/helpers.js';
import { applyDamage } from '../../src/core/apply-damage.js';
import type { FloorMap } from '../../src/core/map/FloorMap.js';
import type { GameWorld } from '../../src/core/world.js';
import { createFloorMainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';
import { resolveRenderKind } from '../../src/engine/phaser-bridge/sprite-kind.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { AIState, type AIDecision, type AIInputProvider } from '../../src/game/ai/types.js';
import { getFloor5HudSnapshot } from '../../src/game/floor5Presentation.js';
import {
  _completeFloor5FieldTask,
  getFloor5RunOutcome,
  getFloor5SiegeRunStats,
  getFloor5ObjectiveInteraction,
  _recoverFloor5RamComponent,
  _requestFloor5RamConstruction,
  requestFloor5ObjectiveInteraction,
  siegeDirectorSystem,
  siegeHeroSystem,
  siegeMinionSystem,
  siegeRamSystem,
} from '../../src/game/floor5Scenario.js';
import { createTestWorld } from '../helpers/world-factory.js';
import type { InputState } from '../../src/shared/input.js';
import { addItem, cloneInventoryBag } from '../../src/shared/inventory.js';
import { getFloorManifest } from '../../src/shared/floor-registry.js';
import { getQuestDef, SHOPKEEPER_FETCH_ITEM_ID } from '../../src/shared/quest-types.js';
import { getQuestWaypoints } from '../../src/core/systems/questWaypoints.js';

const FLOOR5_RAM_COMPONENT_CLASSES = ['chassis', 'plating', 'broadcast-array'] as const;
const FLOOR5_SIEGE_GOAL_IDS = {
  openingPushRepelled: 'floor5.siege.openingPushRepelled',
  yardSecured: 'floor5.siege.yardSecured',
  componentsReady: 'floor5.siege.componentsReady',
  ramBuilt: 'floor5.siege.ramBuilt',
  checkpointCleared: 'floor5.siege.checkpointCleared',
  wallBreached: 'floor5.siege.wallBreached',
  courtyardCleared: 'floor5.siege.courtyardCleared',
  regentDefeated: 'floor5.siege.regentDefeated',
  castleCaptured: 'floor5.siege.castleCaptured',
} as const;
const FLOOR5_SLICE3_QUEST_IDS = [
  'floor5-hold-the-line',
  'floor5-secure-synergy',
  'floor5-recover-components',
  'floor5-clear-checkpoint',
  'floor5-build-ratings-ram',
] as const;

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
  _completeFloor5FieldTask(world, 'openingPush');
  _completeFloor5FieldTask(world, 'siegeYard');
  for (const componentClass of FLOOR5_RAM_COMPONENT_CLASSES) {
    _recoverFloor5RamComponent(world, componentClass);
  }
  _completeFloor5FieldTask(world, 'checkpoint');
}

describe('Floor 5 siege foundation real pipeline', () => {
  it('projects a deterministic Command Post danger warning in the headless pipeline', async () => {
    const observation: { warning: ReturnType<typeof getFloor5HudSnapshot> } = { warning: null };
    await runHeadless(new IdleFloor5Provider(), {
      floorId: 'floor5',
      seed: 505,
      maxFrames: 2,
      questStallFrames: 0,
      simulationOptions: {
        postSystems: [
          (world) => {
            if (world.frameCount !== 1) return;
            const state = world.floorExtendedState?.floor5Siege;
            const post = state?.structures['command-post'];
            if (!post || post.eid <= 0) return;
            applyDamage(
              world,
              post.eid,
              300,
              world.stores.position.x[post.eid] ?? 0,
              world.stores.position.y[post.eid] ?? 0,
              {
                origin: 'environment',
                affinity: 'physical',
                scaleWithPrimary: false,
                canCrit: false,
              },
            );
          },
        ],
      },
      onFinish: (world) => {
        observation.warning = getFloor5HudSnapshot(world);
      },
    });

    expect(observation.warning?.lines[1]).toContain('Command Post 700/1000 HP');
    expect(observation.warning?.lines[1]).toContain('under attack — defend the line');
    expect(observation.warning?.cues).toEqual([
      {
        id: 'floor5-command-post-danger-audio',
        kind: 'audio',
        label: 'Command Post under attack',
      },
      {
        id: 'floor5-command-post-danger-vfx',
        kind: 'vfx',
        label: 'Command Post under attack',
      },
    ]);
  });

  it('releases bounded hostile pressure only from committed objective beats', () => {
    const world = createTestWorld({ seed: 505 });
    const player = spawnPlayer(world, 0, 0);
    createFloorMainSceneOptions('floor5').configureWorld!(world, player);

    // Startup waves are immediate; passive system ticks alone add no objective pressure.
    siegeMinionSystem(world);
    const opening = getFloor5SiegeRunStats(world)!;
    expect(opening.hostileReinforcements).toEqual({
      cap: 4,
      heroCap: 2,
      released: 0,
      pending: 0,
      beats: [],
    });
    for (let frame = 0; frame < 10; frame += 1) siegeMinionSystem(world);
    expect(getFloor5SiegeRunStats(world)!.hostileReinforcements).toEqual(
      opening.hostileReinforcements,
    );

    _completeFloor5FieldTask(world, 'openingPush');
    _completeFloor5FieldTask(world, 'siegeYard');
    for (const component of FLOOR5_RAM_COMPONENT_CLASSES)
      _recoverFloor5RamComponent(world, component);
    siegeMinionSystem(world);
    siegeHeroSystem(world);
    expect(getFloor5SiegeRunStats(world)!.hostileReinforcements).toEqual({
      cap: 7,
      heroCap: 2,
      released: 3,
      pending: 0,
      beats: ['supplies'],
    });
    expect(query(world.ecs, [SiegeHero])).toHaveLength(1);
    expect(getFloor5SiegeRunStats(world)!.heroes.spawnedFrame).toBe(world.frameCount);

    _completeFloor5FieldTask(world, 'checkpoint');
    siegeMinionSystem(world);
    const reinforced = getFloor5SiegeRunStats(world)!;
    expect(reinforced.hostileReinforcements).toEqual({
      cap: 10,
      heroCap: 2,
      released: 6,
      pending: 0,
      beats: ['supplies', 'control-point'],
    });
    expect(reinforced.liveMinions.enemy).toBeLessThanOrEqual(16);
  });

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
    expect(getFloor5SiegeRunStats(world)?.trace.map((entry) => entry.phase.kind)).toEqual([
      'MUSTER',
    ]);
    expect(world.floorMap?.rooms.some((room) => room.label === 'throne-room')).toBe(true);
    expect(world.rng.next()).toBe(untouched.rng.next());
  });

  it('spawns visible opposing startup waves with the readable banner and concrete terrain pack', async () => {
    let startupMinionSnapshot:
      | {
          minionAllied: number;
          minionEnemy: number;
          renderKinds: string[];
          announcements: GameWorld['announcements'];
        }
      | undefined;
    await runHeadless(new IdleFloor5Provider(), {
      floorId: 'floor5',
      seed: 505,
      maxFrames: 2,
      questStallFrames: 0,
      onFinish: (world) => {
        const minionEids = Array.from(query(world.ecs, [SiegeMinion]));
        const heroEids = Array.from(query(world.ecs, [SiegeHero]));
        const startupCombatantEids = Array.from(new Set([...minionEids, ...heroEids])).sort(
          (a, b) => a - b,
        );
        const minionCounts = minionEids.reduce(
          (counts, eid) => {
            const team = world.stores.siegeMinion.team[eid] ?? 0;
            if (team === 1) counts.minionAllied += 1;
            if (team === 2) counts.minionEnemy += 1;
            return counts;
          },
          { minionAllied: 0, minionEnemy: 0 },
        );
        startupMinionSnapshot = {
          ...minionCounts,
          renderKinds: startupCombatantEids.map((eid) => resolveRenderKind(world, eid)),
          announcements: [...world.announcements],
        };
      },
    });

    expect(startupMinionSnapshot).toBeDefined();
    expect(startupMinionSnapshot!.minionAllied).toBeGreaterThan(0);
    expect(startupMinionSnapshot!.minionEnemy).toBeGreaterThan(0);
    expect(startupMinionSnapshot!.renderKinds.length).toBeGreaterThan(0);
    expect(startupMinionSnapshot!.renderKinds).toEqual(
      expect.arrayContaining(['siege_allied_minion', 'enemy_siege_minion']),
    );
    expect(
      startupMinionSnapshot!.renderKinds.every((kind) =>
        ['siege_allied_minion', 'enemy_siege_minion', 'enemy_siege_hero'].includes(kind),
      ),
    ).toBe(true);
    expect(getFloorManifest('floor5')?.terrainPackId).toBe('floor1-dungeon');
    expect(startupMinionSnapshot!.announcements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'bossAbilityCast',
          text: 'Hostile Takeover: defend the Command Post and hold the line.',
          durationMs: 6000,
        }),
      ]),
    );
  });

  it('emits the same deterministic initial phase trace in windowed and headless setup', async () => {
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
    expect(headless.floor5Siege?.trace.map((entry) => entry.phase.kind)).toEqual(['MUSTER']);
    expect(headlessMap).toEqual(serializeFloor5Map(windowedWorld.floorMap));
  });

  it('never advances siege tasks for an idle player at spawn', async () => {
    const headless = await runHeadless(new IdleFloor5Provider(), {
      floorId: 'floor5',
      seed: 505,
      maxFrames: 260,
      questStallFrames: 0,
    });

    expect(headless.floor5Siege?.phase.kind).toBe('MUSTER');
    expect(headless.floor5Siege?.engineState).toBe('LOCKED');
    expect(headless.floor5Siege?.tasks).toEqual({
      openingPushRepelled: false,
      yardSecured: false,
      recoveredComponents: [],
      componentsReady: false,
      checkpointCleared: false,
      allPrerequisitesMet: false,
    });
    expect(headless.floor5Siege?.requisition).toEqual({
      milestones: [],
      completedMilestones: 0,
      requiredMilestones: 4,
      ready: false,
    });
    expect(headless.floor5Siege?.construction).toMatchObject({
      progressMs: 0,
      requiredMs: 3000,
      buildSiteUnderAttack: false,
      pausedMs: 0,
      attempts: 0,
      deniedAttempts: 0,
    });
    for (const questId of FLOOR5_SLICE3_QUEST_IDS) {
      expect(headless.quests.questLogCompletions[questId] ?? 0).toBe(0);
    }
  });

  it('projects authored next-objective markers and requires proximity actions for components', () => {
    const world = createTestWorld({ seed: 505 });
    const player = spawnPlayer(world, 0, 0);
    createFloorMainSceneOptions('floor5').configureWorld!(world, player);
    expect(getQuestWaypoints(world, player)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ questId: 'floor5-hold-the-line', kind: 'combat' }),
        expect.objectContaining({ questId: 'floor5-secure-synergy', kind: 'combat' }),
        expect.objectContaining({ questId: 'floor5-recover-components', kind: 'item' }),
      ]),
    );

    _completeFloor5FieldTask(world, 'openingPush');
    _completeFloor5FieldTask(world, 'siegeYard');
    const componentRoom = world.floorMap!.rooms.find((room) => room.label === 'component-pocket')!;
    const componentPos = world.floorMap!.tileToWorld(
      Math.floor(componentRoom.bounds.x + componentRoom.bounds.width / 2),
      Math.floor(componentRoom.bounds.y + componentRoom.bounds.height / 2),
    );
    world.stores.position.x[player] = componentPos.x;
    world.stores.position.y[player] = componentPos.y;

    expect(getFloor5ObjectiveInteraction(world, player)?.label).toContain('Recover chassis');
    expect(requestFloor5ObjectiveInteraction(world, player)).toBe(true);
    expect(world.floorExtendedState!.floor5Siege!.tasks.recoveredComponents).toEqual(['chassis']);
    expect(getFloor5ObjectiveInteraction(world, player)?.label).toContain('Recover plating');
  });

  it('cannot build the Ratings Ram early and never consumes persistent inventory or gold', () => {
    const world = createTestWorld({ seed: 5 });
    const player = spawnPlayer(world, 0, 0);
    createFloorMainSceneOptions('floor5').configureWorld!(world, player);
    const bag = world.inventories.get(player)!;
    addItem(bag, SHOPKEEPER_FETCH_ITEM_ID, 2);
    world.playerGold = 77;
    const inventoryBefore = cloneInventoryBag(bag);

    expect(_requestFloor5RamConstruction(world)).toBe(false);
    expect(world.floorExtendedState?.floor5Siege?.engineState).toBe('LOCKED');
    expect(world.floorExtendedState?.floor5Siege?.construction).toMatchObject({
      attempts: 1,
      deniedAttempts: 1,
      progressMs: 0,
    });
    expect(world.playerGold).toBe(77);
    expect(cloneInventoryBag(bag)).toEqual(inventoryBefore);

    completeFloor5RamPrerequisites(world);
    expect(_requestFloor5RamConstruction(world)).toBe(true);
    expect(_requestFloor5RamConstruction(world)).toBe(true);
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
    expect(_requestFloor5RamConstruction(world)).toBe(true);
    expect(state.engineState).toBe('BUILDING');
    expect(state.construction.progressMs).toBe(0);
    expect(state.construction.startedFrame).toBe(99);
    expect(state.construction.completedFrame).toBeNull();
    expect(world.playerGold).toBe(77);
    expect(cloneInventoryBag(bag)).toEqual(inventoryBefore);
  });

  it('does not treat historical Command Post damage as a permanent build-site threat', async () => {
    let requested = false;
    const headless = await runHeadless(new IdleFloor5Provider(), {
      floorId: 'floor5',
      seed: 505,
      maxFrames: 320,
      questStallFrames: 0,
      simulationOptions: {
        postSystems: [
          (world) => {
            const commandPost =
              world.floorExtendedState!.floor5Siege!.structures['command-post'].eid;
            if (!requested) {
              completeFloor5RamPrerequisites(world);
              requested = _requestFloor5RamConstruction(world);
              const current = world.stores.health.current[commandPost] ?? 0;
              world.stores.health.current[commandPost] = current - 1;
              return;
            }
          },
        ],
      },
      stopWhen: (world) => world.floorExtendedState?.floor5Siege?.engineState === 'READY',
    });

    expect(headless.floor5Siege?.engineState).toBe('READY');
    expect(headless.floor5Siege?.construction.progressMs).toBe(3000);
    expect(headless.floor5Siege?.construction.completedFrame).not.toBeNull();
    expect(headless.floor5Siege?.commandPostHealth).toBe(999);
  });

  it('pauses and resumes construction deterministically for a live build-site threat', () => {
    const world = createTestWorld({ seed: 505 });
    const player = spawnPlayer(world, 0, 0);
    createFloorMainSceneOptions('floor5').configureWorld!(world, player);
    completeFloor5RamPrerequisites(world);
    expect(_requestFloor5RamConstruction(world)).toBe(true);

    const state = world.floorExtendedState!.floor5Siege!;
    const buildSite = state.ram.route[0]!;
    const threat = createEntity(world);
    addComponent(world.ecs, threat, set(Position, { x: buildSite.x, y: buildSite.y }));
    addComponent(world.ecs, threat, set(Health, { current: 1000, max: 1000 }));
    addComponent(world.ecs, threat, set(SiegeMinion, { team: 2, manifestIndex: 0 }));

    siegeDirectorSystem(world);
    world.elapsedMs = 1000;
    world.floorObjectiveTick!(world);
    expect(state.construction).toMatchObject({
      buildSiteUnderAttack: true,
      progressMs: 0,
      pausedMs: 1000,
    });

    world.stores.position.x[threat] = buildSite.x + 100;
    siegeDirectorSystem(world);
    world.elapsedMs = 2000;
    world.floorObjectiveTick!(world);
    expect(state.construction).toMatchObject({
      buildSiteUnderAttack: false,
      progressMs: 1000,
      pausedMs: 1000,
    });
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
        phase: { kind: 'MUSTER' },
        reason: 'floor5-initialized',
        frame: 0,
        worldElapsedMs: 0,
        commandPostHealth: 1000,
        engineState: 'LOCKED',
        breachState: 'SEALED',
        heroState: 'PENDING',
      },
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

    expect(state.trace.map((entry) => entry.phase.kind)).toEqual(['MUSTER', 'DEFEAT']);
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

  it('gives same-tick Command Post defeat precedence over a ready ram escort', () => {
    const world = createTestWorld({ seed: 505 });
    const player = spawnPlayer(world, 0, 0);
    createFloorMainSceneOptions('floor5').configureWorld!(world, player);
    completeFloor5RamPrerequisites(world);
    expect(_requestFloor5RamConstruction(world)).toBe(true);
    siegeRamSystem(world);

    world.elapsedMs = 3_000;
    world.floorObjectiveTick!(world);
    const state = world.floorExtendedState!.floor5Siege!;
    expect(state.engineState).toBe('READY');

    const commandPost = state.structures['command-post'].eid;
    applyDamage(
      world,
      commandPost,
      world.stores.health.current[commandPost] ?? 0,
      world.stores.position.x[commandPost] ?? 0,
      world.stores.position.y[commandPost] ?? 0,
      { origin: 'environment', affinity: 'physical', scaleWithPrimary: false, canCrit: false },
    );
    siegeRamSystem(world);
    world.floorObjectiveTick!(world);

    expect(state.phase.kind).toBe('DEFEAT');
    expect(state.trace.map((entry) => entry.phase.kind)).not.toContain('ESCORT');
    expect(state.trace.at(-1)?.phase.kind).toBe('DEFEAT');
    expect(state.engineState).toBe('READY');
  });

  it('gives Command Post defeat precedence over simultaneous wall and ram destruction', () => {
    const world = createTestWorld({ seed: 505 });
    const player = spawnPlayer(world, 0, 0);
    createFloorMainSceneOptions('floor5').configureWorld!(world, player);
    completeFloor5RamPrerequisites(world);
    expect(_requestFloor5RamConstruction(world)).toBe(true);
    siegeRamSystem(world);

    const state = world.floorExtendedState!.floor5Siege!;
    const commandPost = state.structures['command-post'].eid;
    const wall = state.structures['outer-wall'].eid;
    state.engineState = 'ATTACKING';
    state.commandPostHealth = 0;
    state.ram.health = 0;
    state.ram.wallAuthorizedHealth = 0;
    world.stores.health.current[commandPost] = 0;
    world.stores.health.current[wall] = 0;
    world.stores.health.current[state.ram.eid] = 0;

    world.floorObjectiveTick!(world);

    expect(state.phase.kind).toBe('DEFEAT');
    expect(state.breach.latched).toBe(false);
    expect(state.breach.commitAttempts).toBe(0);
    expect(state.breach.cleanup).toEqual({
      ramRetired: false,
      markersRetired: 0,
      wallRetired: false,
      heroesCleared: 0,
      minionsCleared: 0,
      waveDebtCleared: 0,
    });
  });

  it('does not trust a stale structure EID after the slot is reused by another health entity', () => {
    const world = createTestWorld({ seed: 5 });
    const player = spawnPlayer(world, 0, 0);
    createFloorMainSceneOptions('floor5').configureWorld!(world, player);
    const state = world.floorExtendedState!.floor5Siege!;

    state.structures['enemy-checkpoint'].eid = player;

    const stats = getFloor5SiegeRunStats(world)!;
    expect(stats.structures['enemy-checkpoint']).toMatchObject({
      eid: 0,
      health: 0,
      maxHealth: 36,
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
    expect(state.trace.map((entry) => entry.phase.kind)).toEqual(['MUSTER']);

    world.state = 'playing';
    state.commandPostHealth = 1;
    siegeDirectorSystem(world);
    expect(state.phase.kind).toBe('MUSTER');
    expect(state.trace.map((entry) => entry.phase.kind)).toEqual(['MUSTER']);
  });

  it('projects terminal capture to the canonical goal flag', () => {
    const world = createTestWorld({ seed: 5 });
    const player = spawnPlayer(world, 0, 0);
    createFloorMainSceneOptions('floor5').configureWorld!(world, player);
    world.floorExtendedState!.floor5Siege!.phase = { kind: 'CAPTURED' };

    world.floorObjectiveTick!(world);

    expect(world.goalFlags.get(FLOOR5_SIEGE_GOAL_IDS.castleCaptured)).toBe(true);
  });
});
