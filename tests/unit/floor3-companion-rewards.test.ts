/**
 * Floor 3 Companion League — persistent player reward track (spec R7, slice 10).
 *
 * Rival Companions never die (`companionKOSystem` clamps their health and KOs
 * them instead), so `dropSystem` can never pay for them. These tests pin the
 * replacement payout path end to end: KO → drops → `itemPickupSystem` →
 * `world.playerLevel` / `world.playerGold` / `Inventory`, plus the anti-farm
 * latch, the player-party exclusion, and the still-intact wild-pet path.
 */
import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Companion, DroppedItem, Gold, Team, XpGem, type GameWorld } from '../../src/core/index.js';
import { spawnEnemy, spawnPlayer, spawnRosterCompanion } from '../../src/core/helpers.js';
import { collisionSystem } from '../../src/core/systems/collisionSystem.js';
import { companionKOSystem } from '../../src/core/systems/companionKOSystem.js';
import { dropSystem } from '../../src/core/systems/dropSystem.js';
import { itemPickupSystem } from '../../src/core/systems/itemPickupSystem.js';
import { awardFloor3CompanionDefeatRewards } from '../../src/game/floor3CompanionRewards.js';
import {
  floor3ObjectiveTick,
  initializeFloor3Scenario,
  selectFloor3LoadoutOption,
} from '../../src/game/floor3Scenario.js';
import { TeamId } from '../../src/shared/constants.js';
import { listStaticInventorySlots } from '../../src/shared/inventory.js';
import { createTestWorld } from '../helpers/world-factory.js';

/** Team id for a Studio/Trainer roster — matches Floor 3's rival team range. */
const RIVAL_TEAM_ID = 10;
const PLAYER_X = 100;
const PLAYER_Y = 100;

function createFloor3RewardWorld(seed = 4242): { world: GameWorld; playerEid: number } {
  const world = createTestWorld({ seed, floor: 3 });
  world.floorId = 'floor3';
  world.state = 'playing';
  const playerEid = spawnPlayer(world, PLAYER_X, PLAYER_Y);
  return { world, playerEid };
}

/**
 * Spawns a roster Companion on `teamId` right on top of the player so every
 * drop it pays out is collectible by a single `itemPickupSystem` pass.
 */
function spawnRival(world: GameWorld, teamId: number, x = PLAYER_X, y = PLAYER_Y): number {
  return spawnRosterCompanion(world, {
    x,
    y,
    hp: 10,
    aiType: 0,
    speed: 0.1,
    aggroRange: 10,
    attackRange: 0,
    speciesToken: 1,
    level: 3,
    ownerTeam: teamId,
    form: 1,
  });
}

/** Drives the real KO path: zero health, then let `companionKOSystem` latch it. */
function knockOut(world: GameWorld, eid: number): void {
  world.stores.health.current[eid] = 0;
  companionKOSystem(world);
}

function collectEverything(world: GameWorld): void {
  itemPickupSystem(world, collisionSystem(world));
}

function countPickups(world: GameWorld): number {
  return (
    query(world.ecs, [XpGem]).length +
    query(world.ecs, [Gold]).length +
    query(world.ecs, [DroppedItem]).length
  );
}

