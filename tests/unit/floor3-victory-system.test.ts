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
  floor3WildDirectorSystem,
  floor3StudioDefeatGoalId,
  initializeFloor3Scenario,
  selectFloor3StarterCompanion,
} from '../../src/game/floor3Scenario.js';
import { createTestWorld } from '../helpers/world-factory.js';
import type { GameWorld } from '../../src/core/index.js';

function createFloor3World(seed: number) {
  const world = createTestWorld({ seed, floor: 3 });
  const playerEid = spawnPlayer(world, 0, 0);
  initializeFloor3Scenario(world, playerEid);
  // Confirm the starter-Companion pick (spec R5 §6.1) so the world lands in
  // 'playing' the way a real run does — `initializeFloor3Scenario` now pauses
  // on 'loadout' until a pick is made, mirroring Floor 1's weapon loadout.
  selectFloor3StarterCompanion(world, 0);
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
        teamIds: s.teamIds,
        unlockLevel: s.unlockLevel,
      })),
    ).toEqual(
      stateB!.studios.map((s) => ({
        id: s.id,
        roomId: s.roomId,
        teamIds: s.teamIds,
        unlockLevel: s.unlockLevel,
      })),
    );
    expect(stateA!.finalFourPendingSpawns).toEqual(stateB!.finalFourPendingSpawns);
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
    expect(state.finalFourPendingSpawns.length).toBeGreaterThan(0);
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

  it('unlocks and spawns the Final Four once every Studio is defeated, then latches victory when it is wiped', () => {
    const { world } = createFloor3World(303);
    const state = world.floorExtendedState!.floor3Studios!;

    defeatAllStudios(world, state);

    expect(state.studiosDefeatedCount).toBe(state.studios.length);
    expect(world.goalFlags.get(FLOOR3_FINAL_FOUR_UNLOCK_GOAL_ID)).toBe(true);
    expect(state.finalFourPendingSpawns.length).toBe(0);
    expect(countCompanionsOnTeams(world, state.finalFour.teamIds)).toBeGreaterThan(0);
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
    defeatAllStudios(world, state);
    const countAfterFirstTick = countCompanionsOnTeams(world, state.finalFour.teamIds);

    floor3ObjectiveTick(world);
    floor3ObjectiveTick(world);

    expect(countCompanionsOnTeams(world, state.finalFour.teamIds)).toBe(countAfterFirstTick);
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
    knockOutTeams(world, state.finalFour.teamIds);
    floor3ObjectiveTick(world);

    expect(state.finalFour.defeated).toBe(true);
    expect(countCompanionsOnTeams(world, state.finalFour.teamIds)).toBe(0);
  });

  it('halts ambient wild spawning after victory latches', () => {
    const { world } = createFloor3World(910);
    const state = world.floorExtendedState!.floor3Studios!;
    defeatAllStudios(world, state);
    knockOutTeams(world, state.finalFour.teamIds);
    floor3ObjectiveTick(world);
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
