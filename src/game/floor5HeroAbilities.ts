/**
 * Floor 5 · Hostile Takeover — field-Hero abilities, one per tactical role.
 *
 * These are **adapters onto the existing generic mob-ability runtime**
 * (`src/core/mob-abilities/runtime.ts`): they author a
 * {@link MobAbilityRuntimeDefinition} and a named resolve handler, and the
 * shared executor drives the `cooldown -> telegraph -> resolution` phase
 * machine, the committed geometry, the telegraph cue, and the one-per-cast
 * announcement. Floor 5 deliberately adds NO second ability system.
 *
 * Per spec `FR6.2` a Hero's declared role is its sole strategic mode for its
 * whole lifetime, so abilities are authored per ROLE (all Heroes of a role
 * share one) and the flavour text carries the individual Hero's display name.
 *
 * Determinism: every handler is a pure function of world state and committed
 * geometry. No `Math.random()`, no `Date.now()`, no RNG draws at all — timing
 * comes from the fixed-step ability clock.
 */

import { query } from 'bitecs';
import {
  Health,
  Position,
  SiegeMinion,
  Team,
  applyDamage,
  type GameWorld,
  type MobAbilityGeometry,
  type MobAbilityResolveContext,
  type MobAbilityRuntimeDefinition,
} from '../core/index.js';
import { TeamId } from '../shared/constants.js';
import type {
  Floor5FieldHeroCardEntry,
  Floor5FieldHeroRole,
  Floor5SiegeState,
} from '../shared/floor-types.js';

/**
 * Appearance key stamped on a Hero entity so the shared runtime's caster
 * validity check (`enemyAppearanceKeys` must equal `bossArchetypeKey`) binds
 * the ability to the role that registered it.
 */
export function floor5HeroArchetypeKey(role: Floor5FieldHeroRole): string {
  return `floor5-field-hero-${role}`;
}

function floor5HeroAbilityId(role: Floor5FieldHeroRole): string {
  return `floor5-field-hero-${role}-ability`;
}

/** Within-role ability tuning (`HUMAN_GATE-4`), authored here, not derived. */
const FIRST_ELIGIBLE_AFTER_MS = 4_000;
const COOLDOWN_MS = 6_000;
const TELEGRAPH_MS = 1_200;
const COUNTER_PUSH_REINFORCE_HP = 8;
const AUDIT_ZONE_RADIUS_FT = 9;
const AUDIT_ZONE_DAMAGE = 9;
const WILDCAT_STRIKE_RADIUS_FT = 10;
const WILDCAT_STRIKE_STALL_MS = 2_000;
const PERFORMANCE_REVIEW_RADIUS_FT = 10;
const PERFORMANCE_REVIEW_HEAL = 6;
const HOSTILE_BID_RADIUS_FT = 7;
const HOSTILE_BID_DAMAGE = 12;
const HOSTILE_BID_MAX_RANGE_FT = 22;

function floor5State(world: GameWorld): Floor5SiegeState | undefined {
  return world.floorExtendedState?.floor5Siege;
}

function positionOf(world: GameWorld, eid: number): { x: number; y: number } {
  return { x: world.stores.position.x[eid] ?? 0, y: world.stores.position.y[eid] ?? 0 };
}

function circleCenter(geometry: MobAbilityGeometry): { x: number; y: number } | null {
  return geometry.kind === 'circle' ? { x: geometry.x, y: geometry.y } : null;
}

function liveSiegeMinionsOfTeam(world: GameWorld, teamId: number): number[] {
  return Array.from(query(world.ecs, [SiegeMinion, Position, Health, Team]))
    .filter(
      (eid) =>
        (world.stores.health.current[eid] ?? 0) > 0 && (world.stores.team.id[eid] ?? -1) === teamId,
    )
    .sort((a, b) => a - b);
}

function withinRadius(
  world: GameWorld,
  eid: number,
  center: { x: number; y: number },
  radiusFt: number,
): boolean {
  const pos = positionOf(world, eid);
  return Math.hypot(pos.x - center.x, pos.y - center.y) <= radiusFt;
}

function countAbilityCast(world: GameWorld): void {
  const state = floor5State(world);
  if (state) state.heroes.abilityCasts += 1;
}

