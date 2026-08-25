import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import { Companion, PartySlot, Team, type GameWorld } from '../../src/core/index.js';
import { _PARTY_MAX_SIZE } from '../../src/core/spawners/companions.js';
import {
  floor3ObjectiveTick,
  initializeFloor3Scenario,
  selectFloor3LoadoutOption,
  selectFloor3PoachCompanion,
} from '../../src/game/floor3Scenario.js';
import { TeamId } from '../../src/shared/constants.js';
import { createTestWorld } from '../helpers/world-factory.js';

/** Knocks out every Companion belonging to any of `teamIds`. */
function knockOutTeams(world: GameWorld, teamIds: readonly number[]): void {
  for (const eid of query(world.ecs, [Companion, Team])) {
    if (!teamIds.includes(world.stores.team.id[eid] ?? -1)) continue;
    world.stores.companion.knockedOut[eid] = 1;
  }
}

function partySize(world: GameWorld): number {
  return query(world.ecs, [Companion, PartySlot, Team]).filter(
    (eid) => (world.stores.team.id[eid] ?? -1) === TeamId.PLAYER,
  ).length;
}

function createFloor3World(seed = 42) {
  const world = createTestWorld({ seed, floor: 3 });
  const playerEid = spawnPlayer(world, 0, 0);
  initializeFloor3Scenario(world, playerEid);
  // Resolve the starter pick the way a real run does, so the world lands in
  // 'playing' with a one-Companion party.
  selectFloor3LoadoutOption(world, 0);
  return { world, playerEid };
}

/** Unlocks + wipes the first Studio and ticks until its defeat is latched. */
function defeatFirstStudio(world: GameWorld): void {
  const state = world.floorExtendedState?.floor3Studios;
  const studio = state!.studios[0]!;
  world.playerLevel.level = Math.max(world.playerLevel.level, studio.unlockLevel);
  floor3ObjectiveTick(world);
  knockOutTeams(world, studio.teamIds);
  floor3ObjectiveTick(world);
}

