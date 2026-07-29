import { expect } from 'vitest';
import { spawnEnemy, spawnGold, spawnPlayer } from '../../src/core/helpers.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { getNavigationBlockedDoors } from '../../src/core/door-navigation.js';
import type { GameWorld } from '../../src/core/world.js';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { QUEST_GIVER_DETOUR_ABANDON_FRAMES } from '../../src/game/ai/bt-ai-tuning.js';
import {
  initializeFloor1Scenario,
  meetSpellQuestGiver,
  meetTutorialGoon,
  selectFloor1StarterWeapon,
} from '../../src/game/floorScenario.js';
import { createInputState } from '../../src/shared/input.js';
import { BiomeType, TilePresets, type MapConfig } from '../../src/shared/map-types.js';
import { AINpcInteractionAction, AIPathingMode, AIState } from '../../src/game/ai/types.js';
import { createTestWorld } from '../helpers/world-factory.js';
import {
  AI_INVARIANT,
  SLICE_A_DECISION_AXES,
  captureAiInvariantTrace,
  defineAiInvariantSuite,
  type AIInvariantAxis,
  type AIInvariantCase,
} from '../fixtures/ai-invariant-harness.js';

function makeRoom(
  widthTiles: number,
  heightTiles: number,
  blockedColumnX: number | null = null,
): FloorMap {
  const tileMap = new TileMap(widthTiles, heightTiles);
  const terrain = new Uint8Array(widthTiles * heightTiles);
  const config: MapConfig = {
    widthTiles,
    heightTiles,
    tileSizeFt: 4,
    biome: BiomeType.ARENA,
    seed: 1,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 1,
    floorDensity: 1,
  };
  for (let y = 0; y < heightTiles; y += 1) {
    for (let x = 0; x < widthTiles; x += 1) {
      const index = y * widthTiles + x;
      const border = x === 0 || y === 0 || x === widthTiles - 1 || y === heightTiles - 1;
      tileMap.flags[index] = border || x === blockedColumnX ? TilePresets.WALL : TilePresets.FLOOR;
    }
  }
  return new FloorMap(config, tileMap, new RoomGraph(), terrain, { x: 1, y: 1 });
}

function createFloor1World(seed: number): { world: GameWorld; player: number } {
  const world = createTestWorld({ seed });
  const player = spawnPlayer(world, 0, 0);
  initializeFloor1Scenario(world, player);
  selectFloor1StarterWeapon(world, 0);
  return { world, player };
}

function createAi(axis: AIInvariantAxis, seed: number): BehaviorTreeAI {
  return new BehaviorTreeAI({
    seed,
    decisionMode: axis.decisionMode,
    pathingMode: axis.pathingMode,
  });
}

function enterMiddleChain(world: GameWorld): void {
  meetTutorialGoon(world);
  world.playerLevel.level = 2;
  world.floorScenario!.objective.questCompleted = true;
  world.goalFlags.set('floor1-leveling-quest-complete', true);
  world.goalFlags.set('floor1-goon-quest-complete', true);
  world.goalFlags.set('floor1-shop-quest-complete', true);
}

function completeNonShopObjectives(world: GameWorld): void {
  const scenario = world.floorScenario!;
  world.goalFlags.set('floor1-leveling-quest-complete', true);
  world.goalFlags.set('floor1-goon-quest-complete', true);
  meetSpellQuestGiver(world);
  const slimeRat = scenario.objective.bossBattles.get('slime-rat')!;
  slimeRat.started = true;
  slimeRat.defeated = true;
  world.featureUnlocks.spells = true;
  world.goalFlags.set('floor1-boss-battle-complete', true);
  const staircase = scenario.objective.bossBattles.get('staircase')!;
  staircase.started = true;
  staircase.defeated = true;
  scenario.objective = {
    ...scenario.objective,
    staircaseUnlocked: true,
    staircaseDiscovered: true,
  };
}

