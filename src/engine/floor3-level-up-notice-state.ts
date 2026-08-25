/**
 * Pure snapshot/diff for the Floor 3 level-up · evolve · learn notice
 * (game-design §15 surface 6).
 *
 * `companionProgressionSystem` (slice 5) writes level/form straight into the
 * `Companion` store with no event channel, so the notice surface is derived by
 * comparing two snapshots of the party rather than by adding an event queue to
 * `world` — the simulation stays byte-identical and the diff rules stay
 * unit-testable.
 *
 * Snapshots key off the stable {@link PartyMemberKey} (slot + species token),
 * never the entity id, so a recycled eid can never be mistaken for a level-up.
 * A key that is new in the next snapshot is a freshly recruited Companion: it
 * is baselined silently instead of reporting five "learned" notices at once.
 */
import type { GameWorld } from '../core/world.js';
import { TeamId } from '../shared/constants.js';
import { ABILITY_MILESTONE_LEVELS, getPetSpecies } from '../shared/data/floor3/species.js';
import {
  abilityDisplayName,
  resolveFloor3PartyRows,
  type Floor3PartyRow,
  type PartyMemberKey,
} from './floor3-party-state.js';

/** What a notice is about. Order here is the order notices are emitted in. */
export type Floor3NoticeKind = 'level' | 'evolve' | 'learn';

/** One notice line to show the player. */
export interface Floor3ProgressNotice {
  readonly key: PartyMemberKey;
  readonly slot: number;
  readonly kind: Floor3NoticeKind;
  readonly speciesId: string;
  /** Companion display name AFTER the change (post-evolution form name). */
  readonly name: string;
  readonly level: number;
  /** Present on `evolve` notices: the new form index. */
  readonly form?: 0 | 1 | 2;
  /** Present on `learn` notices: the milestone ability that was unlocked. */
  readonly abilityId?: string;
  readonly text: string;
}

/** Per-Companion progression facts a notice can be derived from. */
export interface Floor3ProgressEntry {
  readonly slot: number;
  readonly speciesId: string;
  readonly name: string;
  readonly level: number;
  readonly form: 0 | 1 | 2;
}

/** Progression snapshot of the whole party, keyed by stable party identity. */
export type Floor3ProgressSnapshot = ReadonlyMap<PartyMemberKey, Floor3ProgressEntry>;

/** Capture the party's current progression state (cheap: one row scan). */
export function captureFloor3PartyProgress(
  world: GameWorld,
  ownerTeam: number = TeamId.PLAYER,
): Floor3ProgressSnapshot {
  return snapshotFromRows(resolveFloor3PartyRows(world, ownerTeam));
}

/** Build a snapshot from already-resolved rows (avoids a second query). */
export function snapshotFromRows(rows: readonly Floor3PartyRow[]): Floor3ProgressSnapshot {
  const snapshot = new Map<PartyMemberKey, Floor3ProgressEntry>();
  for (const row of rows) {
    snapshot.set(row.key, {
      slot: row.slot,
      speciesId: row.speciesId,
      name: row.formName,
      level: row.level,
      form: row.form,
    });
  }
  return snapshot;
}

/** Milestone levels crossed by going from `previousLevel` to `nextLevel`. */
export type AbilityMilestoneLevel = (typeof ABILITY_MILESTONE_LEVELS)[number];

export function milestonesCrossed(
  previousLevel: number,
  nextLevel: number,
): readonly AbilityMilestoneLevel[] {
  return ABILITY_MILESTONE_LEVELS.filter(
    (milestone) => previousLevel < milestone && nextLevel >= milestone,
  );
}

/**
 * Notices for everything that changed between two snapshots.
 *
 * Emitted in a fixed order — party slot, then `level` → `evolve` → `learn`,
 * with `learn` notices in ascending milestone order — so a multi-level jump
 * that crosses several milestones always reports every unlocked ability in the
 * same sequence.
 */
export function diffFloor3PartyProgress(
  previous: Floor3ProgressSnapshot,
  next: Floor3ProgressSnapshot,
): readonly Floor3ProgressNotice[] {
  const notices: Floor3ProgressNotice[] = [];
  const keys = Array.from(next.keys()).sort(
    (a, b) => (next.get(a)?.slot ?? 0) - (next.get(b)?.slot ?? 0),
  );

  for (const key of keys) {
    const after = next.get(key);
    const before = previous.get(key);
    // A key absent from `previous` is a newly recruited Companion: baseline it
    // silently, never announce its starting level/form/abilities.
    if (after === undefined || before === undefined) continue;
    if (after.level <= before.level && after.form === before.form) continue;

    if (after.level > before.level) {
      notices.push({
        key,
        slot: after.slot,
        kind: 'level',
        speciesId: after.speciesId,
        name: after.name,
        level: after.level,
        text: `${after.name} reached Lv ${after.level}`,
      });
    }
    if (after.form > before.form) {
      notices.push({
        key,
        slot: after.slot,
        kind: 'evolve',
        speciesId: after.speciesId,
        name: after.name,
        level: after.level,
        form: after.form,
        text: `${after.name} evolved!`,
      });
    }
    for (const milestone of milestonesCrossed(before.level, after.level)) {
      const def = getPetSpecies(after.speciesId);
      if (def === undefined) continue;
      notices.push({
        key,
        slot: after.slot,
        kind: 'learn',
        speciesId: after.speciesId,
        name: after.name,
        level: after.level,
        abilityId: def.abilityIdsByLevel[String(milestone) as `${typeof milestone}`],
        text: `${after.name} learned ${abilityDisplayName(def, milestone)}`,
      });
    }
  }
  return notices;
}
