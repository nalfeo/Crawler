import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { recruitPartyCompanion, spawnPlayer } from '../../src/core/helpers.js';
import { AI_TYPE } from '../../src/game/index.js';
import { TeamId } from '../../src/shared/constants.js';
import { Companion, Team } from '../../src/core/index.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import {
  FLOOR3_FINAL_FOUR_UNLOCK_GOAL_ID,
  FLOOR3_STAIRS_DISCOVERED_GOAL_ID,
  FLOOR3_STAIRS_POPPED_GOAL_ID,
  FLOOR3_VICTORY_GOAL_ID,
  confirmFloor3StairDescend,
  floor3ObjectiveTick,
  floor3WildDirectorSystem,
  floor3StudioDefeatGoalId,
  initializeFloor3Scenario,
  selectFloor3KeptCompanion,
  selectFloor3LoadoutOption,
} from '../../src/game/floor3Scenario.js';
import { getScenarioDefinition } from '../../src/game/scenarioDefinitions.js';
import {
  BiomeType,
  RoomRole,
  TerrainType,
  TilePresets,
  type MapConfig,
} from '../../src/shared/map-types.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { capturePlayerCarryover } from '../../src/game/playerCarryover.js';
import { KEPT_COMPANION_CONTRACT_SCHEMA_VERSION } from '../../src/shared/data/floor3/kept-companion-contract.js';
import {
  ABILITY_MILESTONE_LEVELS,
  learnedAbilityIds,
  speciesForToken,
} from '../../src/shared/data/floor3/species.js';
import type { GameWorld } from '../../src/core/index.js';

const TINY_FLOOR3_MAP_WIDTH = 6;
const TINY_FLOOR3_MAP_HEIGHT = 6;

const TINY_FLOOR3_MAP_CONFIG: MapConfig = {
  widthTiles: TINY_FLOOR3_MAP_WIDTH,
  heightTiles: TINY_FLOOR3_MAP_HEIGHT,
  tileSizeFt: 32,
  biome: BiomeType.CAVE_SYSTEM_BIOMES,
  seed: 910,
  roomWidthRange: [4, 4],
  roomHeightRange: [4, 4],
  maxRooms: 8,
  floorDensity: 0.5,
};

function createFloor3World(seed: number) {
  const world = createTestWorld({ seed, floor: 3 });
  const playerEid = spawnPlayer(world, 0, 0);
  initializeFloor3Scenario(world, playerEid);
  // Confirm the starter-Companion pick (spec R5 §6.1) so the world lands in
  // 'playing' the way a real run does — `initializeFloor3Scenario` now pauses
  // on 'loadout' until a pick is made, mirroring Floor 1's weapon loadout.
  selectFloor3LoadoutOption(world, 0);
  return { world, playerEid };
}

function createTinyFloor3Map(): FloorMap {
  const flags = new Uint8Array(TINY_FLOOR3_MAP_WIDTH * TINY_FLOOR3_MAP_HEIGHT);
  const terrain = new Uint8Array(TINY_FLOOR3_MAP_WIDTH * TINY_FLOOR3_MAP_HEIGHT).fill(
    TerrainType.STONE_WALL,
  );
  const roomGraph = new RoomGraph();
  const setFloor = (x: number, y: number): void => {
    const idx = y * TINY_FLOOR3_MAP_WIDTH + x;
    flags[idx] = TilePresets.FLOOR;
    terrain[idx] = TerrainType.STONE_FLOOR;
  };

  for (let i = 0; i < 8; i += 1) {
    const x = 1;
    const y = 1;
    for (let ty = y + 1; ty <= y + 2; ty += 1) {
      for (let tx = x + 1; tx <= x + 2; tx += 1) {
        setFloor(tx, ty);
      }
    }
    roomGraph.add({ x, y, width: 4, height: 4 }, [], [], RoomRole.TERRITORY, undefined, undefined, [
      { x: x + 1, y: y + 1 },
      { x: x + 2, y: y + 1 },
      { x: x + 1, y: y + 2 },
      { x: x + 2, y: y + 2 },
    ]);
  }

  return new FloorMap(
    TINY_FLOOR3_MAP_CONFIG,
    new TileMap(TINY_FLOOR3_MAP_WIDTH, TINY_FLOOR3_MAP_HEIGHT, flags),
    roomGraph,
    terrain,
    { x: 3, y: 3 },
  );
}