function setupShopAnchorWorld(seed: number): {
  world: GameWorld;
  player: number;
  shopkeeperNpcEid: number;
  shopkeeperPos: { x: number; y: number };
  expectedAnchor: { x: number; y: number };
} {
  const { world, player } = createFloor1World(seed);
  meetTutorialGoon(world);
  world.playerLevel.level = 2;
  world.floorScenario!.objective.questCompleted = true;
  completeNonShopObjectives(world);
  world.floorMap = makeRoom(24, 20, 10);
  const playerPos = world.floorMap.tileToWorld(6, 6);
  world.stores.position.x[player] = playerPos.x;
  world.stores.position.y[player] = playerPos.y;

  const shopkeeperNpcEid = world.floorScenario!.shopkeeperNpcEid!;
  const spellBrokerEid = world.floorScenario!.spellQuestGiverNpcEid!;
  const shopkeeperPos = world.floorMap.tileToWorld(11, 6);
  const spellBrokerPos = world.floorMap.tileToWorld(16, 6);
  const expectedAnchor = world.floorMap.tileToWorld(9, 6);
  world.stores.position.x[shopkeeperNpcEid] = shopkeeperPos.x;
  world.stores.position.y[shopkeeperNpcEid] = shopkeeperPos.y;
  world.stores.position.x[spellBrokerEid] = spellBrokerPos.x;
  world.stores.position.y[spellBrokerEid] = spellBrokerPos.y;
  world.floorScenario!.objective = {
    ...world.floorScenario!.objective,
    shopRoomPos: expectedAnchor,
    questItemPos: world.floorMap.tileToWorld(8, 6),
    spellQuestGiverPos: spellBrokerPos,
  };

  return { world, player, shopkeeperNpcEid, shopkeeperPos, expectedAnchor };
}

function setupAcceptedDetour(
  axis: AIInvariantAxis,
  seed: number,
): {
  ai: BehaviorTreeAI;
  world: GameWorld;
  player: number;
  spellNpcEid: number;
} {
  const { world, player } = createFloor1World(seed);
  meetTutorialGoon(world);
  world.playerLevel.level = 2;
  world.floorScenario!.objective.questCompleted = false;
  world.goalFlags.set('floor1-leveling-quest-complete', true);
  world.floorMap = makeRoom(40, 20);
  world.stores.position.x[player] = 14;
  world.stores.position.y[player] = 14;

  const questEnemy = spawnEnemy(world, 50, 14, 20);
  world.floorScenario!.enemyArchetypes.set(questEnemy, 'rat');
  const spellNpcEid = world.floorScenario!.spellQuestGiverNpcEid!;
  world.stores.position.x[spellNpcEid] = 30;
  world.stores.position.y[spellNpcEid] = 14;

  return { ai: createAi(axis, seed), world, player, spellNpcEid };
}

