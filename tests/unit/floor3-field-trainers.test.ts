import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import { Companion, Gold, PartySlot, Team, type GameWorld } from '../../src/core/index.js';
import { itemPickupSystem } from '../../src/core/systems/itemPickupSystem.js';
import { collisionSystem } from '../../src/core/systems/collisionSystem.js';
import {
  floor3ObjectiveTick,
  initializeFloor3Scenario,
  selectFloor3LoadoutOption,
} from '../../src/game/floor3Scenario.js';
import { TeamId } from '../../src/shared/constants.js';
import { createTestWorld } from '../helpers/world-factory.js';

function createFloor3World(seed = 1776): { world: GameWorld; playerEid: number } {
  const world = createTestWorld({ seed, floor: 3 });
  const playerEid = spawnPlayer(world, 0, 0);
  initializeFloor3Scenario(world, playerEid);
  selectFloor3LoadoutOption(world, 0);
  return { world, playerEid };
}

function partySize(world: GameWorld): number {
  return query(world.ecs, [Companion, PartySlot, Team]).filter(
    (eid) => (world.stores.team.id[eid] ?? -1) === TeamId.PLAYER,
  ).length;
}

describe('Floor 3 field Trainer circuit', () => {
  it('is visible and ordered, cannot start while idle, then activates through normal movement', () => {
    const { world, playerEid } = createFloor3World();
    const circuit = world.floorExtendedState!.floor3Studios!.fieldTrainers!;
    expect(circuit).toHaveLength(3);
    expect(circuit.map((trainer) => trainer.name)).toEqual(['Mara', 'Oren', 'Sable']);
    expect(circuit.every((trainer) => world.npcs.has(trainer.npcEid))).toBe(true);

    // Remaining at spawn does not materialize an opposing team.
    floor3ObjectiveTick(world);
    expect(circuit[0]!.started).toBe(false);
    expect(
      query(world.ecs, [Companion, Team]).filter(
        (eid) => (world.stores.team.id[eid] ?? -1) === circuit[0]!.teamId,
      ),
    ).toHaveLength(0);

    // Movement alone starts the encounter; there is no attack/ability command.
    world.stores.position.x[playerEid] = circuit[0]!.x;
    world.stores.position.y[playerEid] = circuit[0]!.y;
    floor3ObjectiveTick(world);
    expect(circuit[0]!.started).toBe(true);
    expect(
      query(world.ecs, [Companion, Team]).filter(
        (eid) => (world.stores.team.id[eid] ?? -1) === circuit[0]!.teamId,
      ),
    ).toHaveLength(circuit[0]!.poachRoster.length);
    expect(circuit[1]!.started).toBe(false);
  });

  it('persists the win, pays gold and normal crystal rewards, then grows the party through a poach', () => {
    const { world, playerEid } = createFloor3World(1777);
    const state = world.floorExtendedState!.floor3Studios!;
    const trainer = state.fieldTrainers![0]!;
    const partyBefore = partySize(world);
    world.stores.position.x[playerEid] = trainer.x;
    world.stores.position.y[playerEid] = trainer.y;
    floor3ObjectiveTick(world);

    const roster = query(world.ecs, [Companion, Team]).filter(
      (eid) => (world.stores.team.id[eid] ?? -1) === trainer.teamId,
    );
    for (const eid of roster) world.stores.companion.knockedOut[eid] = 1;
    floor3ObjectiveTick(world);

    expect(trainer.defeated).toBe(true);
    expect(state.fieldTrainersDefeatedCount).toBe(1);
    expect(query(world.ecs, [Gold]).length).toBeGreaterThan(0);
    expect(world.npcs.get(trainer.npcEid)?.dialogueOverride?.[0]).toContain('earned that win');
    expect(
      query(world.ecs, [Companion, Team]).filter(
        (eid) => (world.stores.team.id[eid] ?? -1) === trainer.teamId,
      ),
    ).toHaveLength(0);

    // The next tick opens the standard poach picker. Its crystals and the
    // guaranteed gold use ordinary pickups, not an alternate reward channel.
    floor3ObjectiveTick(world);
    expect(world.state).toBe('loadout');
    expect(world.floorExtendedState!.floor3PoachOffer!.encounterId).toBe(trainer.id);
    itemPickupSystem(world, collisionSystem(world));
    expect(world.playerLevel.xp).toBeGreaterThan(0);
    expect(world.playerGold).toBeGreaterThanOrEqual(trainer.goldReward);

    selectFloor3LoadoutOption(world, 0);
    expect(world.state).toBe('playing');
    expect(partySize(world)).toBe(partyBefore + 1);
  });
});
