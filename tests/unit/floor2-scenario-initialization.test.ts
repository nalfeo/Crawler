import { afterEach, describe, expect, it } from 'vitest';
import { query } from 'bitecs';
import { spawnPlayer } from '../../src/core/spawners/combatants.js';
import { DoorState } from '../../src/core/index.js';
import { getEquipmentState } from '../../src/core/systems/equipmentSystem.js';
import { safeRoomSystem } from '../../src/core/safe-space.js';
import { SeededRandom } from '../../src/shared/random.js';
import { BiomeType, RoomRole } from '../../src/shared/map-types.js';
import type { MapConfig } from '../../src/shared/map-types.js';
import { CaveSystemGenerator } from '../../src/core/map/generators/cave-system.js';
import type { FloorMap } from '../../src/core/map/FloorMap.js';
import { FLOOR2_STAIR_MARKER_RADIUS_FT } from '../../src/shared/constants.js';
import { MERCHANTS_CHARM_DEF } from '../../src/shared/equipmentDefs.js';
import {
  FLOOR2_CAVE_SYSTEM_DEFAULTS,
  FLOOR2_SETTLEMENT_FOUND_GOAL_ID,
  FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID,
  floor2ObjectiveTick,
  initializeFloor2Scenario,
  meetBroker,
} from '../../src/game/floor2Scenario.js';
import { questSystem } from '../../src/core/systems/questSystem.js';
import { getQuestWaypoints } from '../../src/core/systems/questWaypoints.js';
import { resolveFloor2SettlementAnchor } from '../../src/core/floor2-settlement-anchor.js';
import { getFloor2NeutralTrash } from '../../src/shared/enemy-packs.js';
import {
  getFloorManifest,
  registerFloorManifest,
  resetBuiltInFloorManifests,
} from '../../src/shared/floor-registry.js';
import { FLOOR2_FIND_SETTLEMENT_QUEST_ID, getQuestDef } from '../../src/shared/quest-types.js';
import { createTestWorld } from '../helpers/world-factory.js';

const originalFloor2Manifest = structuredClone(getFloorManifest('floor2')!);

function createScenarioWorld() {
  const world = createTestWorld({ seed: 42, floor: 2 });
  const playerEid = spawnPlayer(world, 0, 0);
  return { world, playerEid };
}

function smallCaveConfig(seed: number): MapConfig {
  return {
    widthTiles: 80,
    heightTiles: 60,
    tileSizeFt: 4,
    biome: BiomeType.CAVE_SYSTEM,
    seed,
    roomWidthRange: [5, 12],
    roomHeightRange: [5, 12],
    maxRooms: 20,
    floorDensity: 0.45,
  };
}