const cases: AIInvariantCase[] = [
  {
    id: 'goal-state-replans-live-route-head',
    invariant: AI_INVARIANT.OBJECTIVE_ROUTING,
    axes: SLICE_A_DECISION_AXES,
    run(axis) {
      const { world } = createFloor1World(7);
      enterMiddleChain(world);
      const ai = createAi(axis, 7);
      const beforeInput = createInputState();
      ai.poll(beforeInput, world);
      const before = captureAiInvariantTrace(ai, beforeInput);
      expect(before.decision.reason).toContain('Spell Broker');
      expect(before.effectiveRunPlan.routeHeadId).toBe('accept-spell-quest');

      meetSpellQuestGiver(world);
      const afterInput = createInputState();
      ai.poll(afterInput, world);
      const after = captureAiInvariantTrace(ai, afterInput, {
        beforeReason: before.decision.reason,
        beforeRouteHeadId: before.effectiveRunPlan.routeHeadId,
      });
      expect(after.decision.reason).toContain('Slime Rat room');
      expect(after.effectiveRunPlan.routeHeadId).toBe('kill-slime-rat');
      return after;
    },
  },
  {
    id: 'door-signature-invalidates-live-route-cache',
    invariant: AI_INVARIANT.DOOR_STATE_REPLAN,
    axes: SLICE_A_DECISION_AXES,
    run(axis) {
      const { world } = createFloor1World(12);
      enterMiddleChain(world);
      const ai = createAi(axis, 12);
      ai.poll(createInputState(), world);
      const harness = ai as unknown as {
        floor1MiddleChainCache: object | null;
        navEpoch: number;
      };
      const initialCache = harness.floor1MiddleChainCache;
      const initialEpoch = harness.navEpoch;
      expect(initialCache).not.toBeNull();

      world.frameCount += 1_000;
      world.elapsedMs += 100_000;
      ai.poll(createInputState(), world);
      expect(harness.floor1MiddleChainCache).toBe(initialCache);
      expect(harness.navEpoch).toBe(initialEpoch);

      const blockedDoor = getNavigationBlockedDoors(world).find((door) =>
        door.unlockRequirement.goalIds.includes('floor1-slime-rat-quest-accepted'),
      );
      expect(blockedDoor).toBeDefined();
      expect(blockedDoor?.navigationBlocked).toBe(true);
      world.goalFlags.set('floor1-slime-rat-quest-accepted', true);
      expect(getNavigationBlockedDoors(world).some((door) => door.eid === blockedDoor?.eid)).toBe(
        false,
      );

      const input = createInputState();
      ai.poll(input, world);
      expect(harness.navEpoch).toBeGreaterThan(initialEpoch);
      expect(harness.floor1MiddleChainCache).not.toBe(initialCache);
      return captureAiInvariantTrace(ai, input, {
        cacheInvalidated: harness.floor1MiddleChainCache !== initialCache,
        epochDelta: harness.navEpoch - initialEpoch,
      });
    },
  },
  {
    id: 'npc-approach-uses-reachable-off-body-anchor',
    invariant: AI_INVARIANT.NPC_INTERACTION_ANCHOR,
    axes: SLICE_A_DECISION_AXES,
    run(axis) {
      const { world, shopkeeperNpcEid, shopkeeperPos, expectedAnchor } = setupShopAnchorWorld(12);
      const ai = createAi(axis, 12);
      const input = createInputState();
      ai.poll(input, world);
      const trace = captureAiInvariantTrace(ai, input, { expectedAnchor });
      expect(trace.decision.state).toBe(AIState.EXPLORE);
      expect(trace.decision.targetEid).toBe(shopkeeperNpcEid);
      expect(trace.decision.targetX).toBe(expectedAnchor.x);
      expect(trace.decision.targetY).toBe(expectedAnchor.y);
      expect(trace.decision.targetX).not.toBe(shopkeeperPos.x);
      expect(trace.decision.npcInteraction).toEqual({
        npcEid: shopkeeperNpcEid,
        action: AINpcInteractionAction.MEET_SHOPKEEPER,
        allowWhileExploring: true,
      });
      return trace;
    },
  },
  {
    id: 'close-first-visit-does-not-poison-far-anchor',
    invariant: AI_INVARIANT.NPC_INTERACTION_ANCHOR,
    axes: SLICE_A_DECISION_AXES,
    run(axis) {
      const { world, shopkeeperNpcEid, shopkeeperPos, expectedAnchor } = setupShopAnchorWorld(18);
      const ai = createAi(axis, 18);
      const resolveAnchor = ai['resolveNpcInteractionAnchor'].bind(ai) as (
        gameWorld: GameWorld,
        playerX: number,
        playerY: number,
        npcX: number,
        npcY: number,
        npcEid: number,
      ) => { x: number; y: number };
      const near = world.floorMap!.tileToWorld(9, 6);
      const far = world.floorMap!.tileToWorld(6, 6);
      const first = resolveAnchor(
        world,
        near.x,
        near.y,
        shopkeeperPos.x,
        shopkeeperPos.y,
        shopkeeperNpcEid,
      );
      const revisit = resolveAnchor(
        world,
        far.x,
        far.y,
        shopkeeperPos.x,
        shopkeeperPos.y,
        shopkeeperNpcEid,
      );
      expect(first).toEqual(shopkeeperPos);
      expect(revisit).toEqual(expectedAnchor);
      return captureAiInvariantTrace(ai, createInputState(), { first, revisit });
    },
  },
  {
    id: 'legacy-grid-rejects-unreachable-progress-path',
    invariant: AI_INVARIANT.PARTIAL_PATH_REJECTION,
    axes: SLICE_A_DECISION_AXES,
    locomotion: {
      assertedPathingModes: [AIPathingMode.RISK_REWARD_FUSED],
      owner: 'slice-a',
    },
    run(axis) {
      const world = createTestWorld({ seed: 63, floor: 2 });
      spawnPlayer(world, 14, 14);
      world.floorMap = makeRoom(50, 18, 14);
      world.floorExtendedState = {
        familyState: {
          presentFamilies: [],
          contestedResource: 'gold-veins' as never,
          betrayerFlag: false,
          reputationSystemActive: true,
          staircaseSpawned: true,
          staircaseUnlocked: true,
          staircaseDiscovered: false,
          staircasePos: { x: 90, y: 34 },
        },
      };
      world.goalFlags.set('floor2-settlement-found', true);
      world.goalFlags.set('floor2-broker-intro-complete', true);
      const ai = createAi(axis, 63);
      const input = createInputState();
      ai.poll(input, world);
      const trace = captureAiInvariantTrace(ai, input, {
        contract: 'reject-non-reaching-path-and-stop',
      });
      expect(trace.decision.targetX).toBeNull();
      expect(trace.decision.targetY).toBeNull();
      expect(trace.movement).toEqual({ x: 0, y: 0 });
      return trace;
    },
  },
  {
    id: 'urgent-required-route-outranks-optional-collect',
    invariant: AI_INVARIANT.CRITICAL_ROUTE_OWNERSHIP,
    axes: SLICE_A_DECISION_AXES,
    run(axis) {
      const { world, player, shopkeeperNpcEid, expectedAnchor } = setupShopAnchorWorld(22);
      const playerX = world.stores.position.x[player]!;
      const playerY = world.stores.position.y[player]!;
      spawnGold(world, playerX, playerY, 3);
      world.floorScenario!.objective.deadlineMs = world.elapsedMs + 1;
      const ai = createAi(axis, 22);
      const input = createInputState();
      ai.poll(input, world);
      const trace = captureAiInvariantTrace(ai, input, {
        optionalGoldActivated: true,
        expectedAnchor,
      });
      expect(trace.decision.state).toBe(AIState.EXPLORE);
      expect(trace.decision.targetEid).toBe(shopkeeperNpcEid);
      expect(trace.effectiveRunPlan.routeHeadId).toBe('meet-shopkeeper');
      return trace;
    },
  },
  {
    id: 'urgent-final-staircase-tail-keeps-route-ownership',
    invariant: AI_INVARIANT.CRITICAL_ROUTE_OWNERSHIP,
    axes: SLICE_A_DECISION_AXES,
    run(axis) {
      const { world, player } = createFloor1World(31);
      meetTutorialGoon(world);
      world.playerLevel.level = 2;
      world.floorScenario!.objective.questCompleted = true;
      world.goalFlags.set('floor1-leveling-quest-complete', true);
      world.goalFlags.set('floor1-goon-quest-complete', true);
      world.goalFlags.set('floor1-shop-quest-complete', true);
      meetSpellQuestGiver(world);
      const objective = world.floorScenario!.objective;
      const slimeRat = objective.bossBattles.get('slime-rat')!;
      slimeRat.started = true;
      slimeRat.defeated = true;
      world.featureUnlocks.spells = true;
      world.goalFlags.set('floor1-boss-battle-complete', true);
      const staircase = objective.bossBattles.get('staircase')!;
      staircase.started = true;
      staircase.defeated = true;
      world.floorScenario!.objective = {
        ...objective,
        staircaseUnlocked: true,
        staircaseDiscovered: false,
      };
      world.playerInSafeRoom = false;
      world.stores.position.x[player] = objective.staircasePos.x - 20;
      world.stores.position.y[player] = objective.staircasePos.y;
      for (const npcEid of [
        world.floorScenario!.guideNpcEid,
        world.floorScenario!.shopkeeperNpcEid,
        world.floorScenario!.spellQuestGiverNpcEid,
      ]) {
        if (npcEid === null) continue;
        world.stores.position.x[npcEid] = objective.staircasePos.x + 500;
        world.stores.position.y[npcEid] = objective.staircasePos.y;
      }
      spawnGold(world, world.stores.position.x[player]!, world.stores.position.y[player]!, 3);
      world.floorScenario!.objective.deadlineMs = world.elapsedMs + 1;

      const ai = createAi(axis, 31);
      const input = createInputState();
      ai.poll(input, world);
      const trace = captureAiInvariantTrace(ai, input, {
        optionalGoldActivated: true,
        finalTailActivated: true,
      });
      expect(trace.decision.reason).toBe('Heading to the stairs to clear the floor');
      expect(trace.effectiveRunPlan.routeHeadId).toBe('take-stairs');
      return trace;
    },
  },
  {
    id: 'committed-goal-is-charged-once-and-propagates-effects',
    invariant: AI_INVARIANT.COMMITTED_DETOUR_ACCOUNTING,
    axes: SLICE_A_DECISION_AXES,
    run(axis) {
      const { world, player } = createFloor1World(12);
      enterMiddleChain(world);
      world.floorMap = makeRoom(40, 20);
      world.stores.position.x[player] = 14;
      world.stores.position.y[player] = 14;
      const spellBrokerEid = world.floorScenario!.spellQuestGiverNpcEid!;
      world.stores.position.x[spellBrokerEid] = 38;
      world.stores.position.y[spellBrokerEid] = 14;
      const ai = createAi(axis, 12);
      const harness = ai as unknown as {
        committedDetourNpcEid: number | null;
        merchantDecisionRunPlan: object | null;
        merchantDecisionRunPlanFrame: number;
        estimateCurrentRunPlan(
          gameWorld: GameWorld,
          playerEid: number,
          playerX: number,
          playerY: number,
          playerSpeedFtPerFrame: number,
        ): { segments: readonly { id: string }[] } | null;
        releaseDetourCommitment(): void;
      };
      harness.committedDetourNpcEid = spellBrokerEid;
      const plan = harness.estimateCurrentRunPlan(world, player, 14, 14, 0.2);
      const segmentIds = plan?.segments.map((segment) => segment.id) ?? [];
      expect(segmentIds[0]).toBe('current-detour');
      expect(segmentIds).not.toContain('accept-spell-quest');
      expect(segmentIds).toContain('kill-slime-rat');

      harness.merchantDecisionRunPlan = plan;
      harness.merchantDecisionRunPlanFrame = world.frameCount;
      harness.releaseDetourCommitment();
      expect(harness.merchantDecisionRunPlan).toBeNull();
      expect(harness.merchantDecisionRunPlanFrame).toBe(Number.NEGATIVE_INFINITY);
      return captureAiInvariantTrace(ai, createInputState(), {
        segmentIds,
        cacheReleased: harness.merchantDecisionRunPlan === null,
      });
    },
  },
  {
    id: 'stalled-quest-giver-detour-self-releases',
    invariant: AI_INVARIANT.STALL_RECOVERY,
    axes: SLICE_A_DECISION_AXES,
    run(axis) {
      const { ai, world, spellNpcEid } = setupAcceptedDetour(axis, 2);
      ai.poll(createInputState(), world);
      expect(ai.getDecision().targetEid).toBe(spellNpcEid);
      world.playerInSafeRoom = true;
      ai.poll(createInputState(), world);
      expect(ai.getDecision().targetEid).toBe(spellNpcEid);

      let pollsUntilRelease: number | null = null;
      for (let poll = 1; poll <= QUEST_GIVER_DETOUR_ABANDON_FRAMES + 5; poll += 1) {
        ai.poll(createInputState(), world);
        if (ai.getDecision().targetEid !== spellNpcEid) {
          pollsUntilRelease = poll;
          break;
        }
      }
      expect(pollsUntilRelease).not.toBeNull();
      expect(pollsUntilRelease).toBeLessThanOrEqual(QUEST_GIVER_DETOUR_ABANDON_FRAMES + 5);
      const input = createInputState();
      ai.poll(input, world);
      return captureAiInvariantTrace(ai, input, {
        pollsUntilRelease,
        releasedTarget: ai.getDecision().targetEid,
      });
    },
  },
];

defineAiInvariantSuite(cases);