function damageAlliedTargets(
  world: GameWorld,
  ctx: MobAbilityResolveContext,
  center: { x: number; y: number },
  radiusFt: number,
  amount: number,
): void {
  const casterPos = positionOf(world, ctx.casterEid);
  // Minions only. Hero abilities never damage structures: structure demolition
  // is the lane-war/Ratings Ram contract from Slices 2/3 (see ADR).
  const targets = liveSiegeMinionsOfTeam(world, TeamId.SIEGE_ALLIED).filter((eid) =>
    withinRadius(world, eid, center, radiusFt),
  );
  for (const eid of targets) {
    const pos = positionOf(world, eid);
    applyDamage(world, eid, amount, pos.x, pos.y, {
      origin: 'environment',
      affinity: 'physical',
      scaleWithPrimary: false,
      canCrit: false,
      delivery: 'projectile',
      sourceX: casterPos.x,
      sourceY: casterPos.y,
      sourceEid: ctx.casterEid,
    });
  }
}

function healEntity(world: GameWorld, eid: number, amount: number): void {
  const current = world.stores.health.current[eid] ?? 0;
  if (current <= 0) return;
  const max = world.stores.health.max[eid] ?? current;
  world.stores.health.current[eid] = Math.min(max, current + amount);
}

/**
 * `counter-push` — "Restructuring Order".
 *
 * The Turnaround Consultant/Proxy Fighter restructures the castle-side
 * checkpoint it is fighting to hold, healing it back up (design bible §9).
 */
function resolveRestructuringOrder(world: GameWorld, _ctx: MobAbilityResolveContext): void {
  countAbilityCast(world);
  const state = floor5State(world);
  if (!state) return;
  const checkpoint = state.structures['enemy-checkpoint'];
  if (checkpoint.eid > 0) {
    healEntity(world, checkpoint.eid, COUNTER_PUSH_REINFORCE_HP);
  }
}

/**
 * `checkpoint-defense` — "Audit Zone".
 *
 * A telegraphed no-standing zone centred on the anchoring Hero; allied units
 * still inside at resolution take the finding.
 */
function resolveAuditZone(world: GameWorld, ctx: MobAbilityResolveContext): void {
  countAbilityCast(world);
  const center = circleCenter(ctx.geometry) ?? positionOf(world, ctx.casterEid);
  damageAlliedTargets(world, ctx, center, AUDIT_ZONE_RADIUS_FT, AUDIT_ZONE_DAMAGE);
}

/**
 * `engine-disruption` — "Wildcat Strike".
 *
 * Stalls Ratings Ram construction for a telegraphed window instead of dealing
 * damage. The stall is only meaningful while the Ram is actually being built,
 * so it is gated on `engineState === 'BUILDING'` at resolution and clamped to a
 * single window's worth of budget: it can never bank deferred debt that lands
 * long after the cast (or after the Hero is dead). The budget is consumed by
 * `advanceFloor5RamConstruction`, which expires it against the same fixed-step
 * clock whether or not construction is progressing.
 */
function resolveWildcatStrike(world: GameWorld, _ctx: MobAbilityResolveContext): void {
  countAbilityCast(world);
  const state = floor5State(world);
  if (!state) return;
  if (state.engineState !== 'BUILDING') return;
  // Refresh to a full window rather than adding to it: the stall is capped at
  // one window, so a re-cast restarts it instead of banking a longer one.
  state.heroes.buildStallMs = WILDCAT_STRIKE_STALL_MS;
}

/**
 * `minion-support` — "Performance Review".
 *
 * Heals every castle-side siege minion inside the committed aura.
 */
function resolvePerformanceReview(world: GameWorld, ctx: MobAbilityResolveContext): void {
  countAbilityCast(world);
  const center = circleCenter(ctx.geometry) ?? positionOf(world, ctx.casterEid);
  for (const eid of liveSiegeMinionsOfTeam(world, TeamId.SIEGE_ENEMY)) {
    if (withinRadius(world, eid, center, PERFORMANCE_REVIEW_RADIUS_FT)) {
      healEntity(world, eid, PERFORMANCE_REVIEW_HEAL);
    }
  }
}

/**
 * `artillery` — "Hostile Bid".
 *
 * A lobbed AoE committed at telegraph start onto the Hero's currently selected
 * target (or its own position when it has none), forcing repositioning.
 */
function resolveHostileBid(world: GameWorld, ctx: MobAbilityResolveContext): void {
  countAbilityCast(world);
  const center = circleCenter(ctx.geometry) ?? positionOf(world, ctx.casterEid);
  damageAlliedTargets(world, ctx, center, HOSTILE_BID_RADIUS_FT, HOSTILE_BID_DAMAGE);
}

/**
 * Commit the artillery lob onto the Hero's committed target position, clamped
 * to the ability's max range. Reads the SAME `siegeHeroSystem` target the Hero
 * is already steering against, so the telegraph can never disagree with the
 * Hero's stance.
 */