describe('floor3 persistent player reward track', () => {
  it('pays XP, gold, and loot into the player track when a rival Companion is defeated', () => {
    const { world, playerEid } = createFloor3RewardWorld();
    const rival = spawnRival(world, RIVAL_TEAM_ID);

    knockOut(world, rival);
    expect(world.stores.companion.knockedOut[rival]).toBe(1);

    awardFloor3CompanionDefeatRewards(world);
    expect(countPickups(world)).toBeGreaterThan(0);

    collectEverything(world);

    // Everything routed through the shared pickup path, not a bespoke channel.
    expect(world.playerLevel.xp).toBeGreaterThan(0);
    expect(world.lootLedger.xpCollected).toBe(world.playerLevel.xp);
    expect(world.stores.broadcastScore.current[playerEid]).toBe(world.playerLevel.xp);
  });

  it('pays gold and inventory loot across a defeated roster', () => {
    const { world, playerEid } = createFloor3RewardWorld();
    const rivals = Array.from({ length: 8 }, () => spawnRival(world, RIVAL_TEAM_ID));

    for (const rival of rivals) knockOut(world, rival);
    awardFloor3CompanionDefeatRewards(world);
    collectEverything(world);

    expect(world.playerGold).toBeGreaterThan(0);
    expect(world.goldLedger.earnedFromDrops).toBe(world.playerGold);
    const bag = world.inventories.get(playerEid);
    expect(bag).toBeDefined();
    expect(listStaticInventorySlots(bag!).length).toBeGreaterThan(0);
  });

  it('scatters each item in a multi-item rival drop', () => {
    const { world } = createFloor3RewardWorld(18);
    const rival = spawnRival(world, RIVAL_TEAM_ID);

    knockOut(world, rival);
    awardFloor3CompanionDefeatRewards(world);

    const items = query(world.ecs, [DroppedItem]);
    expect(items.length).toBeGreaterThan(1);
    const positions = Array.from(items, (eid) => [
      world.stores.position.x[eid] ?? 0,
      world.stores.position.y[eid] ?? 0,
    ]);
    expect(new Set(positions.map(([x, y]) => `${x}:${y}`)).size).toBe(positions.length);
  });

  it('pays a defeated rival exactly once, even across revive and re-KO', () => {
    const { world } = createFloor3RewardWorld();
    const rival = spawnRival(world, RIVAL_TEAM_ID);

    knockOut(world, rival);
    awardFloor3CompanionDefeatRewards(world);
    collectEverything(world);
    const xpAfterFirstDefeat = world.playerLevel.xp;
    const goldAfterFirstDefeat = world.playerGold;
    expect(xpAfterFirstDefeat).toBeGreaterThan(0);
    expect(world.stores.companion.defeatRewarded[rival]).toBe(1);

    // Same frame re-entry, then the engagement-end revival + a second KO.
    awardFloor3CompanionDefeatRewards(world);
    world.stores.companion.knockedOut[rival] = 0;
    world.stores.health.current[rival] = world.stores.health.max[rival] ?? 10;
    knockOut(world, rival);
    awardFloor3CompanionDefeatRewards(world);
    collectEverything(world);

    expect(countPickups(world)).toBe(0);
    expect(world.playerLevel.xp).toBe(xpAfterFirstDefeat);
    expect(world.playerGold).toBe(goldAfterFirstDefeat);
  });

  it('never pays the player for their own party Companions going down', () => {
    const { world } = createFloor3RewardWorld();
    const partyMember = spawnRival(world, TeamId.PLAYER);

    knockOut(world, partyMember);
    awardFloor3CompanionDefeatRewards(world);
    collectEverything(world);

    expect(countPickups(world)).toBe(0);
    expect(world.playerLevel.xp).toBe(0);
    expect(world.playerGold).toBe(0);
    expect(world.stores.companion.defeatRewarded[partyMember]).toBe(0);
  });

  it('ignores rivals that are still standing', () => {
    const { world } = createFloor3RewardWorld();
    const rival = spawnRival(world, RIVAL_TEAM_ID);

    companionKOSystem(world);
    awardFloor3CompanionDefeatRewards(world);

    expect(world.stores.companion.knockedOut[rival]).toBe(0);
    expect(countPickups(world)).toBe(0);
  });

  it('keeps the wild-pet half of the reward track intact on Floor 3', () => {
    const { world } = createFloor3RewardWorld();
    const wild = spawnEnemy(world, PLAYER_X, PLAYER_Y, 10);
    world.stores.health.current[wild] = 0;

    dropSystem(world, { deathLingerMs: 0 });
    collectEverything(world);

    // BASIC_MELEE (1 xp) + the floor3 manifest's floor_3 table (3 xp).
    expect(world.playerLevel.xp).toBe(4);
  });

  it('is deterministic: the same seed pays the same rewards', () => {
    const runOnce = (seed: number): { xp: number; gold: number } => {
      const { world } = createFloor3RewardWorld(seed);
      for (const rival of Array.from({ length: 4 }, () => spawnRival(world, RIVAL_TEAM_ID))) {
        knockOut(world, rival);
      }
      awardFloor3CompanionDefeatRewards(world);
      collectEverything(world);
      return { xp: world.playerLevel.xp, gold: world.playerGold };
    };

    expect(runOnce(1234)).toEqual(runOnce(1234));
  });

  it('only rewards Companion entities, leaving non-Companion teams alone', () => {
    const { world } = createFloor3RewardWorld();
    spawnEnemy(world, PLAYER_X, PLAYER_Y, 10);

    awardFloor3CompanionDefeatRewards(world);

    expect(query(world.ecs, [Companion, Team]).length).toBe(0);
    expect(countPickups(world)).toBe(0);
  });
});

describe('floor3 reward track wiring', () => {
  it('pays a wiped Studio roster from floor3ObjectiveTick before that roster is despawned', () => {
    const world = createTestWorld({ seed: 808, floor: 3 });
    const playerEid = spawnPlayer(world, 0, 0);
    initializeFloor3Scenario(world, playerEid);
    selectFloor3LoadoutOption(world, 0);

    const state = world.floorExtendedState?.floor3Studios;
    expect(state).toBeDefined();
    const firstStudio = state!.studios[0];
    expect(firstStudio).toBeDefined();
    expect(firstStudio!.unlockLevel).toBe(0);

    floor3ObjectiveTick(world); // unlocks + spawns the floor-start Studio
    const roster = query(world.ecs, [Companion, Team]).filter((eid) =>
      firstStudio!.teamIds.includes(world.stores.team.id[eid] ?? -1),
    );
    expect(roster.length).toBeGreaterThan(0);
    for (const eid of roster) world.stores.companion.knockedOut[eid] = 1;

    const pickupsBeforeWipe = countPickups(world);
    floor3ObjectiveTick(world);

    // The wipe frame both pays the roster out and despawns it — the payout
    // must not be lost to the despawn.
    expect(firstStudio!.defeated).toBe(true);
    expect(
      query(world.ecs, [Companion, Team]).filter((eid) =>
        firstStudio!.teamIds.includes(world.stores.team.id[eid] ?? -1),
      ).length,
    ).toBe(0);
    expect(countPickups(world)).toBeGreaterThan(pickupsBeforeWipe);
    expect(world.lootLedger.xpSpawned).toBeGreaterThan(0);
  });
});
