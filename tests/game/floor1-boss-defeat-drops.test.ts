/**
 * Floor 1 boss-defeat drops and arena state — issue #3275 items 3 and 5.
 *
 * Item 3: "boss drop chests should drop where they died not in the middle of
 * their room." The reward chest used to spawn at the authored room anchor, so a
 * boss chased into a corner still dropped its chest in the centre of the arena.
 *
 * Item 5: "boss room turning to safe room after boss defeat doesn't seem to be
 * working." A cleared arena is the design's Commercial Break: once the boss is
 * dead the room becomes a safe room, opens the customization panels, and is
 * routable as a retreat anchor. Any live enemies already inside burst without
 * loot or XP before the room is safe to use.
 */

import { hasComponent, query, removeEntity } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { DroppedItem, Enemy, Gold, XpGem } from '../../src/core/components.js';
import {
  floorObjectiveSystem,
  initializeFloor1Scenario,
  meetSpellQuestGiver,
  meetShopkeeper,
  meetTutorialGoon,
  selectFloor1StarterWeapon,
} from '../../src/game/floorScenario.js';
import { questSystem } from '../../src/core/systems/questSystem.js';
import {
  isInSafeContext,
  isPointInClearedArena,
  isPointInSafeSpace,
  safeRoomSystem,
} from '../../src/core/safe-space.js';
import { createBossChestId } from '../../src/game/boss-chest-resolver.js';
import { createTestWorld } from '../helpers/world-factory.js';
import type { GameWorld } from '../../src/core/world.js';

const TILE_STEP = 32;

/** Drive the scenario up to the point where the Slime Rat battle can start. */
function advanceToSlimeRatGate(world: GameWorld, player: number): void {
  const objective = world.floorScenario!.objective;
  objective.ratsKilled = objective.requiredRats;
  objective.slimesKilled = objective.requiredSlimes;
  world.elapsedMs = 1_000;
  floorObjectiveSystem(world);
  meetTutorialGoon(world);
  meetShopkeeper(world);
  world.playerLevel.level = 2;
  floorObjectiveSystem(world);
  questSystem(world);
  floorObjectiveSystem(world);
  floorObjectiveSystem(world);
  meetSpellQuestGiver(world);
  world.stores.position.x[player] = objective.slimeRatRoomPos.x;
  world.stores.position.y[player] = objective.slimeRatRoomPos.y;
  floorObjectiveSystem(world);
}

function startedSlimeRatWorld(seed: number): { world: GameWorld; player: number } {
  const world = createTestWorld({ seed });
  const player = spawnPlayer(world, 0, 0);
  initializeFloor1Scenario(world, player);
  selectFloor1StarterWeapon(world, 0);
  advanceToSlimeRatGate(world, player);
  expect(world.floorScenario!.objective.bossBattles.get('slime-rat')!.started).toBe(true);
  return { world, player };
}

function slimeRatChestPos(world: GameWorld): { x: number; y: number } {
  const eid = world.bossChestEids.get(createBossChestId('floor1-slime-rat-boss'));
  expect(eid).toBeTypeOf('number');
  return { x: world.stores.position.x[eid!]!, y: world.stores.position.y[eid!]! };
}

