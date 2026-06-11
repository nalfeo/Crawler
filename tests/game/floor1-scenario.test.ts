import { removeEntity } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import {
  confirmFloor1StairDescend,
  floor1EnemyDirectorSystem,
  floor1ObjectiveSystem,
  initializeFloor1Scenario,
  selectFloor1StarterWeapon,
} from '../../src/game/floor1Scenario.js';
import { getActiveWeapon } from '../../src/game/weaponSystem.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('floor1Scenario', () => {
  it('initializes Floor 1 into loadout state with deterministic starter choices', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);

    initializeFloor1Scenario(world, player);

    expect(world.state).toBe('loadout');
    expect(world.floorMap).not.toBeNull();
    expect(world.floor1).not.toBeNull();
    expect(world.floor1?.protagonistName).toBe('Rhea Vale');
    expect(world.floor1?.starterChoices).toHaveLength(3);
    expect(new Set(world.floor1?.starterChoices ?? []).size).toBe(3);
  });

  it('applies selected starter weapon and transitions to playing', () => {
    const world = createTestWorld({ seed: 14 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);

    const chosenId = world.floor1?.starterChoices[1];
    selectFloor1StarterWeapon(world, 1);

    expect(world.state).toBe('playing');
    expect(world.floor1?.selectedWeaponId).toBe(chosenId);
    expect(getActiveWeapon(world)?.id).toBe(chosenId);
  });

  it('times out the run when the staircase deadline is missed', () => {
    const world = createTestWorld({ seed: 7 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);

    const deadlineMs = world.floor1?.objective.deadlineMs ?? 0;
    world.elapsedMs = deadlineMs + 1;
    floor1ObjectiveSystem(world);

    expect(world.state).toBe('game_over');
    expect(world.floor1?.failReason).toBe('stair_timeout');
    expect(world.floor1?.runSummary?.outcome).toBe('failed_timeout');
  });

  it('spawns deterministic rat/slime encounters from the floor director', () => {
    const worldA = createTestWorld({ seed: 99 });
    const worldB = createTestWorld({ seed: 99 });
    const playerA = spawnPlayer(worldA, 0, 0);
    const playerB = spawnPlayer(worldB, 0, 0);
    initializeFloor1Scenario(worldA, playerA);
    initializeFloor1Scenario(worldB, playerB);
    selectFloor1StarterWeapon(worldA, 0);
    selectFloor1StarterWeapon(worldB, 0);

    worldA.elapsedMs = 1000;
    worldB.elapsedMs = 1000;
    floor1EnemyDirectorSystem(worldA);
    floor1EnemyDirectorSystem(worldB);

    const spawnedA = [...(worldA.floor1?.enemyArchetypes.entries() ?? [])][0];
    const spawnedB = [...(worldB.floor1?.enemyArchetypes.entries() ?? [])][0];

    expect(spawnedA).toBeDefined();
    expect(spawnedB).toBeDefined();

    if (!spawnedA || !spawnedB) {
      throw new Error('Expected both worlds to spawn a floor1 enemy');
    }

    const [eidA, archetypeA] = spawnedA;
    const [eidB, archetypeB] = spawnedB;
    expect(archetypeA).toBe(archetypeB);
    expect(worldA.stores.position.x[eidA]).toBeCloseTo(worldB.stores.position.x[eidB] ?? 0, 5);
    expect(worldA.stores.position.y[eidA]).toBeCloseTo(worldB.stores.position.y[eidB] ?? 0, 5);
  });

  it('starts boss battle on boss-room entry after goon quest, then spawns stairs after boss death', () => {
    const world = createTestWorld({ seed: 123 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);

    const objective = world.floor1?.objective;
    if (!objective) {
      throw new Error('Expected floor1 objective to exist');
    }

    objective.ratsKilled = objective.requiredRats;
    objective.slimesKilled = objective.requiredSlimes;
    expect(objective.bossBattleStarted).toBe(false);
    expect(objective.staircaseBossEid).toBeNull();
    expect(objective.staircaseSpawned).toBe(false);
    expect(objective.staircaseLocked).toBe(true);
    expect(objective.staircaseUnlocked).toBe(false);

    // Kills do not complete the quest until the player talks to the goon.
    world.elapsedMs = 1_000;
    floor1ObjectiveSystem(world);
    expect(objective.questCompleted).toBe(false);

    objective.questAccepted = true;
    floor1ObjectiveSystem(world);
    expect(objective.questCompleted).toBe(true);
    expect(objective.staircaseBossEid).toBeNull();

    world.stores.position.x[player] = objective.staircasePos.x;
    world.stores.position.y[player] = objective.staircasePos.y;
    floor1ObjectiveSystem(world);
    expect(objective.bossBattleStarted).toBe(true);
    expect(objective.staircaseDiscovered).toBe(false);

    const bossEid = objective.staircaseBossEid;
    if (bossEid === null) {
      throw new Error('Expected staircase boss to exist');
    }

    removeEntity(world.ecs, bossEid);
    floor1ObjectiveSystem(world);
    expect(objective.staircaseSpawned).toBe(true);
    expect(objective.staircaseLocked).toBe(false);
    expect(objective.staircaseUnlocked).toBe(true);
    expect(objective.staircaseBossDefeated).toBe(true);

    const descended = confirmFloor1StairDescend(world, player);
    expect(descended).toBe(true);
    expect(objective.staircaseDiscovered).toBe(true);
    expect(world.state).toBe('safe_room');
    expect(world.floor1?.runSummary?.outcome).toBe('cleared_floor');
  });
});
