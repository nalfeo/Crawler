/**
 * Floor 3 Companion League — KO/recovery state machine + Rally Point instant
 * recovery + the party-wipe lose predicate (spec `.specify/specs/floor3-companion-league.md`
 * R5/R11, slice 6).
 *
 * A Companion whose `Health` reaches 0 is **knocked out** for the current
 * engagement, not killed: this system clamps its `Health.current` back to 1
 * (so `dropSystem`'s `[Enemy, Health]` kill query never observes 0 for it —
 * it must run before `dropSystem`) and flips `Companion.knockedOut = 1`.
 * `companionAISystem` already treats a knocked-out Companion as inert
 * (`kind: 'disabled'`).
 *
 * Recovery has two paths (both spec R11):
 * 1. **Engagement end** — once a team has gone `engagementEndFrames` without
 *    any rival-team Companion within `engagementRangeFt` of any of its living
 *    Companions, every knocked-out Companion on that team is revived to full
 *    health. Tracked per-team via `world.companionEngagementIdleSince`.
 * 2. **Rally Point** — a `RallyPoint` entity instantly revives the player's
 *    whole party whenever the player is within `rallyPointRangeFt`,
 *    regardless of engagement state.
 */
import { query } from 'bitecs';
import { Companion, Enemy, Health, Player, Position, RallyPoint, Team } from '../components.js';
import type { GameWorld } from '../world.js';
import { TeamId } from '../../shared/constants.js';
import tuning from '../../shared/data/tuning.json';

const ENGAGEMENT_RANGE_FT = tuning.floor3Companion.engagementRangeFt;
const ENGAGEMENT_END_FRAMES = tuning.floor3Companion.engagementEndFrames;
const RALLY_POINT_RANGE_FT = tuning.floor3Companion.rallyPointRangeFt;

function reviveCompanion(world: GameWorld, eid: number): void {
  const { health, companion } = world.stores;
  companion.knockedOut[eid] = 0;
  health.current[eid] = health.max[eid] ?? 1;
}

export function companionKOSystem(world: GameWorld): void {
  const companions = query(world.ecs, [Enemy, Companion, Health, Team, Position]);
  if (companions.length === 0) return;

  const { health, position, team, companion } = world.stores;

  // 1. KO detection — clamp instead of letting dropSystem process the death.
  for (const eid of companions) {
    if ((health.current[eid] ?? 0) > 0) continue;
    health.current[eid] = 1;
    companion.knockedOut[eid] = 1;
  }

  // 2. Per-team engagement tracking: is any rival-team Companion within range
  //    of any of this team's Companions this frame? (Symmetric: a rival
  //    standing near a knocked-out Companion still counts as engagement —
  //    the fight isn't over just because one member is down.)
  const engagedTeams = new Set<number>();
  for (const eid of companions) {
    const teamId = team.id[eid] ?? 0;
    const x = position.x[eid] ?? 0;
    const y = position.y[eid] ?? 0;
    for (const rival of companions) {
      const rivalTeamId = team.id[rival] ?? 0;
      if (rivalTeamId === teamId) continue;
      const dx = (position.x[rival] ?? 0) - x;
      const dy = (position.y[rival] ?? 0) - y;
      if (dx * dx + dy * dy <= ENGAGEMENT_RANGE_FT * ENGAGEMENT_RANGE_FT) {
        engagedTeams.add(teamId);
        engagedTeams.add(rivalTeamId);
      }
    }
  }

  // 3. Engagement-end revival, tracked per team via an idle-since frame.
  const teamsWithKnockedOut = new Set<number>();
  for (const eid of companions) {
    if ((companion.knockedOut[eid] ?? 0) === 1) teamsWithKnockedOut.add(team.id[eid] ?? 0);
  }
  for (const teamId of teamsWithKnockedOut) {
    if (engagedTeams.has(teamId)) {
      world.companionEngagementIdleSince.delete(teamId);
      continue;
    }
    let idleSince = world.companionEngagementIdleSince.get(teamId);
    if (idleSince === undefined) {
      idleSince = world.frameCount;
      world.companionEngagementIdleSince.set(teamId, idleSince);
    }
    if (world.frameCount - idleSince < ENGAGEMENT_END_FRAMES) continue;
    world.companionEngagementIdleSince.delete(teamId);
    for (const eid of companions) {
      if ((team.id[eid] ?? 0) !== teamId) continue;
      if ((companion.knockedOut[eid] ?? 0) === 1) reviveCompanion(world, eid);
    }
  }
  for (const teamId of world.companionEngagementIdleSince.keys()) {
    if (!teamsWithKnockedOut.has(teamId)) world.companionEngagementIdleSince.delete(teamId);
  }

  // 4. Rally Point instant recovery for the player's own party.
  const rallyPoints = query(world.ecs, [RallyPoint, Position]);
  if (rallyPoints.length === 0) return;
  const players = query(world.ecs, [Player, Position]);
  const playerEid = players[0];
  if (playerEid === undefined) return;
  const px = position.x[playerEid] ?? 0;
  const py = position.y[playerEid] ?? 0;
  let atRallyPoint = false;
  for (const rallyEid of rallyPoints) {
    const dx = (position.x[rallyEid] ?? 0) - px;
    const dy = (position.y[rallyEid] ?? 0) - py;
    if (dx * dx + dy * dy <= RALLY_POINT_RANGE_FT * RALLY_POINT_RANGE_FT) {
      atRallyPoint = true;
      break;
    }
  }
  if (!atRallyPoint) return;
  world.companionEngagementIdleSince.delete(TeamId.PLAYER);
  for (const eid of companions) {
    if ((team.id[eid] ?? 0) !== TeamId.PLAYER) continue;
    if ((companion.knockedOut[eid] ?? 0) === 1) reviveCompanion(world, eid);
  }
}

/**
 * Lose predicate (spec R5/R11): true when `partyTeamId` has at least one
 * Companion and every one of them is knocked out simultaneously. Pure read —
 * the future Floor 3 objective tick (slice 8) calls this each frame to detect
 * a wipe; it is exercised directly by tests until that consumer lands.
 */
export function isPartyWiped(world: GameWorld, partyTeamId: number = TeamId.PLAYER): boolean {
  const companions = query(world.ecs, [Enemy, Companion, Team]);
  let hasPartyCompanion = false;
  for (const eid of companions) {
    if ((world.stores.team.id[eid] ?? -1) !== partyTeamId) continue;
    hasPartyCompanion = true;
    if ((world.stores.companion.knockedOut[eid] ?? 0) !== 1) return false;
  }
  return hasPartyCompanion;
}
