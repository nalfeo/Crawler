/**
 * Floor 3 Companion League — per-creature combat XP, evolution, and ability
 * unlocks (spec `.specify/specs/floor3-companion-league.md` R7, slice 5).
 *
 * `companionProgressionSystem` scans `world.companionDamageContribution` for
 * targets that have died (`Health.current <= 0`) and splits their
 * Companion-sourced damage credit into XP for the contributing team(s). It is
 * intentionally decoupled from `dropSystem`'s own death bookkeeping — it only
 * needs "has this target's HP reached 0 yet", which is safe to re-check every
 * frame — so it can be wired directly into the shared core step instead of
 * threaded through `dropSystem`'s per-entity loop. Stale ledger entries (a
 * tracked target or contributor removed alive, or an EID recycled before its
 * kill was processed) are purged from `world.companionDamageContribution` by
 * `clearEntityStores` (see `src/core/spawners/entity-core.ts`), which every
 * removal/creation path already calls.
 *
 * Runs BEFORE `companionKOSystem`/`dropSystem` in `runCoreSimulationStep`: a
 * killed Companion target still reads `Health.current === 0` here, before
 * `companionKOSystem` clamps it back to 1 for the KO/recovery state machine
 * (slice 6) — this system must see the real 0 to detect the kill at all.
 *
 * Multi-team credit: if two independent Companion teams both damage the same
 * third-party target before it dies, each team is scored from its own
 * perspective (its own damage total is its own 100% pool) rather than
 * splitting one shared pool across teams — a slice-5 simplification. This is
 * only reachable once wild/rival encounters exist (slices 7/8) and should be
 * revisited then if it proves farmable (e.g. a team repeatedly chip-tagging a
 * target that another team is killing).
 */
import { hasComponent, query } from 'bitecs';
import { Companion, Enemy, Team } from '../components.js';
import type { GameWorld } from '../world.js';
import {
  formForLevel,
  learnedAbilityIds,
  speciesForToken,
} from '../../shared/data/floor3/species.js';
import { levelForXp } from '../../shared/xpMath.js';
import tuning from '../../shared/data/tuning.json';

const KILL_XP_BASE = tuning.floor3Companion.killXpBase;
const ASSIST_FLOOR_SHARE = tuning.floor3Companion.assistFloorShare;

/**
 * Awards Companion combat XP for every tracked target whose health has
 * reached 0, then removes it from `world.companionDamageContribution` so the
 * per-target ledger cannot grow unbounded across a run. No-op when nothing is
 * tracked (the common case: no Companion has dealt damage this run).
 */
export function companionProgressionSystem(world: GameWorld): void {
  if (world.companionDamageContribution.size === 0) return;

  for (const [targetEid, contributions] of Array.from(world.companionDamageContribution)) {
    const currentHealth = world.stores.health.current[targetEid] ?? 0;
    if (currentHealth > 0) continue;
    world.companionDamageContribution.delete(targetEid);
    if (contributions.size === 0) continue;

    const byTeam = new Map<number, Map<number, number>>();
    for (const [companionEid, damage] of contributions) {
      const teamId = world.stores.team.id[companionEid] ?? 0;
      let teamContributors = byTeam.get(teamId);
      if (teamContributors === undefined) {
        teamContributors = new Map();
        byTeam.set(teamId, teamContributors);
      }
      teamContributors.set(companionEid, damage);
    }

    for (const [teamId, teamContributors] of byTeam) {
      awardTeamXp(world, teamId, teamContributors);
    }
  }
}

function awardTeamXp(
  world: GameWorld,
  teamId: number,
  contributors: ReadonlyMap<number, number>,
): void {
  const teamTotalDamage = Array.from(contributors.values()).reduce((sum, d) => sum + d, 0);
  if (teamTotalDamage <= 0) return;

  const livingTeammates = query(world.ecs, [Enemy, Companion, Team]).filter(
    (eid) =>
      (world.stores.team.id[eid] ?? -1) === teamId &&
      (world.stores.companion.knockedOut[eid] ?? 0) === 0 &&
      // Excludes a teammate that reached 0 HP this same frame: this system
      // runs BEFORE `companionKOSystem`, so its `knockedOut` flag isn't set
      // yet even though it just went down — this direct health check is what
      // actually excludes it from the assist-floor split.
      (world.stores.health.current[eid] ?? 0) > 0,
  );

  const assistPool = KILL_XP_BASE * ASSIST_FLOOR_SHARE;
  const meritPool = KILL_XP_BASE - assistPool;
  const assistShare = livingTeammates.length > 0 ? assistPool / livingTeammates.length : 0;

  const awardByEid = new Map<number, number>();
  for (const eid of livingTeammates) {
    awardByEid.set(eid, (awardByEid.get(eid) ?? 0) + assistShare);
  }
  for (const [companionEid, damage] of contributors) {
    const merit = meritPool * (damage / teamTotalDamage);
    awardByEid.set(companionEid, (awardByEid.get(companionEid) ?? 0) + merit);
  }

  for (const [companionEid, award] of awardByEid) {
    if (award <= 0) continue;
    if (!hasComponent(world.ecs, companionEid, Companion)) continue;
    applyCompanionXp(world, companionEid, award);
  }
}

function applyCompanionXp(world: GameWorld, companionEid: number, award: number): void {
  const store = world.stores.companion;
  const nextXp = (store.xp[companionEid] ?? 0) + award;
  store.xp[companionEid] = nextXp;

  // `xpMath.levelForXp` returns a 0-based level (xp=0 => level 0), but the
  // Companion/species convention (`FORM_MIN_LEVELS`/`ABILITY_MILESTONE_LEVELS`,
  // and the level-1 spawn state) is 1-based, so the xpMath result is offset by
  // +1. `Math.max(previousLevel, ...)` additionally guards against ever
  // reporting a level regression from a tiny XP award.
  const previousLevel = store.level[companionEid] ?? 1;
  const nextLevel = Math.max(previousLevel, Math.min(255, levelForXp(nextXp) + 1));
  if (nextLevel === previousLevel) return;
  store.level[companionEid] = nextLevel;

  const species = speciesForToken(store.speciesToken[companionEid] ?? 0);
  if (species === undefined) return;
  const nextForm = formForLevel(species, nextLevel).form;
  store.form[companionEid] = nextForm;
}

/**
 * Ability ids a Companion has learned at its current level. Derived on read
 * from the pure `(species, level)` milestone table (species.ts) rather than
 * stored per-entity, since it is a total function of two already-stored
 * fields — no ECS array-per-entity store is needed for slice 5.
 */
export function companionLearnedAbilityIds(
  world: GameWorld,
  companionEid: number,
): readonly string[] {
  const species = speciesForToken(world.stores.companion.speciesToken[companionEid] ?? 0);
  if (species === undefined) return [];
  return learnedAbilityIds(species, world.stores.companion.level[companionEid] ?? 1);
}
