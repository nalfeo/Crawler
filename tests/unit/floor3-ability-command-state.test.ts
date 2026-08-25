import { describe, expect, it } from 'vitest';
import {
  COMMAND_COOLDOWN_FRAMES,
  COMMAND_FLASH_FRAMES,
  COMMAND_LEVELS_PER_CHARGE,
  chargesInUse,
  commandCapacity,
  commandCooldownFraction,
  createFloor3CommandState,
  issueCompanionCommand,
  pruneCommandState,
  resolveCommandSlots,
  selectCommandTarget,
} from '../../src/engine/floor3-ability-command-state.js';
import { resolveFloor3PartyRows } from '../../src/engine/floor3-party-state.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { spawnTestCompanion } from '../helpers/floor3-party.js';

function partyWorld(count = 2) {
  const world = createTestWorld();
  world.floor = 3;
  world.floorId = 'floor3';
  const species = ['ember-charger', 'bloom-warden', 'stone-slinger'];
  for (let slot = 0; slot < count; slot++) {
    spawnTestCompanion(world, { speciesId: species[slot]!, slot, level: 25 });
  }
  return world;
}

describe('commandCapacity', () => {
  it('starts at one charge and earns one per capacity band, capped at party size', () => {
    expect(commandCapacity(1)).toBe(1);
    expect(commandCapacity(COMMAND_LEVELS_PER_CHARGE)).toBe(1);
    expect(commandCapacity(COMMAND_LEVELS_PER_CHARGE + 1)).toBe(2);
    expect(commandCapacity(1000)).toBe(6);
  });

  it('never returns less than one charge for a degenerate level', () => {
    expect(commandCapacity(0)).toBe(1);
    expect(commandCapacity(Number.NaN)).toBe(1);
  });
});

describe('issueCompanionCommand', () => {
  it('accepts the lowest-slot ready Companion and starts its cooldown', () => {
    const world = partyWorld();
    const rows = resolveFloor3PartyRows(world);
    const state = createFloor3CommandState();

    const result = issueCompanionCommand(state, rows, 100, 1);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.row.slot).toBe(0);
    expect(result.abilityName).toBe(rows[0]!.signatureAbilityName);
    expect(chargesInUse(state, rows, 100)).toBe(1);
  });

  it('refuses a second command while the only charge is spent, then allows it after the cooldown', () => {
    const world = partyWorld();
    const rows = resolveFloor3PartyRows(world);
    const state = createFloor3CommandState();

    issueCompanionCommand(state, rows, 100, 1);
    expect(issueCompanionCommand(state, rows, 101, 1)).toEqual({
      accepted: false,
      rejection: 'no-capacity',
    });

    const ready = 100 + COMMAND_COOLDOWN_FRAMES;
    expect(issueCompanionCommand(state, rows, ready - 1, 1).accepted).toBe(false);
    expect(issueCompanionCommand(state, rows, ready, 1).accepted).toBe(true);
  });

  it('lets a higher-level player command two Companions at once', () => {
    const world = partyWorld();
    const rows = resolveFloor3PartyRows(world);
    const state = createFloor3CommandState();
    const playerLevel = COMMAND_LEVELS_PER_CHARGE + 1;

    expect(issueCompanionCommand(state, rows, 10, playerLevel).accepted).toBe(true);
    const second = issueCompanionCommand(state, rows, 11, playerLevel);
    expect(second.accepted).toBe(true);
    if (!second.accepted) return;
    expect(second.row.slot).toBe(1);
    expect(issueCompanionCommand(state, rows, 12, playerLevel).accepted).toBe(false);
  });

  it('refuses the same Companion while it is still cooling down', () => {
    const world = partyWorld();
    const rows = resolveFloor3PartyRows(world);
    const state = createFloor3CommandState();

    issueCompanionCommand(state, rows, 0, 100);
    expect(issueCompanionCommand(state, rows, 5, 100, 0)).toEqual({
      accepted: false,
      rejection: 'cooling-down',
    });
  });

  it('refuses a knocked-out Companion and an unknown slot', () => {
    const world = partyWorld();
    const eid = resolveFloor3PartyRows(world)[0]!.eid;
    world.stores.companion.knockedOut[eid] = 1;
    const rows = resolveFloor3PartyRows(world);
    const state = createFloor3CommandState();

    expect(issueCompanionCommand(state, rows, 0, 100, 0)).toEqual({
      accepted: false,
      rejection: 'knocked-out',
    });
    expect(issueCompanionCommand(state, rows, 0, 100, 9)).toEqual({
      accepted: false,
      rejection: 'unknown-slot',
    });
    // The default target skips the KO'd member instead of failing.
    const fallback = issueCompanionCommand(state, rows, 0, 100);
    expect(fallback.accepted).toBe(true);
    if (fallback.accepted) expect(fallback.row.slot).toBe(1);
  });

  it('refuses when the party is empty', () => {
    const state = createFloor3CommandState();
    expect(issueCompanionCommand(state, [], 0, 100)).toEqual({
      accepted: false,
      rejection: 'empty-party',
    });
  });
});

describe('resolveCommandSlots', () => {
  it('reports cooldown progress, the flash window, and the blocking reason', () => {
    const world = partyWorld(1);
    const rows = resolveFloor3PartyRows(world);
    const state = createFloor3CommandState();
    issueCompanionCommand(state, rows, 50, 1);

    const justCommanded = resolveCommandSlots(state, rows, 50, 1)[0]!;
    expect(justCommanded.ready).toBe(false);
    expect(justCommanded.blockedBy).toBe('cooling-down');
    expect(justCommanded.cooldownFraction).toBe(0);
    expect(justCommanded.flashing).toBe(true);

    expect(resolveCommandSlots(state, rows, 50 + COMMAND_FLASH_FRAMES, 1)[0]!.flashing).toBe(false);

    const halfway = resolveCommandSlots(state, rows, 50 + COMMAND_COOLDOWN_FRAMES / 2, 1)[0]!;
    expect(halfway.cooldownFraction).toBeCloseTo(0.5);

    const recharged = resolveCommandSlots(state, rows, 50 + COMMAND_COOLDOWN_FRAMES, 1)[0]!;
    expect(recharged.ready).toBe(true);
    expect(recharged.cooldownFraction).toBe(1);
  });

  it('treats a rewound frame counter as ready instead of stranding the cooldown', () => {
    const world = partyWorld(1);
    const rows = resolveFloor3PartyRows(world);
    const state = createFloor3CommandState();
    issueCompanionCommand(state, rows, 5_000, 1);

    expect(commandCooldownFraction(state, rows[0]!.key, 0)).toBe(1);
    expect(selectCommandTarget(state, rows, 0, 1)!.slot).toBe(0);
  });
});

describe('pruneCommandState', () => {
  it('drops cooldown entries for Companions that left the party', () => {
    const world = partyWorld();
    const rows = resolveFloor3PartyRows(world);
    const state = createFloor3CommandState();
    issueCompanionCommand(state, rows, 0, 100);
    issueCompanionCommand(state, rows, 0, 100, 1);
    expect(state.lastCommandFrame.size).toBe(2);

    pruneCommandState(state, [rows[0]!]);
    expect(Array.from(state.lastCommandFrame.keys())).toEqual([rows[0]!.key]);
  });
});
