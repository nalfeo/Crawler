/**
 * Pure state machine for the Floor 3 ability command — the commander verb
 * (game-design §15 surface 7): "trigger a Companion's signature ability".
 *
 * Ownership note: this state is **UI-owned**, not simulation-owned. The Floor 3
 * ability *effects* (`f3.*` ids in `species.json`) are not authored yet, so a
 * command changes no simulation state; it drives the HUD affordance (which
 * Companion is selected, whether the verb is available, and the cooldown /
 * capacity readout). Keeping it out of `world` means mounting the HUD cannot
 * perturb a headless run's fingerprint. When the ability-effect slice lands it
 * consumes `issueCompanionCommand`'s accepted result rather than replacing it.
 *
 * Determinism: every time base is `world.frameCount` (spec rule #4 — never
 * `Date.now()`), and every map is keyed by the stable `PartyMemberKey` so a
 * recycled entity id can never inherit another Companion's cooldown.
 */
import tuning from '../shared/data/tuning.json';
import type { Floor3PartyRow, PartyMemberKey } from './floor3-party-state.js';

/** Frames a commanded Companion's signature ability stays on cooldown. */
export const COMMAND_COOLDOWN_FRAMES: number = tuning.floor3Companion.commandCooldownFrames;

/** Player levels required per extra simultaneous command charge (spec R7). */
export const COMMAND_LEVELS_PER_CHARGE: number =
  tuning.floor3Companion.commandLevelsPerCapacityCharge;

/** Hard cap on simultaneous command charges — one per party slot. */
export const COMMAND_MAX_CAPACITY: number = tuning.floor3Companion.partyMaxSize;

/** Frames the HUD flashes a row after its command is accepted. */
export const COMMAND_FLASH_FRAMES = 20;

/** Why a command was refused. */
export type CommandRejection =
  | 'empty-party'
  | 'unknown-slot'
  | 'knocked-out'
  | 'cooling-down'
  | 'no-capacity';

/** Mutable, UI-owned command bookkeeping. Create one per mounted surface. */
export interface Floor3CommandState {
  /** Frame each party member was last successfully commanded on. */
  readonly lastCommandFrame: Map<PartyMemberKey, number>;
}

/** Fresh, empty command state. */
export function createFloor3CommandState(): Floor3CommandState {
  return { lastCommandFrame: new Map() };
}

/**
 * Simultaneous command charges the player has earned. Player level is the
 * persistent track that "powers Floor-3 command capacity" (spec R7): one
 * charge at level 1, plus one per {@link COMMAND_LEVELS_PER_CHARGE} levels,
 * capped at the party size.
 */
export function commandCapacity(playerLevel: number): number {
  const level = Number.isFinite(playerLevel) ? Math.max(1, Math.floor(playerLevel)) : 1;
  const earned = 1 + Math.floor((level - 1) / COMMAND_LEVELS_PER_CHARGE);
  return Math.min(COMMAND_MAX_CAPACITY, earned);
}

/** Frames left on a member's cooldown; 0 when ready. */
export function commandCooldownRemaining(
  state: Floor3CommandState,
  key: PartyMemberKey,
  frameCount: number,
): number {
  const last = state.lastCommandFrame.get(key);
  if (last === undefined) return 0;
  // A rewound/reset frame counter (new floor, restarted lab) must not strand a
  // Companion on a cooldown that can never expire.
  if (frameCount < last) return 0;
  return Math.max(0, COMMAND_COOLDOWN_FRAMES - (frameCount - last));
}

/** Cooldown progress in `[0, 1]`, where 1 means "ready now". */
export function commandCooldownFraction(
  state: Floor3CommandState,
  key: PartyMemberKey,
  frameCount: number,
): number {
  if (COMMAND_COOLDOWN_FRAMES <= 0) return 1;
  return 1 - commandCooldownRemaining(state, key, frameCount) / COMMAND_COOLDOWN_FRAMES;
}

/** Party members currently spending a charge (i.e. still cooling down). */
export function chargesInUse(
  state: Floor3CommandState,
  rows: readonly Floor3PartyRow[],
  frameCount: number,
): number {
  let used = 0;
  for (const row of rows) {
    if (commandCooldownRemaining(state, row.key, frameCount) > 0) used += 1;
  }
  return used;
}

