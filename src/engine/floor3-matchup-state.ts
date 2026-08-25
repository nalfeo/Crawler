/**
 * Pure resolver for the Floor 3 affinity matchup indicator (game-design §15
 * surface 8) — the strong / weak / neutral read on the engagement the player's
 * party is currently in, which is what makes the Temperament game legible.
 *
 * Reads `AFFINITY_MATRIX` (spec R3) directly; no rendering imports, no world
 * mutation, and no RNG, so a given world state always produces the same
 * indicator.
 */
import { query } from 'bitecs';
import { Companion, Position, Team } from '../core/components.js';
import type { GameWorld } from '../core/world.js';
import {
  affinityMultiplier,
  type AffinityMultiplier,
  type Affinity,
} from '../shared/data/floor3/affinity.js';
import { speciesForToken } from '../shared/data/floor3/species.js';
import tuning from '../shared/data/tuning.json';
import { TeamId } from '../shared/constants.js';
import type { Floor3PartyRow, PartyMemberKey } from './floor3-party-state.js';

/**
 * Radius (ft) within which a rival Companion counts as "the current
 * engagement". Deliberately the same knob `companionKOSystem` uses for
 * engagement tracking, so the indicator can never disagree with the KO/recovery
 * state machine about who is fighting whom.
 */
export const MATCHUP_RANGE_FT: number = tuning.floor3Companion.engagementRangeFt;

/** Player-facing read of an affinity matchup. */
export type MatchupTag = 'strong' | 'weak' | 'neutral';

/** Bar/chevron color per matchup tag. */
export const MATCHUP_COLORS: Readonly<Record<MatchupTag, number>> = Object.freeze({
  strong: 0x22c55e,
  weak: 0xef4444,
  neutral: 0x94a3b8,
});

/** Short label per matchup tag. */
export const MATCHUP_LABELS: Readonly<Record<MatchupTag, string>> = Object.freeze({
  strong: 'STRONG',
  weak: 'WEAK',
  neutral: 'EVEN',
});

/** Map an effectiveness multiplier to its player-facing tag. */
export function matchupTagForMultiplier(multiplier: AffinityMultiplier): MatchupTag {
  if (multiplier > 1) return 'strong';
  if (multiplier < 1) return 'weak';
  return 'neutral';
}

/** The resolved matchup for one Companion against its nearest rival. */
export interface Floor3Matchup {
  readonly sourceEid: number;
  readonly targetEid: number;
  readonly attackerAffinity: Affinity;
  readonly defenderAffinity: Affinity;
  readonly multiplier: AffinityMultiplier;
  readonly tag: MatchupTag;
  readonly label: string;
  readonly color: number;
  /** Squared distance (ft²) between the two, for callers that rank engagements. */
  readonly distanceSqFt: number;
}

function affinityFor(world: GameWorld, eid: number): Affinity | undefined {
  return speciesForToken(world.stores.companion.speciesToken[eid] ?? 0)?.affinity;
}

/**
 * Nearest living, non-KO'd rival Companion to `sourceEid` within
 * {@link MATCHUP_RANGE_FT}. Ties on squared distance break by lowest entity id
 * so the pick is total-ordered and reproducible.
 */
export function nearestRivalCompanion(
  world: GameWorld,
  sourceEid: number,
  ownerTeam: number = TeamId.PLAYER,
  rangeFt: number = MATCHUP_RANGE_FT,
): { eid: number; distanceSqFt: number } | undefined {
  const sourceX = world.stores.position.x[sourceEid] ?? 0;
  const sourceY = world.stores.position.y[sourceEid] ?? 0;
  const rangeSq = rangeFt * rangeFt;

  let bestEid: number | undefined;
  let bestDistanceSq = Number.POSITIVE_INFINITY;
  for (const eid of query(world.ecs, [Companion, Position, Team])) {
    if (eid === sourceEid) continue;
    if ((world.stores.team.id[eid] ?? -1) === ownerTeam) continue;
    if ((world.stores.companion.knockedOut[eid] ?? 0) === 1) continue;
    if ((world.stores.health.current[eid] ?? 0) <= 0) continue;
    const dx = (world.stores.position.x[eid] ?? 0) - sourceX;
    const dy = (world.stores.position.y[eid] ?? 0) - sourceY;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq > rangeSq) continue;
    if (
      distanceSq < bestDistanceSq ||
      (distanceSq === bestDistanceSq && eid < (bestEid ?? Infinity))
    ) {
      bestEid = eid;
      bestDistanceSq = distanceSq;
    }
  }
  return bestEid === undefined ? undefined : { eid: bestEid, distanceSqFt: bestDistanceSq };
}

/**
 * Matchup for one party Companion, or `undefined` when it is KO'd, has no
 * rival in range, or either side's species token is unknown.
 */
export function resolveCompanionMatchup(
  world: GameWorld,
  sourceEid: number,
  ownerTeam: number = TeamId.PLAYER,
): Floor3Matchup | undefined {
  if ((world.stores.companion.knockedOut[sourceEid] ?? 0) === 1) return undefined;
  const attackerAffinity = affinityFor(world, sourceEid);
  if (attackerAffinity === undefined) return undefined;

  const rival = nearestRivalCompanion(world, sourceEid, ownerTeam);
  if (rival === undefined) return undefined;
  const defenderAffinity = affinityFor(world, rival.eid);
  if (defenderAffinity === undefined) return undefined;

  const multiplier = affinityMultiplier(attackerAffinity, defenderAffinity);
  const tag = matchupTagForMultiplier(multiplier);
  return {
    sourceEid,
    targetEid: rival.eid,
    attackerAffinity,
    defenderAffinity,
    multiplier,
    tag,
    label: MATCHUP_LABELS[tag],
    color: MATCHUP_COLORS[tag],
    distanceSqFt: rival.distanceSqFt,
  };
}

/**
 * Per-row matchups for the whole party, keyed by the row's stable
 * {@link PartyMemberKey} so the widget can look one up without re-querying.
 */
export function resolvePartyMatchups(
  world: GameWorld,
  rows: readonly Floor3PartyRow[],
  ownerTeam: number = TeamId.PLAYER,
): ReadonlyMap<PartyMemberKey, Floor3Matchup> {
  const byKey = new Map<PartyMemberKey, Floor3Matchup>();
  for (const row of rows) {
    const matchup = resolveCompanionMatchup(world, row.eid, ownerTeam);
    if (matchup !== undefined) byKey.set(row.key, matchup);
  }
  return byKey;
}

/**
 * The single matchup the combat overlay headlines: the closest live
 * engagement in the party. `undefined` when nobody is engaged.
 */
export function resolveHeadlineMatchup(
  world: GameWorld,
  rows: readonly Floor3PartyRow[],
  ownerTeam: number = TeamId.PLAYER,
): Floor3Matchup | undefined {
  let best: Floor3Matchup | undefined;
  for (const matchup of resolvePartyMatchups(world, rows, ownerTeam).values()) {
    if (
      best === undefined ||
      matchup.distanceSqFt < best.distanceSqFt ||
      (matchup.distanceSqFt === best.distanceSqFt && matchup.sourceEid < best.sourceEid)
    ) {
      best = matchup;
    }
  }
  return best;
}