/** Knocks out every Companion belonging to any of `teamIds`. */
function knockOutTeams(world: GameWorld, teamIds: readonly number[]): void {
  const companions = query(world.ecs, [Companion, Team]);
  for (const eid of companions) {
    if (!teamIds.includes(world.stores.team.id[eid] ?? -1)) continue;
    world.stores.companion.knockedOut[eid] = 1;
  }
}

function countCompanionsOnTeams(world: GameWorld, teamIds: readonly number[]): number {
  const companions = query(world.ecs, [Companion, Team]);
  let count = 0;
  for (const eid of companions) {
    if (teamIds.includes(world.stores.team.id[eid] ?? -1)) count += 1;
  }
  return count;
}

/**
 * Levels the player past every Studio's unlock threshold and ticks once
 * (spawning every still-locked Studio's roster), knocks out every Studio's
 * roster, then ticks again so `floor3ObjectiveTick` latches each Studio as
 * defeated. Used by tests that only care about the post-Studios state
 * (Final Four unlock/victory), not the per-Studio unlock gate itself.
 */
function defeatAllStudios(
  world: GameWorld,
  state: NonNullable<GameWorld['floorExtendedState']>['floor3Studios'],
): void {
  const maxUnlockLevel = state!.studios.reduce((max, s) => Math.max(max, s.unlockLevel), 0);
  world.playerLevel.level = Math.max(world.playerLevel.level, maxUnlockLevel);
  floor3ObjectiveTick(world);
  for (const studio of state!.studios) {
    knockOutTeams(world, studio.teamIds);
  }
  floor3ObjectiveTick(world);
  drainPoachOffers(world, state);
}

/** Wipes all four Final Four rounds in order through the production objective tick. */
function defeatFinalFour(
  world: GameWorld,
  state: NonNullable<GameWorld['floorExtendedState']>['floor3Studios'],
): void {
  for (let round = 0; round < state!.finalFourRounds.length; round += 1) {
    knockOutTeams(world, state!.finalFour.teamIds);
    floor3ObjectiveTick(world);
  }
}

/**
 * Resolves the Trainer-poach pauses each defeated Studio produces (spec §6.2,
 * slice 12): the objective tick pauses on `'loadout'` once per defeated
 * Studio until the pick is confirmed, exactly as the game modal and the
 * headless runner do. Tests that tick past a Studio defeat must drain them or
 * the floor stays paused and never reaches the Final Four.
 */
function drainPoachOffers(
  world: GameWorld,
  state: NonNullable<GameWorld['floorExtendedState']>['floor3Studios'],
): void {
  // One pause per Studio at most; the extra iteration is the settling tick
  // that proves no further offer is pending.
  for (let i = 0; i <= state!.studios.length; i += 1) {
    floor3ObjectiveTick(world);
    if (world.state !== 'loadout') break;
    selectFloor3LoadoutOption(world, 0);
  }
}

const MASK_ROOM_CELLS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 1, y: 1 },
  { x: 2, y: 1 },
];

/**
 * A 6x6 map whose single territory room carries an irregular `interiorCells`
 * mask, plus extra passable tiles inside the same bounding box that do NOT
 * belong to the room (they stand in for a neighbouring room/corridor). Roster
 * spawns must stay on the mask.
 */
function createMaskedFloor3Map(): FloorMap {
  const flags = new Uint8Array(TINY_FLOOR3_MAP_WIDTH * TINY_FLOOR3_MAP_HEIGHT);
  const terrain = new Uint8Array(TINY_FLOOR3_MAP_WIDTH * TINY_FLOOR3_MAP_HEIGHT).fill(
    TerrainType.STONE_WALL,
  );
  const setFloor = (x: number, y: number): void => {
    const idx = y * TINY_FLOOR3_MAP_WIDTH + x;
    flags[idx] = TilePresets.FLOOR;
    terrain[idx] = TerrainType.STONE_FLOOR;
  };
  for (const cell of MASK_ROOM_CELLS) setFloor(cell.x, cell.y);
  // Passable, but outside the masked room's own cells.
  setFloor(3, 3);
  setFloor(4, 3);

  const roomGraph = new RoomGraph();
  roomGraph.add(
    { x: 0, y: 0, width: 6, height: 6 },
    [],
    [],
    RoomRole.TERRITORY,
    undefined,
    undefined,
    MASK_ROOM_CELLS.map((cell) => ({ ...cell })),
  );

  return new FloorMap(
    TINY_FLOOR3_MAP_CONFIG,
    new TileMap(TINY_FLOOR3_MAP_WIDTH, TINY_FLOOR3_MAP_HEIGHT, flags),
    roomGraph,
    terrain,
    { x: 1, y: 1 },
  );
}