describe('floor1 boss chest drops at the death spot', () => {
  it('spawns the chest where the boss was last seen, not at the room anchor', () => {
    const { world } = startedSlimeRatWorld(123);
    const objective = world.floorScenario!.objective;
    const bossEid = objective.bossBattles.get('slime-rat')!.bossEid!;

    // Nudge the boss off the anchor, as a real fight would.
    const deathX = world.stores.position.x[bossEid]! + TILE_STEP / 4;
    const deathY = world.stores.position.y[bossEid]! + TILE_STEP / 4;
    expect({ x: deathX, y: deathY }).not.toEqual(objective.slimeRatRoomPos);
    world.stores.position.x[bossEid] = deathX;
    world.stores.position.y[bossEid] = deathY;
    floorObjectiveSystem(world);

    removeEntity(world.ecs, bossEid);
    floorObjectiveSystem(world);
    expect(objective.bossBattles.get('slime-rat')!.defeated).toBe(true);
    expect(slimeRatChestPos(world)).toEqual({ x: deathX, y: deathY });
  });

  it('falls back to the room anchor when the death spot is outside the arena', () => {
    const { world } = startedSlimeRatWorld(123);
    const objective = world.floorScenario!.objective;
    const bossEid = objective.bossBattles.get('slime-rat')!.bossEid!;

    // A sample outside the boss's own room would strand the reward somewhere
    // the player may not be able to reach, so the anchor wins.
    world.stores.position.x[bossEid] = -10_000;
    world.stores.position.y[bossEid] = -10_000;
    floorObjectiveSystem(world);

    removeEntity(world.ecs, bossEid);
    floorObjectiveSystem(world);
    expect(slimeRatChestPos(world)).toEqual({
      x: objective.slimeRatRoomPos.x,
      y: objective.slimeRatRoomPos.y,
    });
  });
});

describe('floor1 cleared boss arena becomes a safe room', () => {
  it('is hostile ground while the boss lives and a safe room once it is defeated', () => {
    const { world, player } = startedSlimeRatWorld(123);
    const objective = world.floorScenario!.objective;
    const { x, y } = objective.slimeRatRoomPos;
    expect(isPointInClearedArena(world, x, y)).toBe(false);
    expect(isPointInSafeSpace(world, x, y)).toBe(false);

    removeEntity(world.ecs, objective.bossBattles.get('slime-rat')!.bossEid!);
    floorObjectiveSystem(world);
    expect(objective.bossBattles.get('slime-rat')!.defeated).toBe(true);
    expect(isPointInClearedArena(world, x, y)).toBe(true);

    // Standing in it opens the customization panels...
    world.stores.position.x[player] = x;
    world.stores.position.y[player] = y;
    world.state = 'playing';
    safeRoomSystem(world);
    expect(world.playerInClearedArena).toBe(true);
    expect(isInSafeContext(world)).toBe(true);

    // ...as a full safe space.
    expect(isPointInSafeSpace(world, x, y)).toBe(true);
    expect(world.playerInSafeRoom).toBe(true);
  });

  it('purges enemies already inside without loot or XP and unlocks the achievement once', () => {
    const { world } = startedSlimeRatWorld(123);
    const objective = world.floorScenario!.objective;
    const { x, y } = objective.slimeRatRoomPos;
    const ambientEnemy = spawnEnemy(world, x + 1, y + 1, 10);
    const outsideEnemy = spawnEnemy(world, x + 400, y + 400, 10);
    const pickupsBefore =
      query(world.ecs, [XpGem]).length +
      query(world.ecs, [Gold]).length +
      query(world.ecs, [DroppedItem]).length;

    removeEntity(world.ecs, objective.bossBattles.get('slime-rat')!.bossEid!);
    floorObjectiveSystem(world);

    expect(hasComponent(world.ecs, ambientEnemy, Enemy)).toBe(false);
    expect(hasComponent(world.ecs, outsideEnemy, Enemy)).toBe(true);
    expect(
      query(world.ecs, [XpGem]).length +
        query(world.ecs, [Gold]).length +
        query(world.ecs, [DroppedItem]).length,
    ).toBe(pickupsBefore);
    expect(world.combatEvents.some((event) => event.type === 'corpseExplode')).toBe(true);
    expect(world.achievements.unlockedIds.has('boss-room-sanitized')).toBe(true);
    expect(
      world.achievements.pendingUnlockIds.filter((id) => id === 'boss-room-sanitized'),
    ).toHaveLength(1);

    const secondRoomEnemy = spawnEnemy(world, x + 2, y + 2, 10);
    floorObjectiveSystem(world);
    expect(hasComponent(world.ecs, secondRoomEnemy, Enemy)).toBe(true);
    expect(
      world.achievements.pendingUnlockIds.filter((id) => id === 'boss-room-sanitized'),
    ).toHaveLength(1);
  });
});