/** Per-row command affordance the HUD renders. */
export interface CommandSlotState {
  readonly key: PartyMemberKey;
  readonly slot: number;
  readonly abilityName: string;
  readonly ready: boolean;
  /** 0 → just commanded, 1 → fully recharged. */
  readonly cooldownFraction: number;
  readonly cooldownFrames: number;
  /** Set when `ready` is false. */
  readonly blockedBy?: CommandRejection;
  /** True for `COMMAND_FLASH_FRAMES` after this row's command was accepted. */
  readonly flashing: boolean;
}

/** Resolve the command affordance for every party row, in slot order. */
export function resolveCommandSlots(
  state: Floor3CommandState,
  rows: readonly Floor3PartyRow[],
  frameCount: number,
  playerLevel: number,
): readonly CommandSlotState[] {
  const capacity = commandCapacity(playerLevel);
  const used = chargesInUse(state, rows, frameCount);
  return rows.map((row) => {
    const remaining = commandCooldownRemaining(state, row.key, frameCount);
    let blockedBy: CommandRejection | undefined;
    if (row.knockedOut) blockedBy = 'knocked-out';
    else if (remaining > 0) blockedBy = 'cooling-down';
    else if (used >= capacity) blockedBy = 'no-capacity';
    const last = state.lastCommandFrame.get(row.key);
    return {
      key: row.key,
      slot: row.slot,
      abilityName: row.signatureAbilityName,
      ready: blockedBy === undefined,
      cooldownFraction: commandCooldownFraction(state, row.key, frameCount),
      cooldownFrames: remaining,
      ...(blockedBy === undefined ? {} : { blockedBy }),
      flashing:
        last !== undefined && frameCount >= last && frameCount - last < COMMAND_FLASH_FRAMES,
    };
  });
}

/**
 * The Companion the bare command verb fires: the lowest-slot party member that
 * is ready right now. `undefined` when nobody can be commanded.
 */
export function selectCommandTarget(
  state: Floor3CommandState,
  rows: readonly Floor3PartyRow[],
  frameCount: number,
  playerLevel: number,
): Floor3PartyRow | undefined {
  const slots = resolveCommandSlots(state, rows, frameCount, playerLevel);
  const readyKey = slots.find((slot) => slot.ready)?.key;
  return readyKey === undefined ? undefined : rows.find((row) => row.key === readyKey);
}

/** Outcome of a command press. */
export type CommandResult =
  | { readonly accepted: true; readonly row: Floor3PartyRow; readonly abilityName: string }
  | { readonly accepted: false; readonly rejection: CommandRejection };

/**
 * Issue the commander verb. `slot` targets one specific party slot; omit it to
 * command the default target ({@link selectCommandTarget}). Mutates only the
 * UI-owned cooldown map, and only on acceptance.
 */
export function issueCompanionCommand(
  state: Floor3CommandState,
  rows: readonly Floor3PartyRow[],
  frameCount: number,
  playerLevel: number,
  slot?: number,
): CommandResult {
  if (rows.length === 0) return { accepted: false, rejection: 'empty-party' };

  const target =
    slot === undefined
      ? selectCommandTarget(state, rows, frameCount, playerLevel)
      : rows.find((row) => row.slot === slot);
  if (target === undefined) {
    if (slot !== undefined) return { accepted: false, rejection: 'unknown-slot' };
    // No default target: report the most specific reason the party is blocked.
    const slots = resolveCommandSlots(state, rows, frameCount, playerLevel);
    const blocked =
      slots.find((entry) => entry.blockedBy === 'no-capacity')?.blockedBy ??
      slots.find((entry) => entry.blockedBy === 'cooling-down')?.blockedBy ??
      slots[0]?.blockedBy ??
      'knocked-out';
    return { accepted: false, rejection: blocked };
  }

  const slotState = resolveCommandSlots(state, rows, frameCount, playerLevel).find(
    (entry) => entry.key === target.key,
  );
  if (slotState === undefined) return { accepted: false, rejection: 'unknown-slot' };
  if (!slotState.ready) {
    return { accepted: false, rejection: slotState.blockedBy ?? 'cooling-down' };
  }

  state.lastCommandFrame.set(target.key, frameCount);
  return { accepted: true, row: target, abilityName: target.signatureAbilityName };
}

/**
 * Drop cooldown entries for Companions that are no longer in the party, so the
 * map cannot grow across a long run (party members leave only on floor exit
 * today, but a KO'd-and-removed member would otherwise leak an entry).
 */
export function pruneCommandState(
  state: Floor3CommandState,
  rows: readonly Floor3PartyRow[],
): void {
  const live = new Set(rows.map((row) => row.key));
  for (const key of Array.from(state.lastCommandFrame.keys())) {
    if (!live.has(key)) state.lastCommandFrame.delete(key);
  }
}