function commitHostileBidGeometry(ctx: {
  readonly world: GameWorld;
  readonly casterEid: number;
  readonly lockedX: number;
  readonly lockedY: number;
}): MobAbilityGeometry {
  const { world, casterEid, lockedX, lockedY } = ctx;
  const targetEid = world.stores.siegeHero.targetEid[casterEid] ?? 0;
  if (targetEid <= 0 || (world.stores.health.current[targetEid] ?? 0) <= 0) {
    return { kind: 'circle', x: lockedX, y: lockedY, radiusFt: HOSTILE_BID_RADIUS_FT };
  }
  const target = positionOf(world, targetEid);
  const dx = target.x - lockedX;
  const dy = target.y - lockedY;
  const distance = Math.hypot(dx, dy);
  const scale = distance > HOSTILE_BID_MAX_RANGE_FT ? HOSTILE_BID_MAX_RANGE_FT / distance : 1;
  return {
    kind: 'circle',
    x: lockedX + dx * scale,
    y: lockedY + dy * scale,
    radiusFt: HOSTILE_BID_RADIUS_FT,
  };
}

interface RoleAbilitySpec {
  readonly radiusFt: number;
  readonly announcement: string;
  readonly resolve: (world: GameWorld, ctx: MobAbilityResolveContext) => void;
  readonly commitGeometry?: MobAbilityRuntimeDefinition['commitGeometry'];
  /**
   * Telegraph origin. Self-centred roles follow the caster so the drawn circle
   * never lies about where the Hero is standing; the artillery lob must stay
   * `locked`, because `follows-caster` re-centres the committed circle on the
   * caster every telegraph tick and would silently discard the geometry that
   * {@link commitHostileBidGeometry} committed onto the selected target.
   */
  readonly originMode: MobAbilityRuntimeDefinition['originMode'];
}

const ROLE_ABILITY_SPECS: Readonly<Record<Floor5FieldHeroRole, RoleAbilitySpec>> = {
  'counter-push': {
    radiusFt: 6,
    announcement: 'files a Restructuring Order!',
    resolve: resolveRestructuringOrder,
    originMode: 'follows-caster',
  },
  'checkpoint-defense': {
    radiusFt: AUDIT_ZONE_RADIUS_FT,
    announcement: 'opens an Audit Zone!',
    resolve: resolveAuditZone,
    originMode: 'follows-caster',
  },
  'engine-disruption': {
    radiusFt: WILDCAT_STRIKE_RADIUS_FT,
    announcement: 'calls a Wildcat Strike!',
    resolve: resolveWildcatStrike,
    originMode: 'follows-caster',
  },
  'minion-support': {
    radiusFt: PERFORMANCE_REVIEW_RADIUS_FT,
    announcement: 'runs a Performance Review!',
    resolve: resolvePerformanceReview,
    originMode: 'follows-caster',
  },
  artillery: {
    radiusFt: HOSTILE_BID_RADIUS_FT,
    announcement: 'lobs a Hostile Bid!',
    resolve: resolveHostileBid,
    commitGeometry: commitHostileBidGeometry,
    originMode: 'locked',
  },
};

/**
 * Build the runtime ability definition for the Hero currently taking the field.
 *
 * One definition per ROLE (spec `FR6.2`); the announcement carries the drawn
 * Hero's display name so the telegraph reads as that named defender.
 */
export function createFloor5HeroAbilityDefinition(
  card: Floor5FieldHeroCardEntry,
): MobAbilityRuntimeDefinition {
  const spec = ROLE_ABILITY_SPECS[card.role];
  return {
    abilityId: floor5HeroAbilityId(card.role),
    bossArchetypeKey: floor5HeroArchetypeKey(card.role),
    firstEligibleAfterMs: FIRST_ELIGIBLE_AFTER_MS,
    cooldownMs: COOLDOWN_MS,
    telegraphDurationMs: TELEGRAPH_MS,
    dangerColor: 'hostile-red',
    announcementText: `${card.displayName} ${spec.announcement}`,
    geometry: { kind: 'circle', radiusFt: spec.radiusFt },
    // `self` targeting keeps every Hero telegraph independent of whether a
    // Player entity exists, which is what makes the headless siege runs and the
    // windowed game commit identical geometry.
    targetingMode: 'self',
    originMode: spec.originMode,
    ...(spec.commitGeometry ? { commitGeometry: spec.commitGeometry } : {}),
    resolve: spec.resolve,
  };
}