/** Distinct `x,y` keys across a pending-spawn list. */
function distinctSpawnPositions(pendings: readonly { x?: number; y?: number }[]): number {
  return new Set(pendings.map((pending) => `${pending.x},${pending.y}`)).size;
}

describe('floor3 studios + final four objective tick', () => {
  it('is deterministic: same seed produces the same Studio/Final-Four assignment', () => {
    const { world: worldA } = createFloor3World(4242);
    const { world: worldB } = createFloor3World(4242);
    const stateA = worldA.floorExtendedState?.floor3Studios;
    const stateB = worldB.floorExtendedState?.floor3Studios;
    expect(stateA).toBeDefined();
    expect(stateB).toBeDefined();
    expect(
      stateA!.studios.map((s) => ({
        id: s.id,
        roomId: s.roomId,
        setPieceId: s.setPieceId,
        setPieceCarved: s.setPieceCarved,
        teamIds: s.teamIds,
        unlockLevel: s.unlockLevel,
      })),
    ).toEqual(
      stateB!.studios.map((s) => ({
        id: s.id,
        roomId: s.roomId,
        setPieceId: s.setPieceId,
        setPieceCarved: s.setPieceCarved,
        teamIds: s.teamIds,
        unlockLevel: s.unlockLevel,
      })),
    );
    expect({
      roomId: stateA!.finalFour.roomId,
      setPieceId: stateA!.finalFour.setPieceId,
      setPieceCarved: stateA!.finalFour.setPieceCarved,
    }).toEqual({
      roomId: stateB!.finalFour.roomId,
      setPieceId: stateB!.finalFour.setPieceId,
      setPieceCarved: stateB!.finalFour.setPieceCarved,
    });
    expect(stateA!.finalFourRounds).toEqual(stateB!.finalFourRounds);
  });

  it('assigns authored set-piece rooms to every selected Studio and the Final Four', () => {
    const { world } = createFloor3World(909);
    const state = world.floorExtendedState!.floor3Studios!;

    expect(world.setPieceProps.length).toBeGreaterThan(0);
    for (const studio of state.studios) {
      expect(studio.roomId).toBeGreaterThanOrEqual(0);
      expect(studio.setPieceId).toMatch(/^floor3-studio-/);
      expect(studio.setPieceCarved).toBe(true);
      for (const pending of studio.pendingSpawns) {
        expect(pending.x).toBeDefined();
        expect(pending.y).toBeDefined();
      }
      // A carved room drops its `interiorCells` mask, so the roster must be
      // fanned across bounds-inset passable tiles rather than stacked on the
      // room centre.
      expect(distinctSpawnPositions(studio.pendingSpawns)).toBe(studio.pendingSpawns.length);
    }
    expect(state.finalFour.roomId).toBeGreaterThanOrEqual(0);
    expect(state.finalFour.setPieceId).toBe('floor3-final-four-arena');
    expect(state.finalFour.setPieceCarved).toBe(true);
    const finalFourRoom = world.floorMap?.roomGraph.get(state.finalFour.roomId);
    expect(finalFourRoom?.role).toBe(RoomRole.BOSS_STAIR);
    expect(finalFourRoom?.label).toBe('floor3_final_four_arena');
    const finalFourPendingSpawns = state.finalFourRounds.flatMap((round) => round.pendingSpawns);
    for (const pending of finalFourPendingSpawns) {
      expect(pending.x).toBeDefined();
      expect(pending.y).toBeDefined();
    }
    expect(distinctSpawnPositions(finalFourPendingSpawns)).toBe(finalFourPendingSpawns.length);
  });

  it('keeps authored set-piece ids and spawn positions when territory rooms are too small to carve', () => {
    const world = createTestWorld({ seed: 910, floor: 3 });
    const playerEid = spawnPlayer(world, 0, 0);
    initializeFloor3Scenario(world, playerEid, { floorMapOverride: createTinyFloor3Map() });
    const state = world.floorExtendedState!.floor3Studios!;

    expect(world.setPieceProps.length).toBeGreaterThan(0);
    for (const studio of state.studios) {
      expect(studio.roomId).toBeGreaterThanOrEqual(0);
      expect(studio.setPieceId).toMatch(/^floor3-studio-/);
      expect(studio.setPieceCarved).toBe(false);
      expect(studio.pendingSpawns.length).toBeGreaterThan(0);
      for (const pending of studio.pendingSpawns) {
        expect(pending.x).toBeDefined();
        expect(pending.y).toBeDefined();
      }
    }
    expect(state.finalFour.roomId).toBeGreaterThanOrEqual(0);
    expect(state.finalFour.setPieceId).toBe('floor3-final-four-arena');
    expect(state.finalFour.setPieceCarved).toBe(false);
    for (const pending of state.finalFourRounds.flatMap((round) => round.pendingSpawns)) {
      expect(pending.x).toBeDefined();
      expect(pending.y).toBeDefined();
    }
  });

  it('keeps roster spawns on an irregular room mask instead of leaking into its bounding box', () => {
    const world = createTestWorld({ seed: 911, floor: 3 });
    const playerEid = spawnPlayer(world, 0, 0);
    const floorMap = createMaskedFloor3Map();
    initializeFloor3Scenario(world, playerEid, { floorMapOverride: floorMap });
    const state = world.floorExtendedState!.floor3Studios!;

    const maskKeys = new Set(MASK_ROOM_CELLS.map((cell) => `${cell.x},${cell.y}`));
    const pendings = state.studios.flatMap((studio) => studio.pendingSpawns);
    expect(pendings.length).toBeGreaterThan(0);
    for (const studio of state.studios) {
      expect(studio.setPieceCarved).toBe(false);
    }
    for (const pending of pendings) {
      const tile = floorMap.worldToTile(pending.x!, pending.y!);
      expect(maskKeys.has(`${tile.x},${tile.y}`)).toBe(true);
    }
  });

  it('gates each Studio roster spawn behind its own seeded unlock level (spec R6 soft-gate)', () => {
    const { world } = createFloor3World(101);
    const state = world.floorExtendedState!.floor3Studios!;
    expect(state.studios.length).toBeGreaterThan(0);
    // Nothing is spawned at floor init — every Studio (like the Final Four)
    // is deferred behind its own gate until `floor3ObjectiveTick` unlocks it.
    for (const studio of state.studios) {
      expect(studio.unlocked).toBe(false);
      expect(countCompanionsOnTeams(world, studio.teamIds)).toBe(0);
    }
    expect(state.finalFourRounds).toHaveLength(4);
    expect(state.finalFourRounds.every((round) => round.pendingSpawns.length > 0)).toBe(true);
    expect(countCompanionsOnTeams(world, state.finalFour.teamIds)).toBe(0);

    // At floor-start player level, only the 0-threshold Studio(s) unlock.
    floor3ObjectiveTick(world);
    const unlockedAtStart = state.studios.filter((s) => s.unlocked);
    expect(unlockedAtStart.length).toBeGreaterThan(0);
    expect(unlockedAtStart.length).toBeLessThan(state.studios.length);
    for (const studio of unlockedAtStart) {
      expect(countCompanionsOnTeams(world, studio.teamIds)).toBeGreaterThan(0);
    }
    for (const studio of state.studios.filter((s) => !s.unlocked)) {
      expect(countCompanionsOnTeams(world, studio.teamIds)).toBe(0);
    }

    // Leveling up past every threshold unlocks the rest, any order.
    world.playerLevel.level = Math.max(...state.studios.map((s) => s.unlockLevel));
    floor3ObjectiveTick(world);
    for (const studio of state.studios) {
      expect(studio.unlocked).toBe(true);
      expect(countCompanionsOnTeams(world, studio.teamIds)).toBeGreaterThan(0);
    }
  });

  it('increments studiosDefeatedCount and latches per-studio goal flags as each Studio is wiped', () => {
    const { world } = createFloor3World(202);
    const state = world.floorExtendedState!.floor3Studios!;
    const [firstStudio] = state.studios;
    expect(firstStudio).toBeDefined();
    expect(firstStudio!.unlockLevel).toBe(0);

    floor3ObjectiveTick(world); // unlocks + spawns the floor-start Studio
    knockOutTeams(world, firstStudio!.teamIds);
    floor3ObjectiveTick(world);

    expect(state.studiosDefeatedCount).toBe(1);
    expect(firstStudio!.defeated).toBe(true);
    expect(world.goalFlags.get(floor3StudioDefeatGoalId(firstStudio!.id))).toBe(true);
    expect(world.goalFlags.get(FLOOR3_FINAL_FOUR_UNLOCK_GOAL_ID)).toBe(false);
  });

  it('completes four ordered Final Four handler rounds and latches victory only after wipe four', () => {
    const { world } = createFloor3World(303);
    const state = world.floorExtendedState!.floor3Studios!;
    const seededHandlerOrder = state.finalFourRounds.map((round) => round.handlerId);

    defeatAllStudios(world, state);

    expect(state.studiosDefeatedCount).toBe(state.studios.length);
    expect(world.goalFlags.get(FLOOR3_FINAL_FOUR_UNLOCK_GOAL_ID)).toBe(true);
    expect(state.finalFourRoundIndex).toBe(0);
    expect(state.finalFourRounds[0]?.pendingSpawns).toHaveLength(0);
    expect(state.finalFourRounds.slice(1).every((round) => round.pendingSpawns.length > 0)).toBe(
      true,
    );
    expect(countCompanionsOnTeams(world, state.finalFour.teamIds)).toBeGreaterThan(0);
    expect(world.goalFlags.get(FLOOR3_VICTORY_GOAL_ID)).toBe(false);

    for (let round = 0; round < 4; round += 1) {
      knockOutTeams(world, state.finalFour.teamIds);
      floor3ObjectiveTick(world);
      expect(state.finalFourRoundIndex).toBe(round + 1);
      expect(state.finalFourRounds[round]?.defeated).toBe(true);
      expect(state.finalFourRounds.map((entry) => entry.handlerId)).toEqual(seededHandlerOrder);
      expect(world.goalFlags.get(FLOOR3_VICTORY_GOAL_ID)).toBe(round === 3);
      if (round < 3) {
        expect(countCompanionsOnTeams(world, state.finalFour.teamIds)).toBeGreaterThan(0);
      }
    }

    expect(state.finalFour.defeated).toBe(true);
    expect(world.goalFlags.get(FLOOR3_STAIRS_POPPED_GOAL_ID)).toBe(true);
    expect(state.staircaseSpawned).toBe(true);
    expect(state.staircaseUnlocked).toBe(true);
    expect(state.staircasePos).toEqual(
      world.floorMap!.tileToWorld(world.floorMap!.playerSpawn.x, world.floorMap!.playerSpawn.y),
    );

    expect(confirmFloor3StairDescend(world, 0)).toBe(false);
    const keptEid = query(world.ecs, [Companion, Team]).find(
      (eid) => (world.stores.team.id[eid] ?? -1) === TeamId.PLAYER,
    );
    expect(keptEid).toBeDefined();
    expect(selectFloor3KeptCompanion(world, keptEid!)).toBe(true);
    const confirmed = confirmFloor3StairDescend(world, 0);
    expect(confirmed).toBe(true);
    expect(world.state).toBe('safe_room');
    expect(world.goalFlags.get(FLOOR3_STAIRS_DISCOVERED_GOAL_ID)).toBe(true);
  });

  it('does not double-spawn the Final Four roster on repeated ticks after unlock', () => {
    const { world } = createFloor3World(404);
    const state = world.floorExtendedState!.floor3Studios!;
    defeatAllStudios(world, state);
    const countAfterFirstTick = countCompanionsOnTeams(world, state.finalFour.teamIds);

    floor3ObjectiveTick(world);
    floor3ObjectiveTick(world);

    expect(countCompanionsOnTeams(world, state.finalFour.teamIds)).toBe(countAfterFirstTick);
  });

  it('relocates a Final Four spawn off the tile the player is standing on at unlock', () => {
    const { world, playerEid } = createFloor3World(404);
    const state = world.floorExtendedState!.floor3Studios!;
    const floorMap = world.floorMap!;
    const occupied = state.finalFourRounds[0]!.pendingSpawns[0]!;
    expect(occupied.x).toBeDefined();
    // Park the player exactly on a pre-resolved arena spawn point before the
    // last Studio falls — the arena-backed path must still relocate.
    world.stores.position.x[playerEid] = occupied.x!;
    world.stores.position.y[playerEid] = occupied.y!;
    const playerTile = floorMap.worldToTile(occupied.x!, occupied.y!);

    defeatAllStudios(world, state);

    const companions = Array.from(query(world.ecs, [Companion, Team]));
    const spawnTiles = companions
      .filter((eid) => state.finalFour.teamIds.includes(world.stores.team.id[eid] ?? -1))
      .map((eid) =>
        floorMap.worldToTile(world.stores.position.x[eid] ?? 0, world.stores.position.y[eid] ?? 0),
      );
    expect(spawnTiles.length).toBeGreaterThan(0);
    for (const tile of spawnTiles) {
      expect(`${tile.x},${tile.y}`).not.toBe(`${playerTile.x},${playerTile.y}`);
      expect(floorMap.tileMap.isPassable(tile.x, tile.y)).toBe(true);
    }
    expect(new Set(spawnTiles.map((tile) => `${tile.x},${tile.y}`)).size).toBe(spawnTiles.length);
  });

  it('triggers game_over on a party wipe before victory is latched', () => {
    const { world } = createFloor3World(505);
    const partyEid = recruitPartyCompanion(world, {
      x: 0,
      y: 0,
      hp: 10,
      aiType: AI_TYPE.CHASE,
      speed: 0.1,
      aggroRange: 999,
      attackRange: 0,
      speciesToken: 0,
      level: 1,
      ownerTeam: TeamId.PLAYER,
    });
    expect(partyEid).toBeDefined();
    // Also KOs the starter Companion (spec R5 §6.1, already on the party from
    // `createFloor3World`) — a genuine wipe requires every party member down,
    // not just the one recruited in this test.
    knockOutTeams(world, [TeamId.PLAYER]);

    floor3ObjectiveTick(world);

    expect(world.state).toBe('game_over');
    expect(world.goalFlags.get(FLOOR3_VICTORY_GOAL_ID)).toBe(false);
  });

  it('does not trigger game_over on a party wipe once victory has already latched', () => {
    const { world } = createFloor3World(606);
    const state = world.floorExtendedState!.floor3Studios!;
    defeatAllStudios(world, state);
    defeatFinalFour(world, state);
    expect(world.goalFlags.get(FLOOR3_VICTORY_GOAL_ID)).toBe(true);
    expect(world.state).toBe('playing');

    // The party is full of poached Companions by now (one pick per Studio),
    // so wipe the whole player party rather than recruiting another member.
    knockOutTeams(world, [TeamId.PLAYER]);

    floor3ObjectiveTick(world);

    expect(world.state).toBe('playing');
  });

  it('shares a single team id per Studio and per Final Four (no friendly fire between trainers/handlers)', () => {
    const { world } = createFloor3World(707);
    const state = world.floorExtendedState!.floor3Studios!;
    // Real Studios/Final-Four have >1 Trainer/Handler contributing Companions.
    // companionAISystem treats any different-Team.id Companion as a rival, so
    // every Companion within one encounter MUST share one team id or trainers
    // within the same Studio would fight each other (plan-review finding).
    for (const studio of state.studios) {
      expect(studio.teamIds).toHaveLength(1);
    }
    expect(state.finalFour.teamIds).toHaveLength(1);
    const allTeamIds = [...state.studios.map((s) => s.teamIds[0]), state.finalFour.teamIds[0]];
    expect(new Set(allTeamIds).size).toBe(allTeamIds.length);
  });

  it('despawns a Studio roster once defeated so the generic engagement-end revival cannot resurrect it', () => {
    const { world } = createFloor3World(808);
    const state = world.floorExtendedState!.floor3Studios!;
    const [firstStudio] = state.studios;
    expect(firstStudio).toBeDefined();
    expect(firstStudio!.unlockLevel).toBe(0);

    floor3ObjectiveTick(world); // unlocks + spawns the floor-start Studio
    expect(countCompanionsOnTeams(world, firstStudio!.teamIds)).toBeGreaterThan(0);

    knockOutTeams(world, firstStudio!.teamIds);
    floor3ObjectiveTick(world);

    expect(firstStudio!.defeated).toBe(true);
    // Companions are removed from the ECS entirely, not merely left KO'd —
    // companionKOSystem's per-team engagement-end revival would otherwise
    // revive them to full health once no rival lingers nearby.
    expect(countCompanionsOnTeams(world, firstStudio!.teamIds)).toBe(0);
  });

  it('despawns the Final Four roster once victory latches', () => {
    const { world } = createFloor3World(909);
    const state = world.floorExtendedState!.floor3Studios!;
    defeatAllStudios(world, state);
    defeatFinalFour(world, state);

    expect(state.finalFour.defeated).toBe(true);
    expect(countCompanionsOnTeams(world, state.finalFour.teamIds)).toBe(0);
  });

  it('halts ambient wild spawning after victory latches', () => {
    const { world } = createFloor3World(910);
    const state = world.floorExtendedState!.floor3Studios!;
    defeatAllStudios(world, state);
    defeatFinalFour(world, state);
    expect(world.goalFlags.get(FLOOR3_VICTORY_GOAL_ID)).toBe(true);

    const before = world.floorExtendedState?.ambientEnemyArchetypes?.size ?? 0;
    for (let i = 0; i < 5; i += 1) {
      world.elapsedMs += 1_000;
      floor3WildDirectorSystem(world);
    }
    const after = world.floorExtendedState?.ambientEnemyArchetypes?.size ?? 0;
    expect(after).toBe(before);
  });
});