function hashBytes(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function serializeFloor(floor: FloorMap): Record<string, unknown> {
  return {
    width: floor.width,
    height: floor.height,
    spawn: `${floor.playerSpawn.x},${floor.playerSpawn.y}`,
    terrainHash: hashBytes(floor.terrain),
    flagsHash: hashBytes(floor.tileMap.flags),
    rooms: floor.rooms.map((room) => ({
      id: room.id,
      role: room.role,
      familyIndex: room.familyIndex ?? null,
      bounds: `${room.bounds.x},${room.bounds.y},${room.bounds.width},${room.bounds.height}`,
      doors: room.doors.map((door) => `${door.x},${door.y}->${door.connectsTo}`),
    })),
  };
}

afterEach(() => {
  resetBuiltInFloorManifests();
});

describe('initializeFloor2Scenario manifest validation', () => {
  it('throws an actionable error when familyPool contains unknown ids', () => {
    const badManifest = structuredClone(originalFloor2Manifest);
    badManifest.floor2 = {
      ...badManifest.floor2,
      familyPool: ['unknown-family'],
    };
    registerFloorManifest('floor2', badManifest);

    const { world, playerEid } = createScenarioWorld();
    expect(() => initializeFloor2Scenario(world, playerEid)).toThrowError(
      /floor2\.familyPool contains unknown family ids/,
    );
  });

  it('throws an actionable error when familyPool resolves below roster minimum', () => {
    const badManifest = structuredClone(originalFloor2Manifest);
    badManifest.floor2 = {
      ...badManifest.floor2,
      familyPool: ['goblins', 'llamas', 'pandas'],
    };
    registerFloorManifest('floor2', badManifest);

    const { world, playerEid } = createScenarioWorld();
    expect(() => initializeFloor2Scenario(world, playerEid)).toThrowError(/minimum 4 required/);
  });

  it('throws an actionable error when resourcePool contains unknown ids', () => {
    const badManifest = structuredClone(originalFloor2Manifest);
    badManifest.floor2 = {
      ...badManifest.floor2,
      resourcePool: ['unknown-resource'],
    };
    registerFloorManifest('floor2', badManifest);

    const { world, playerEid } = createScenarioWorld();
    expect(() => initializeFloor2Scenario(world, playerEid)).toThrowError(
      /floor2\.resourcePool contains unknown resource ids/,
    );
  });

  it('throws an actionable error when settlement shopArchetypes contains unknown ids', () => {
    const badManifest = structuredClone(originalFloor2Manifest);
    badManifest.floor2 = {
      ...badManifest.floor2,
      settlement: {
        ...badManifest.floor2!.settlement,
        shopCountRange: badManifest.floor2!.settlement?.shopCountRange ?? [1, 1],
        shopArchetypes: ['unknown-archetype'],
      },
    };
    registerFloorManifest('floor2', badManifest);

    const { world, playerEid } = createScenarioWorld();
    expect(() => initializeFloor2Scenario(world, playerEid)).toThrowError(
      /floor2\.settlement\.shopArchetypes contains unknown ids/,
    );
  });

  it('seeds the Floor 2 starter quest and den quests into the active quest log', () => {
    const seed = 4444;
    const gen = new CaveSystemGenerator({ presentCount: 3 });
    const floorMap = gen.generate(smallCaveConfig(seed), new SeededRandom(seed));
    const world = createTestWorld({ seed, floor: 2 });
    world.floorMap = floorMap;
    const playerEid = spawnPlayer(world, 400, 400);

    initializeFloor2Scenario(world, playerEid);

    const activeQuestIds = [...world.questLog.values()]
      .filter((quest) => quest.status === 'active')
      .map((quest) => quest.questId);
    expect(activeQuestIds.length).toBeGreaterThan(0);
    expect(activeQuestIds).toContain(FLOOR2_FIND_SETTLEMENT_QUEST_ID);
    const denQuestIds = activeQuestIds.filter((questId) => questId.startsWith('floor2-den-'));
    expect(denQuestIds.length).toBeGreaterThan(0);
    expect(world.questLog.get(FLOOR2_FIND_SETTLEMENT_QUEST_ID)?.tracked).toBe(true);
    const settlementAnchor = resolveFloor2SettlementAnchor(world);
    expect(settlementAnchor).not.toBeNull();
    expect(getQuestWaypoints(world, playerEid)).toEqual([
      {
        ...settlementAnchor!,
        questId: FLOOR2_FIND_SETTLEMENT_QUEST_ID,
        label: 'Find the settlement',
        kind: 'npc',
      },
    ]);
    expect(
      denQuestIds.every((questId) =>
        getQuestDef(questId)?.objectives.every((objective) => objective.kind === 'counter'),
      ),
    ).toBe(true);
    // Den-unlock quests are passive background counters — they must be hidden.
    expect(denQuestIds.every((questId) => getQuestDef(questId)?.hidden === true)).toBe(true);
  });

  it('treats the Floor 2 entrance room as a safe room while keeping settlement anchor targeting stable', () => {
    const { world, playerEid } = createScenarioWorld();

    initializeFloor2Scenario(world, playerEid);

    safeRoomSystem(world);
    expect(world.playerInSafeRoom).toBe(true);

    const settlementAnchor = resolveFloor2SettlementAnchor(world);
    expect(settlementAnchor).not.toBeNull();
    const settlementAnchorTile = world.floorMap!.worldToTile(
      settlementAnchor!.x,
      settlementAnchor!.y,
    );
    const settlementAnchorRoomId = world.floorMap!.roomGraph.getRoomAt(
      settlementAnchorTile.x,
      settlementAnchorTile.y,
    );
    expect(settlementAnchorRoomId).toBe(world.floorExtendedState?.settlement?.settlementRoomId);
  });

  it('starts a direct Floor 2 run at level 5 with spent stats and the charm equipped', () => {
    const { world, playerEid } = createScenarioWorld();

    initializeFloor2Scenario(world, playerEid);

    expect(world.playerLevel.level).toBe(5);
    expect(world.playerLevel.unspentPoints).toBe(0);
    // Default allocator sequence (CON->8, DEX->5, offense->5, WIS->5, offense->11,
    // CON-remainder — see game/scenarios/playerStatAllocationPolicy.ts) spends the
    // 12 points available at level 5 as: constitution->8, then 4 into dexterity.
    expect(world.stores.coreStatPoints.strength[playerEid]).toBe(0);
    expect(world.stores.coreStatPoints.constitution[playerEid]).toBe(8);
    expect(world.stores.coreStatPoints.dexterity[playerEid]).toBe(4);
    expect(world.stores.health.max[playerEid]).toBe(280);
    expect(world.stores.health.current[playerEid]).toBe(280);

    const equipment = getEquipmentState(world, playerEid);
    const neckInstanceId = equipment?.equipped.neck ?? null;
    expect(neckInstanceId).not.toBeNull();
    expect(
      neckInstanceId === null ? undefined : equipment?.instances.get(neckInstanceId)?.def.id,
    ).toBe(MERCHANTS_CHARM_DEF.id);
  });

  it('enables the real shipped Floor 2 equipment flag closure during scenario initialization', () => {
    const { world, playerEid } = createScenarioWorld();

    initializeFloor2Scenario(world, playerEid);

    expect(world.floor2EquipmentFlags.floor2EquipmentRegistry).toBe(true);
    expect(world.floor2EquipmentFlags.floor2EquipmentCatalog).toBe(true);
    expect(world.floor2EquipmentFlags.floor2EquipmentRewards).toBe(true);
    expect(world.floor2EquipmentFlags.floor2EquipmentEconomy).toBe(true);
    expect(world.floor2EquipmentFlags.floor2EquipmentAiMaintenance).toBe(true);
    // `floor2EquipmentUx` and `floor2EquipmentWorld` are declared flags with
    // zero enforcement sites anywhere in src/ today (no player-facing
    // Quartermaster UI yet — see issue #2334, and no world-placement
    // feature gates on `floor2EquipmentWorld`). They are intentionally NOT
    // asserted true here; the real shipped path correctly leaves them at
    // their world default until something actually enforces them.
    expect(world.floor2EquipmentFlags.floor2EquipmentUx).toBe(false);
    expect(world.floor2EquipmentFlags.floor2EquipmentWorld).toBe(false);
  });

  it('completes the starter quest the first time the player enters the settlement area', () => {
    const { world, playerEid } = createScenarioWorld();
    initializeFloor2Scenario(world, playerEid);

    expect(world.goalFlags.get(FLOOR2_SETTLEMENT_FOUND_GOAL_ID)).toBe(false);
    expect(world.questLog.get(FLOOR2_FIND_SETTLEMENT_QUEST_ID)?.status).toBe('active');

    const settlementRoomId = world.floorExtendedState?.settlement?.settlementRoomId;
    expect(settlementRoomId).toBeDefined();
    const settlementRoom = world.floorMap?.roomGraph.get(settlementRoomId!);
    expect(settlementRoom).toBeDefined();
    const tile = settlementRoom?.interiorCells?.[0] ?? {
      x: settlementRoom!.bounds.x + Math.floor(settlementRoom!.bounds.width / 2),
      y: settlementRoom!.bounds.y + Math.floor(settlementRoom!.bounds.height / 2),
    };
    const pos = world.floorMap!.tileToWorld(tile.x, tile.y);
    world.stores.position.x[playerEid] = pos.x;
    world.stores.position.y[playerEid] = pos.y;

    floor2ObjectiveTick(world);
    questSystem(world);

    expect(world.goalFlags.get(FLOOR2_SETTLEMENT_FOUND_GOAL_ID)).toBe(true);
    expect(world.questLog.get(FLOOR2_FIND_SETTLEMENT_QUEST_ID)?.status).toBe('complete');
    expect(world.questLog.get(FLOOR2_FIND_SETTLEMENT_QUEST_ID)?.tracked).toBe(false);
    expect(getQuestWaypoints(world, playerEid)).toEqual([]);
    // Den-unlock quests are hidden; questSystem prefers non-hidden quests for
    // tracking. With no visible quests remaining, no visible quest is tracked.
    // (The hidden fallback may technically track a hidden quest, but the HUD
    // filters it out so the player sees nothing in the tracker.)
    expect(
      [...world.questLog.values()].some(
        (quest) =>
          quest.status === 'active' && quest.tracked && !getQuestDef(quest.questId)?.hidden,
      ),
    ).toBe(false);
    // Hidden quests must remain mechanically active (status='active') so that
    // kill-counter events still progress them; the hidden flag only gates HUD
    // visibility, not quest mechanics.
    expect(
      [...world.questLog.values()].some(
        (quest) => quest.status === 'active' && getQuestDef(quest.questId)?.hidden === true,
      ),
    ).toBe(true);
  });

  // This determinism guard generates two full Floor 2 scenario worlds (cave-system
  // map gen + serialization run twice), which alone is ~15-25s and tips past the
  // 30s unit default under full-`verify` parallel CPU contention (340 test files).
  // Give it the heavier-project 120s budget so it doesn't flake under load; the
  // assertion below is unchanged — this only accounts for real wall-clock cost.
  it('does not let settlement shop-count rolls perturb Floor 2 map generation', () => {
    const makeManifest = (shopCountRange: [number, number]) => {
      const manifest = structuredClone(originalFloor2Manifest);
      manifest.floor2 = {
        ...manifest.floor2!,
        settlement: {
          ...(manifest.floor2?.settlement ?? {}),
          shopCountRange,
        },
      };
      return manifest;
    };

    registerFloorManifest('floor2', makeManifest([1, 1]));
    const first = createScenarioWorld();
    initializeFloor2Scenario(first.world, first.playerEid);
    const firstFloor = serializeFloor(first.world.floorMap!);

    registerFloorManifest('floor2', makeManifest([2, 2]));
    const second = createScenarioWorld();
    initializeFloor2Scenario(second.world, second.playerEid);
    const secondFloor = serializeFloor(second.world.floorMap!);

    expect(secondFloor).toEqual(firstFloor);
  }, 120_000);

  it('installs a locked resource-heart door that unlocks on floor2-victory', () => {
    const { world, playerEid } = createScenarioWorld();
    initializeFloor2Scenario(world, playerEid);

    const floorMap = world.floorMap!;
    const heart = floorMap.roomGraph
      .getAll()
      .find((room) => room.role === RoomRole.RESOURCE_HEART)!;
    expect(heart.doors.length).toBeGreaterThan(0);

    const doorStates = query(world.ecs, [DoorState]);
    const lockedHeartDoor = heart.doors.some((door) =>
      doorStates.some(
        (eid) =>
          (world.stores.doorState.tileX[eid] ?? -1) === door.x &&
          (world.stores.doorState.tileY[eid] ?? -1) === door.y &&
          (world.stores.doorState.isLocked[eid] ?? 0) === 1 &&
          (world.stores.doorState.logicalOpen[eid] ?? 0) === 0,
      ),
    );
    expect(lockedHeartDoor).toBe(true);
  });

  it('initializes deterministic quadrant trash territories from the neutral pool', () => {
    const { world, playerEid } = createScenarioWorld();
    initializeFloor2Scenario(world, playerEid);

    const territories = world.floorExtendedState?.trashTerritories;
    expect(territories).toBeDefined();
    expect(territories?.size).toBe(4);
    expect(new Set(territories?.keys())).toEqual(new Set(['N', 'S', 'E', 'W']));

    const neutralIds = new Set(getFloor2NeutralTrash().map((entry) => entry.id));
    for (const archetypeId of territories?.values() ?? []) {
      expect(neutralIds.has(archetypeId)).toBe(true);
    }
  });

  it('applies floor2 cave defaults to real-game scenario map generation', () => {
    const { world, playerEid } = createScenarioWorld();
    initializeFloor2Scenario(world, playerEid);

    const cave = world.floorMap!.config.caveSystem;
    expect(cave).toBeDefined();
    expect(cave?.initialFill).toBe(FLOOR2_CAVE_SYSTEM_DEFAULTS.initialFill);
    expect(cave?.smoothingPasses).toBe(FLOOR2_CAVE_SYSTEM_DEFAULTS.smoothingPasses);
    expect(cave?.cavernWidenPasses).toBe(FLOOR2_CAVE_SYSTEM_DEFAULTS.cavernWidenPasses);
    expect(cave?.straightHallwayMinRun).toBe(FLOOR2_CAVE_SYSTEM_DEFAULTS.straightHallwayMinRun);
    expect(cave?.bossDenSize).toBe(FLOOR2_CAVE_SYSTEM_DEFAULTS.bossDenSize);
    expect(cave?.resourceHeartDiameterTiles).toBe(
      FLOOR2_CAVE_SYSTEM_DEFAULTS.resourceHeartDiameterTiles,
    );
    expect(cave?.territoryRadiusFraction).toBe(FLOOR2_CAVE_SYSTEM_DEFAULTS.territoryRadiusFraction);
    expect(cave?.denTargetRadiusMinFraction).toBe(
      FLOOR2_CAVE_SYSTEM_DEFAULTS.denTargetRadiusMinFraction,
    );
    expect(cave?.denTargetRadiusMaxFraction).toBe(
      FLOOR2_CAVE_SYSTEM_DEFAULTS.denTargetRadiusMaxFraction,
    );
    expect(cave?.denTargetMinSeparationTiles).toBe(
      FLOOR2_CAVE_SYSTEM_DEFAULTS.denTargetMinSeparationTiles,
    );
    expect(cave?.denStartAngleJitterFraction).toBe(
      FLOOR2_CAVE_SYSTEM_DEFAULTS.denStartAngleJitterFraction,
    );
    expect(cave?.denDistanceJitterFraction).toBe(
      FLOOR2_CAVE_SYSTEM_DEFAULTS.denDistanceJitterFraction,
    );
    expect(cave?.spawnMinDistanceFromDenTiles).toBe(
      FLOOR2_CAVE_SYSTEM_DEFAULTS.spawnMinDistanceFromDenTiles,
    );
    expect(cave?.spawnMinDistanceFromResourceHeartTiles).toBe(
      FLOOR2_CAVE_SYSTEM_DEFAULTS.spawnMinDistanceFromResourceHeartTiles,
    );
    expect(cave?.spawnMinDistanceFromSettlementTiles).toBe(
      FLOOR2_CAVE_SYSTEM_DEFAULTS.spawnMinDistanceFromSettlementTiles,
    );
    expect(cave?.settlementMinDistanceFromDenTiles).toBe(
      FLOOR2_CAVE_SYSTEM_DEFAULTS.settlementMinDistanceFromDenTiles,
    );
    expect(cave?.settlementMinDistanceFromResourceHeartTiles).toBe(
      FLOOR2_CAVE_SYSTEM_DEFAULTS.settlementMinDistanceFromResourceHeartTiles,
    );
    expect(cave?.regionSeparationTiles).toBe(FLOOR2_CAVE_SYSTEM_DEFAULTS.regionSeparationTiles);
    expect(cave?.maxRetries).toBe(FLOOR2_CAVE_SYSTEM_DEFAULTS.maxRetries);
  });

  it('seeds weapon skill states for the player so the HUD skill tracker has data to show', () => {
    const { world, playerEid } = createScenarioWorld();
    initializeFloor2Scenario(world, playerEid);

    // Both v1 (playerSkills) and v2 (skillStatesByEntity) maps must be populated
    // so HudSkillTracker can read skill progress regardless of which path it uses.
    expect(world.playerSkills.size).toBeGreaterThan(0);
    expect(world.skillStatesByEntity.has(playerEid)).toBe(true);
    expect(world.skillStatesByEntity.get(playerEid)!.size).toBeGreaterThan(0);
  });

  it('activates all Floor 1 feature unlocks at Floor 2 start', () => {
    const { world, playerEid } = createScenarioWorld();
    initializeFloor2Scenario(world, playerEid);

    expect(world.featureUnlocks.inventory).toBe(true);
    expect(world.featureUnlocks.equipment).toBe(true);
    expect(world.featureUnlocks.spells).toBe(true);
    const abilityState = world.abilityStatesByEntity.get(playerEid);
    expect(abilityState?.learnedSpellIds.length ?? 0).toBeGreaterThan(0);
    expect(abilityState?.equippedActiveAbilityIds.length ?? 0).toBeGreaterThan(0);
    expect(world.goalFlags.get('floor1-drops-unlocked')).toBe(true);
  });

  it('starts with the reputation system locked and activates it after the broker explains the floor', () => {
    const { world, playerEid } = createScenarioWorld();
    initializeFloor2Scenario(world, playerEid);

    // Reputation system is initially disabled.
    expect(world.floorExtendedState?.familyState?.reputationSystemActive).toBe(false);
    // Broker intro goal flag starts false.
    expect(world.goalFlags.get(FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID)).toBe(false);

    // Simulate the player reading all of the Broker's intro dialogue.
    meetBroker(world);

    floor2ObjectiveTick(world);

    // After the broker explains the floor, the reputation system should be active.
    expect(world.floorExtendedState?.familyState?.reputationSystemActive).toBe(true);
  });

  it('does NOT activate the reputation system when only the settlement is found (broker not yet met)', () => {
    const { world, playerEid } = createScenarioWorld();
    initializeFloor2Scenario(world, playerEid);

    // Move player into the settlement room.
    const settlementRoomId = world.floorExtendedState?.settlement?.settlementRoomId;
    expect(settlementRoomId).toBeDefined();
    const settlementRoom = world.floorMap?.roomGraph.get(settlementRoomId!);
    expect(settlementRoom).toBeDefined();
    const tile = settlementRoom?.interiorCells?.[0] ?? {
      x: settlementRoom!.bounds.x + Math.floor(settlementRoom!.bounds.width / 2),
      y: settlementRoom!.bounds.y + Math.floor(settlementRoom!.bounds.height / 2),
    };
    const pos = world.floorMap!.tileToWorld(tile.x, tile.y);
    world.stores.position.x[playerEid] = pos.x;
    world.stores.position.y[playerEid] = pos.y;

    floor2ObjectiveTick(world);

    // Settlement found, but broker not met — reputation system stays locked.
    expect(world.goalFlags.get(FLOOR2_SETTLEMENT_FOUND_GOAL_ID)).toBe(true);
    expect(world.floorExtendedState?.familyState?.reputationSystemActive).toBe(false);
  });
});

describe('Floor 2 stair marker radius', () => {
  it('keeps FLOOR2_STAIR_MARKER_RADIUS_FT in lockstep with the floor2 manifest markerRadiusFt', () => {
    // Floor 2 is not yet fully data-driven: the engine/game read the radius from
    // the shared constant, while the manifest carries its own markerRadiusFt.
    // This assertion is the drift guard promised by the constant's doc comment.
    expect(FLOOR2_STAIR_MARKER_RADIUS_FT).toBe(originalFloor2Manifest.objectives.markerRadiusFt);
  });
});
