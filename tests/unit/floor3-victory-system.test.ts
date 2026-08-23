import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { recruitPartyCompanion, spawnPlayer } from '../../src/core/helpers.js';
import { AI_TYPE } from '../../src/game/index.js';
import { TeamId } from '../../src/shared/constants.js';
import { Companion, Team } from '../../src/core/index.js';
import {
  FLOOR3_FINAL_FOUR_UNLOCK_GOAL_ID,
  FLOOR3_STAIRS_DISCOVERED_GOAL_ID,
  FLOOR3_STAIRS_POPPED_GOAL_ID,
  FLOOR3_VICTORY_GOAL_ID,
  confirmFloor3StairDescend,
  floor3ObjectiveTick,
  floor3StudioDefeatGoalId,
  initializeFloor3Scenario,
} from '../../src/game/floor3Scenario.js';
import { createTestWorld } from '../helpers/world-factory.js';
import type { GameWorld } from '../../src/core/index.js';

function createFloor3World(seed: number) {
  const world = createTestWorld({ seed, floor: 3 });
  const playerEid = spawnPlayer(world, 0, 0);
  initializeFloor3Scenario(world, playerEid);
  return { world, playerEid };
}

/** Knocks out every Companion belonging to any of `teamIds`. */
function knockOutTeams(world: GameWorld, teamIds: readonly number[]): void {
  const companions = query(world.ecs, [Companion, Team]);
  for (const eid of companions) {
    if (!teamIds.includes(world.stores.team.id[eid] ?? -1)) continue;
    world.stores.companion.knockedOut[eid] = 1;
  }
}

function countLiveCompanionsOnTeams(world: GameWorld, teamIds: readonly number[]): number {
  const companions = query(world.ecs, [Companion, Team]);
  let count = 0;
  for (const eid of companions) {
    if (teamIds.includes(world.stores.team.id[eid] ?? -1)) count += 1;
  }
  return count;
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
      stateA!.studios.map((s) => ({ id: s.id, roomId: s.roomId, teamIds: s.teamIds })),
    ).toEqual(stateB!.studios.map((s) => ({ id: s.id, roomId: s.roomId, teamIds: s.teamIds })));
    expect(stateA!.finalFourPendingSpawns).toEqual(stateB!.finalFourPendingSpawns);
  });

  it('spawns every Studio roster immediately but defers the Final Four roster', () => {
    const { world } = createFloor3World(101);
    const state = world.floorExtendedState!.floor3Studios!;
    expect(state.studios.length).toBeGreaterThan(0);
    for (const studio of state.studios) {
      expect(countLiveCompanionsOnTeams(world, studio.teamIds)).toBeGreaterThan(0);
    }
    expect(state.finalFourPendingSpawns.length).toBeGreaterThan(0);
    expect(countLiveCompanionsOnTeams(world, state.finalFour.teamIds)).toBe(0);
  });

  it('increments studiosDefeatedCount and latches per-studio goal flags as each Studio is wiped', () => {
    const { world } = createFloor3World(202);
    const state = world.floorExtendedState!.floor3Studios!;
    const [firstStudio] = state.studios;
    expect(firstStudio).toBeDefined();

    knockOutTeams(world, firstStudio!.teamIds);
    floor3ObjectiveTick(world);

    expect(state.studiosDefeatedCount).toBe(1);
    expect(firstStudio!.defeated).toBe(true);
    expect(world.goalFlags.get(floor3StudioDefeatGoalId(firstStudio!.id))).toBe(true);
    expect(world.goalFlags.get(FLOOR3_FINAL_FOUR_UNLOCK_GOAL_ID)).toBe(false);
  });

  it('unlocks and spawns the Final Four once every Studio is defeated, then latches victory when it is wiped', () => {
    const { world } = createFloor3World(303);
    const state = world.floorExtendedState!.floor3Studios!;

    for (const studio of state.studios) {
      knockOutTeams(world, studio.teamIds);
    }
    floor3ObjectiveTick(world);

    expect(state.studiosDefeatedCount).toBe(state.studios.length);
    expect(world.goalFlags.get(FLOOR3_FINAL_FOUR_UNLOCK_GOAL_ID)).toBe(true);
    expect(state.finalFourPendingSpawns.length).toBe(0);
    expect(countLiveCompanionsOnTeams(world, state.finalFour.teamIds)).toBeGreaterThan(0);
    expect(world.goalFlags.get(FLOOR3_VICTORY_GOAL_ID)).toBe(false);

    knockOutTeams(world, state.finalFour.teamIds);
    floor3ObjectiveTick(world);

    expect(state.finalFour.defeated).toBe(true);
    expect(world.goalFlags.get(FLOOR3_VICTORY_GOAL_ID)).toBe(true);
    expect(world.goalFlags.get(FLOOR3_STAIRS_POPPED_GOAL_ID)).toBe(true);
    expect(state.staircaseSpawned).toBe(true);
    expect(state.staircaseUnlocked).toBe(true);
    expect(state.staircasePos).toEqual(
      world.floorMap!.tileToWorld(world.floorMap!.playerSpawn.x, world.floorMap!.playerSpawn.y),
    );

    const confirmed = confirmFloor3StairDescend(world, 0);
    expect(confirmed).toBe(true);
    expect(world.state).toBe('safe_room');
    expect(world.goalFlags.get(FLOOR3_STAIRS_DISCOVERED_GOAL_ID)).toBe(true);
  });

  it('does not double-spawn the Final Four roster on repeated ticks after unlock', () => {
    const { world } = createFloor3World(404);
    const state = world.floorExtendedState!.floor3Studios!;
    for (const studio of state.studios) {
      knockOutTeams(world, studio.teamIds);
    }
    floor3ObjectiveTick(world);
    const countAfterFirstTick = countLiveCompanionsOnTeams(world, state.finalFour.teamIds);

    floor3ObjectiveTick(world);
    floor3ObjectiveTick(world);

    expect(countLiveCompanionsOnTeams(world, state.finalFour.teamIds)).toBe(countAfterFirstTick);
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
    world.stores.companion.knockedOut[partyEid!] = 1;

    floor3ObjectiveTick(world);

    expect(world.state).toBe('game_over');
    expect(world.goalFlags.get(FLOOR3_VICTORY_GOAL_ID)).toBe(false);
  });

  it('does not trigger game_over on a party wipe once victory has already latched', () => {
    const { world } = createFloor3World(606);
    const state = world.floorExtendedState!.floor3Studios!;
    for (const studio of state.studios) {
      knockOutTeams(world, studio.teamIds);
    }
    floor3ObjectiveTick(world);
    knockOutTeams(world, state.finalFour.teamIds);
    floor3ObjectiveTick(world);
    expect(world.goalFlags.get(FLOOR3_VICTORY_GOAL_ID)).toBe(true);
    expect(world.state).toBe('playing');

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
    world.stores.companion.knockedOut[partyEid!] = 1;

    floor3ObjectiveTick(world);

    expect(world.state).toBe('playing');
  });
});