describe('floor3 kept-companion producer hook (slice 11)', () => {
  it('leaves real-play selection empty at victory and offers an explicit deterministic headless default', () => {
    const { world } = createFloor3World(1010);
    const state = world.floorExtendedState!.floor3Studios!;
    expect(state.keptCompanionEid).toBeUndefined();

    defeatAllStudios(world, state);
    defeatFinalFour(world, state);

    expect(world.goalFlags.get(FLOOR3_VICTORY_GOAL_ID)).toBe(true);
    expect(state.keptCompanionEid).toBeUndefined();
    expect(confirmFloor3StairDescend(world, 0)).toBe(false);
    expect(getScenarioDefinition('floor3').autoSelectKeptCompanion?.(world)).toBe(true);
    expect(state.keptCompanionEid).toBeDefined();
    expect(query(world.ecs, [Companion, Team])).toContain(state.keptCompanionEid);
  });

  it('lets selectFloor3KeptCompanion set the required pick to any live party Companion', () => {
    const { world } = createFloor3World(1011);
    const state = world.floorExtendedState!.floor3Studios!;
    const secondPartyEid = recruitPartyCompanion(world, {
      x: 0,
      y: 0,
      hp: 10,
      aiType: AI_TYPE.CHASE,
      speed: 0.1,
      aggroRange: 999,
      attackRange: 0,
      speciesToken: 0,
      level: 1,
      ownerTeam: TeamId.PLAYER,
    });
    expect(secondPartyEid).toBeDefined();

    defeatAllStudios(world, state);
    defeatFinalFour(world, state);
    expect(state.keptCompanionEid).toBeUndefined();

    const result = selectFloor3KeptCompanion(world, secondPartyEid!);

    expect(result).toBe(true);
    expect(state.keptCompanionEid).toBe(secondPartyEid);
  });

  it('blocks stair descent when a previously selected Companion is no longer a valid party member', () => {
    const { world } = createFloor3World(1016);
    const state = world.floorExtendedState!.floor3Studios!;
    defeatAllStudios(world, state);
    defeatFinalFour(world, state);
    const keptEid = query(world.ecs, [Companion, Team]).find(
      (eid) => (world.stores.team.id[eid] ?? -1) === TeamId.PLAYER,
    );
    expect(keptEid).toBeDefined();
    expect(selectFloor3KeptCompanion(world, keptEid!)).toBe(true);

    world.stores.team.id[keptEid!] = 999;

    expect(confirmFloor3StairDescend(world, 0)).toBe(false);
    expect(world.state).toBe('playing');
    expect(state.staircaseDiscovered).not.toBe(true);
  });

  it('rejects a knocked-out Companion and makes the headless default choose a live party member', () => {
    const { world } = createFloor3World(1017);
    const state = world.floorExtendedState!.floor3Studios!;
    const livePartyEid = recruitPartyCompanion(world, {
      x: 0,
      y: 0,
      hp: 10,
      aiType: AI_TYPE.CHASE,
      speed: 0.1,
      aggroRange: 999,
      attackRange: 0,
      speciesToken: 1,
      level: 2,
      ownerTeam: TeamId.PLAYER,
    });
    defeatAllStudios(world, state);
    defeatFinalFour(world, state);
    const firstPartyEid = query(world.ecs, [Companion, Team]).find(
      (eid) => (world.stores.team.id[eid] ?? -1) === TeamId.PLAYER,
    );
    expect(firstPartyEid).toBeDefined();
    expect(livePartyEid).toBeDefined();
    world.stores.companion.knockedOut[firstPartyEid!] = 1;

    expect(selectFloor3KeptCompanion(world, firstPartyEid!)).toBe(false);
    expect(getScenarioDefinition('floor3').autoSelectKeptCompanion?.(world)).toBe(true);
    expect(state.keptCompanionEid).toBe(livePartyEid);
    expect(confirmFloor3StairDescend(world, 0)).toBe(true);
  });

  it('returns false and does not mutate the pick when selectFloor3KeptCompanion is called before victory latches', () => {
    const { world } = createFloor3World(1012);
    const state = world.floorExtendedState!.floor3Studios!;
    expect(world.goalFlags.get(FLOOR3_VICTORY_GOAL_ID)).not.toBe(true);
    const [starterEid] = query(world.ecs, [Companion, Team]);
    expect(starterEid).toBeDefined();

    const result = selectFloor3KeptCompanion(world, starterEid!);

    expect(result).toBe(false);
    expect(state.keptCompanionEid).toBeUndefined();
  });

  it('returns false and does not mutate the pick for an invalid or non-party entity', () => {
    const { world } = createFloor3World(1013);
    const state = world.floorExtendedState!.floor3Studios!;
    defeatAllStudios(world, state);
    defeatFinalFour(world, state);

    const result = selectFloor3KeptCompanion(world, 999_999);

    expect(result).toBe(false);
    expect(state.keptCompanionEid).toBeUndefined();
  });

  it('resolves the kept-companion pick into a valid KeptCompanionContract on capturePlayerCarryover', () => {
    const { world, playerEid } = createFloor3World(1014);
    const state = world.floorExtendedState!.floor3Studios!;
    defeatAllStudios(world, state);
    defeatFinalFour(world, state);
    expect(getScenarioDefinition('floor3').autoSelectKeptCompanion?.(world)).toBe(true);
    const keptEid = state.keptCompanionEid;
    expect(keptEid).toBeDefined();
    const expectedSpecies = speciesForToken(world.stores.companion.speciesToken[keptEid!] ?? 0);
    expect(expectedSpecies).toBeDefined();

    const snapshot = capturePlayerCarryover(world, playerEid);

    const ultimateFormLevel = ABILITY_MILESTONE_LEVELS[ABILITY_MILESTONE_LEVELS.length - 1] ?? 0;
    const expectedAbilityIds = learnedAbilityIds(expectedSpecies!, ultimateFormLevel);
    expect(expectedAbilityIds.length).toBeGreaterThan(1);

    expect(snapshot.keptCompanion).toEqual({
      schemaVersion: KEPT_COMPANION_CONTRACT_SCHEMA_VERSION,
      speciesId: expectedSpecies!.speciesId,
      affinity: expectedSpecies!.affinity,
      fightingStyle: expectedSpecies!.fightingStyle,
      form: 2,
      levelBand: 'floor3-graduate',
      learnedAbilityIds: expectedAbilityIds,
    });
  });

  it('omits keptCompanion from the carryover snapshot outside Floor 3', () => {
    const world = createTestWorld({ seed: 1015 });
    const playerEid = spawnPlayer(world, 0, 0);

    const snapshot = capturePlayerCarryover(world, playerEid);

    expect(snapshot.keptCompanion).toBeUndefined();
  });
});