describe('Floor 3 Trainer-poach offer (spec §6.2, UX surface #3)', () => {
  it('pauses on a poach offer the tick after a Studio roster is defeated', () => {
    const { world } = createFloor3World();
    defeatFirstStudio(world);
    const studio = world.floorExtendedState!.floor3Studios!.studios[0]!;
    expect(studio.defeated).toBe(true);
    // The defeat tick itself never pauses — the objective loop must complete.
    expect(world.state).toBe('playing');

    floor3ObjectiveTick(world);
    const offer = world.floorExtendedState?.floor3PoachOffer;
    expect(world.state).toBe('loadout');
    expect(offer).toBeDefined();
    expect(offer!.encounterId).toBe(studio.id);
    expect(offer!.encounterName).toBe(studio.name);
    expect(offer!.candidates.length).toBeGreaterThan(0);
    expect(offer!.slotsRemaining).toBe(_PARTY_MAX_SIZE - 1);
  });

  it('offers only species the defeated Studio actually fields', () => {
    const { world } = createFloor3World();
    defeatFirstStudio(world);
    floor3ObjectiveTick(world);
    const studio = world.floorExtendedState!.floor3Studios!.studios[0]!;
    const rosterIds = new Set(studio.poachRoster.map((candidate) => candidate.speciesId));
    for (const candidate of world.floorExtendedState!.floor3PoachOffer!.candidates) {
      expect(rosterIds.has(candidate.speciesId)).toBe(true);
    }
  });

  it('is seeded — the same seed produces the same offer order (spec R8)', () => {
    const build = () => {
      const { world } = createFloor3World(1234);
      defeatFirstStudio(world);
      floor3ObjectiveTick(world);
      return world.floorExtendedState!.floor3PoachOffer!.candidates;
    };
    expect(build()).toEqual(build());
  });

  it('never re-offers a Studio that has already produced an offer', () => {
    const { world } = createFloor3World();
    defeatFirstStudio(world);
    floor3ObjectiveTick(world);
    selectFloor3PoachCompanion(world, 0);
    expect(world.state).toBe('playing');
    expect(world.floorExtendedState?.floor3PoachOffer).toBeUndefined();

    floor3ObjectiveTick(world);
    expect(world.floorExtendedState?.floor3PoachOffer).toBeUndefined();
    expect(world.state).toBe('playing');
  });

  it('recruits the picked Companion at the Trainer roster level and resumes play', () => {
    const { world } = createFloor3World();
    const before = partySize(world);
    defeatFirstStudio(world);
    floor3ObjectiveTick(world);
    const picked = world.floorExtendedState!.floor3PoachOffer!.candidates[0]!;

    selectFloor3PoachCompanion(world, 0);

    expect(world.state).toBe('playing');
    expect(partySize(world)).toBe(before + 1);
    const levels = Array.from(query(world.ecs, [Companion, PartySlot, Team]))
      .filter((eid) => (world.stores.team.id[eid] ?? -1) === TeamId.PLAYER)
      .map((eid) => world.stores.companion.level[eid]);
    expect(levels).toContain(picked.level);
  });

  it('clamps an out-of-range pick to the first candidate instead of stranding the pause', () => {
    const { world } = createFloor3World();
    const before = partySize(world);
    defeatFirstStudio(world);
    floor3ObjectiveTick(world);

    selectFloor3PoachCompanion(world, 99);

    expect(world.state).toBe('playing');
    expect(partySize(world)).toBe(before + 1);
  });

  it('is a no-op outside the loadout pause', () => {
    const { world } = createFloor3World();
    const before = partySize(world);
    selectFloor3PoachCompanion(world, 0);
    expect(partySize(world)).toBe(before);
    expect(world.state).toBe('playing');
  });

  it('stops offering poaches once the party has locked (§6.3 — loot + XP only)', () => {
    const { world } = createFloor3World();
    const state = world.floorExtendedState!.floor3Studios!;
    // Fill the party by resolving one poach per Studio defeat.
    for (const studio of state.studios) {
      world.playerLevel.level = Math.max(world.playerLevel.level, studio.unlockLevel);
      floor3ObjectiveTick(world);
      if (world.state === 'loadout') selectFloor3LoadoutOption(world, 0);
      knockOutTeams(world, studio.teamIds);
      floor3ObjectiveTick(world);
      if (world.state === 'loadout') selectFloor3LoadoutOption(world, 0);
      floor3ObjectiveTick(world);
      if (world.state === 'loadout') selectFloor3LoadoutOption(world, 0);
    }
    expect(partySize(world)).toBe(_PARTY_MAX_SIZE);
    expect(world.floorExtendedState?.floor3PoachOffer).toBeUndefined();
    expect(world.state).not.toBe('loadout');
  });
});

describe('Floor 3 loadout dispatcher', () => {
  it('routes the floor-entry pause to the starter pick', () => {
    const world = createTestWorld({ seed: 7, floor: 3 });
    const playerEid = spawnPlayer(world, 0, 0);
    initializeFloor3Scenario(world, playerEid);
    expect(world.state).toBe('loadout');
    expect(world.floorExtendedState?.floor3StarterOffer?.length).toBeGreaterThan(0);

    selectFloor3LoadoutOption(world, 0);

    expect(world.state).toBe('playing');
    expect(partySize(world)).toBe(1);
    expect(world.floorExtendedState?.floor3StarterOffer).toEqual([]);
  });

  it('routes a pending poach offer to the poach pick, not back to the starter pick', () => {
    const { world } = createFloor3World();
    defeatFirstStudio(world);
    floor3ObjectiveTick(world);
    expect(world.state).toBe('loadout');

    selectFloor3LoadoutOption(world, 0);

    expect(world.state).toBe('playing');
    expect(partySize(world)).toBe(2);
  });
});
