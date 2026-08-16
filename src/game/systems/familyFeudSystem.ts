/**
 * familyFeudSystem — Floor 2 Slice 3 band-driven AI prepass.
 *
 * Registered in Floor 2's scenario definition immediately before
 * `enemyAISystem`; the bootstrap supplies that ordering to both real pipelines.
 * For every mob with `FamilyMembership` it:
 *
 *   1. Reads the mob's family band via `bandFor(getRelation(world, familyId))`.
 *   2. Chooses a "virtual target" that `enemyAISystem` will pursue instead of
 *      the player:
 *        - hate / hostile: primary target = player, fallback = nearest rival
 *          when the player is unreachable (out of FOV / room-blocked).
 *        - neutral: only rival-family mobs. Player is ignored entirely.
 *        - friendly: follow the player (leashed to `friendlyLeashTiles`);
 *          re-target the player's most recent attacker during
 *          `friendlyRetaliationMs`.
 *   3. Computes an *effective* movement speed for hate-band mobs via
 *      `effectiveSpeedForHate` (FR9). This is stored as a WeakMap-backed
 *      per-frame override that `enemyAISystem`'s `getEnemySpeed` folds in.
 *
 * Two mutually hostile families are ALWAYS treated as rivals regardless of
 * their player-relation (FR5) — the rival check is purely `otherMob.familyId
 * !== self.familyId`.
 *
 * Determinism: rival tie-breaks are purely by lower eid (a stable sort with no
 * `world.rng` draw), so the same seed always yields the same choice. No
 * `Math.random()`, no `Date.now()`. Retaliation arms off the durable
 * `world.lastPlayerHit` signal and expires via `world.elapsedMs`.
 *
 * Perf: rival lookups go through a per-frame spatial hash of family mobs so
 * candidate lists stay bounded by the tuning-configured
 * `feudEngagementRadiusTiles` + `feudCandidateLimit` (FR12, ADR 0024). No
 * global O(n^2) scan.
 */
import { hasComponent, query } from 'bitecs';
import { FamilyMembership, Enemy, Player, Position, DeathTimer } from '../../core/components.js';
import { createSpatialHashGrid, type SpatialHashGrid } from '../../core/collision.js';
import {
  bandFor,
  effectiveSpeedForHate,
  getRelation,
  asFamilyId,
  type FactionBand,
  type FamilyId,
} from '../../core/faction-relations.js';
import type { GameWorld } from '../../core/world.js';
import tuning from '../../shared/data/tuning.json';

/**
 * Kind of target a family-driven mob is currently pursuing. Distinct from the
 * band so we can (a) recognise "no override, keep default player target" and
 * (b) exercise the perf-critical rival paths in tests.
 */
export type FamilyTargetKind =
  | 'player'
  | 'rival-fallback'
  | 'rival-primary'
  | 'attacker'
  | 'follow'
  | 'idle';

/** Per-frame family-AI decision for one mob. */
export interface FamilyAIDecision {
  /** Absolute world position enemyAISystem should treat as the "player". */
  x: number;
  y: number;
  /** What the target represents (used by tests, HUD, lab overlays). */
  kind: FamilyTargetKind;
  /** Optional target eid — undefined for follow/idle. */
  targetEid: number | undefined;
  /** Band this decision was made for (cached to avoid re-classifying). */
  band: FactionBand;
  /**
   * Effective speed to apply this frame if it differs from the mob's base
   * speed. `undefined` means "no override". Hate-band mobs use this to fold in
   * the speed ramp; other bands leave it undefined.
   */
  effectiveSpeed?: number;
  /**
   * When true, `enemyAISystem` should bypass FOV/room/aggro detection for this
   * mob — the family AI has decided it has a target. Trash mobs never get an
   * override so this only affects family mobs.
   */
  bypassPlayerDetection: boolean;
}

const decisionsByWorld = new WeakMap<GameWorld, Map<number, FamilyAIDecision>>();
const feudGridByWorld = new WeakMap<GameWorld, SpatialHashGrid>();
const retaliationByWorld = new WeakMap<
  GameWorld,
  { attackerEid: number; untilMs: number } | null
>();

/** Public read: the last decision computed for `eid`, or `undefined`. */
export function getFamilyAIDecision(world: GameWorld, eid: number): FamilyAIDecision | undefined {
  return decisionsByWorld.get(world)?.get(eid);
}

/**
 * Debug-only spatial-hash accessor for perf tests: returns the per-frame feud
 * grid so tests can assert candidate lookups stay bounded.
 */
export function peekFamilyFeudGrid(world: GameWorld): SpatialHashGrid | undefined {
  return feudGridByWorld.get(world);
}

/** Debug read of the retaliation latch for tests / lab overlays. */
export function peekFriendlyRetaliation(
  world: GameWorld,
): { attackerEid: number; untilMs: number } | null {
  return retaliationByWorld.get(world) ?? null;
}

/**
 * Read the mob's `FamilyMembership.familyId` and resolve it to the actual
 * branded `FamilyId` via `world.floorExtendedState?.familyState?.presentFamilies`. Returns
 * `undefined` for trash mobs (no `FamilyMembership`) or when the floor state
 * hasn't been initialised — trash always falls through to the default
 * player-only targeting.
 */
export function getMobFamilyId(world: GameWorld, eid: number): FamilyId | undefined {
  if (!hasComponent(world.ecs, eid, FamilyMembership)) return undefined;
  const idx = world.stores.familyMembership.familyId[eid] ?? 0;
  const present = world.floorExtendedState?.familyState?.presentFamilies;
  if (present !== undefined && idx < present.length) {
    return present[idx];
  }
  // Fallback for tests that stamp FamilyMembership without floor2State: use the
  // raw numeric slot as a synthetic id so rival-vs-same-family comparisons still
  // work (they compare the numeric familyId directly below anyway).
  return asFamilyId(`__slot:${idx}`);
}

function isRivalPair(world: GameWorld, aEid: number, bEid: number): boolean {
  const aHas = hasComponent(world.ecs, aEid, FamilyMembership);
  const bHas = hasComponent(world.ecs, bEid, FamilyMembership);
  if (!aHas || !bHas) return false;
  const aIdx = world.stores.familyMembership.familyId[aEid] ?? 0;
  const bIdx = world.stores.familyMembership.familyId[bEid] ?? 0;
  return aIdx !== bIdx;
}

/**
 * Rebuild the spatial hash of family mobs for this frame. We keep this
 * separate from `collisionSystem`'s grid because `familyFeudSystem` runs BEFORE
 * `collisionSystem` (collision is post-movement) and needs an up-to-date
 * broad-phase to bound candidate rivals. Cell size matches the
 * tuning-configured `feudEngagementRadiusTiles` so any rival within one cell
 * of the query centre is a candidate.
 */
function rebuildFeudGrid(world: GameWorld, enemyList: number[]): SpatialHashGrid {
  let grid = feudGridByWorld.get(world);
  if (grid === undefined) {
    grid = createSpatialHashGrid(tuning.factionRelations.feudEngagementRadiusTiles);
    feudGridByWorld.set(world, grid);
  }
  grid.clear();
  for (const eid of enemyList) {
    if (!hasComponent(world.ecs, eid, FamilyMembership)) continue;
    if (hasComponent(world.ecs, eid, DeathTimer)) continue;
    const x = world.stores.position.x[eid] ?? 0;
    const y = world.stores.position.y[eid] ?? 0;
    // Half-widths of 0.5 are enough — the queryRadius call uses circle-AABB.
    grid.insert(eid, x, y, 0.5, 0.5);
  }
  return grid;
}

/**
 * Return the nearest rival-family mob to `(x,y)` from a bounded spatial-hash
 * candidate list. Trimming happens BEFORE sorting so we stay under
 * `feudCandidateLimit` per FR12. Ties broken by lower eid (deterministic; no
 * rng draw needed — same seed ⇒ same choice).
 */
export function findNearestRival(
  world: GameWorld,
  grid: SpatialHashGrid,
  selfEid: number,
  x: number,
  y: number,
): { eid: number; x: number; y: number; dist: number } | null {
  const radius = tuning.factionRelations.feudEngagementRadiusTiles;
  const limit = tuning.factionRelations.feudCandidateLimit;
  const raw = grid.queryRadius(x, y, radius);
  // Copy first because queryRadius returns a REUSED internal buffer.
  const candidates = raw.slice(0, limit);
  let bestEid = -1;
  let bestDist = Infinity;
  let bestX = 0;
  let bestY = 0;
  for (const other of candidates) {
    if (other === selfEid) continue;
    if (!isRivalPair(world, selfEid, other)) continue;
    if (hasComponent(world.ecs, other, DeathTimer)) continue;
    const ox = world.stores.position.x[other] ?? 0;
    const oy = world.stores.position.y[other] ?? 0;
    const dx = ox - x;
    const dy = oy - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDist || (d2 === bestDist && other < bestEid)) {
      bestDist = d2;
      bestEid = other;
      bestX = ox;
      bestY = oy;
    }
  }
  if (bestEid === -1) return null;
  return { eid: bestEid, x: bestX, y: bestY, dist: Math.sqrt(bestDist) };
}

/**
 * Refresh the friendly-retaliation latch from the DURABLE `world.lastPlayerHit`
 * signal that `applyDamage` writes whenever a hit lands on the player.
 *
 * We deliberately do NOT scan the transient `world.combatEvents` queue here. In
 * the real visual frame loop that queue is drained every frame by the VFX layer
 * (`combatVfx.update`, invoked from the scene's `bridge.sync`) BEFORE the next
 * frame's prepass runs — so a player-hit event pushed by `damageSystem` in
 * frame N is already gone when this prepass runs in frame N+1. Scanning it made
 * ally-defend silently never fire in the shipped game; it only "worked" in the
 * headless mirror, which never drains the queue. Reading the durable signal
 * makes the feature fire identically in both pipelines.
 */
function updateRetaliationFromHitEvents(world: GameWorld): void {
  const windowMs = tuning.factionRelations.friendlyRetaliationMs;
  const hit = world.lastPlayerHit;
  let latch: { attackerEid: number; untilMs: number } | null = null;
  if (hit !== undefined && hit.attackerEid >= 0) {
    const untilMs = hit.atMs + windowMs;
    // Arm only while the retaliation window (measured from the actual hit) is
    // still open; otherwise the latch expires and the ally reverts to follow.
    if (untilMs > world.elapsedMs) {
      latch = { attackerEid: hit.attackerEid, untilMs };
    }
  }
  retaliationByWorld.set(world, latch);
}

/**
 * Public helper — reset the retaliation latch and the durable player-hit
 * signal. Used by tests and the lab to isolate scenarios.
 */
export function resetFamilyFeudState(world: GameWorld): void {
  decisionsByWorld.delete(world);
  retaliationByWorld.delete(world);
  world.lastPlayerHit = undefined;
}

/**
 * Determine whether a friendly-band mob is currently INSIDE its leash radius
 * around the player. Inside → the mob loiters; outside → it steers toward the
 * player. Exposed for the lab overlay.
 */
export function isFriendlyInLeash(distanceToPlayer: number): boolean {
  return distanceToPlayer <= tuning.factionRelations.friendlyLeashTiles;
}

export function familyFeudSystem(world: GameWorld): void {
  // No player = no target work. Clear the last-frame decisions so a stale entry
  // doesn't leak into next frame if the player is respawned.
  const players = query(world.ecs, [Player, Position]);
  const playerEid = players[0];
  const decisions = decisionsByWorld.get(world) ?? new Map<number, FamilyAIDecision>();
  decisions.clear();
  decisionsByWorld.set(world, decisions);

  updateRetaliationFromHitEvents(world);

  if (playerEid === undefined) {
    return;
  }

  const playerX = world.stores.position.x[playerEid] ?? 0;
  const playerY = world.stores.position.y[playerEid] ?? 0;
  const playerVx = world.stores.velocity.x[playerEid] ?? 0;
  const playerVy = world.stores.velocity.y[playerEid] ?? 0;
  const playerSpeed = Math.hypot(playerVx, playerVy);

  const enemyList = query(world.ecs, [Enemy, Position]);
  const grid = rebuildFeudGrid(world, [...enemyList]);
  const retaliation = retaliationByWorld.get(world) ?? null;

  for (const eid of enemyList) {
    if (hasComponent(world.ecs, eid, DeathTimer)) continue;
    if (!hasComponent(world.ecs, eid, FamilyMembership)) continue;

    const familyId = getMobFamilyId(world, eid);
    if (familyId === undefined) continue;
    if ((world.stores.familyMembership.isBoss[eid] ?? 0) === 1) {
      const encounter = world.floorExtendedState?.familyState?.bossEncounters?.get(familyId);
      if (encounter?.started && !encounter.defeated) continue;
    }

    const relation = getRelation(world, familyId);
    const band = bandFor(relation);
    const enemyX = world.stores.position.x[eid] ?? 0;
    const enemyY = world.stores.position.y[eid] ?? 0;
    const baseSpeed = world.stores.enemyBehavior.speed[eid] ?? 0;
    let decision: FamilyAIDecision | null = null;

    if (band === 'friendly') {
      // Defend-attacker window (bounded by friendlyRetaliationMs). We only pick
      // the attacker when it's still alive; otherwise revert to follow.
      if (
        retaliation !== null &&
        retaliation.attackerEid >= 0 &&
        hasComponent(world.ecs, retaliation.attackerEid, Position) &&
        !hasComponent(world.ecs, retaliation.attackerEid, DeathTimer)
      ) {
        const ax = world.stores.position.x[retaliation.attackerEid] ?? 0;
        const ay = world.stores.position.y[retaliation.attackerEid] ?? 0;
        decision = {
          x: ax,
          y: ay,
          kind: 'attacker',
          targetEid: retaliation.attackerEid,
          band,
          bypassPlayerDetection: true,
        };
      } else {
        // Follow the player — leash pulls slack mobs in but doesn't push close
        // ones off. Inside the leash, mob idles (its own position → distance 0
        // → enemyAISystem stops driving movement toward the target).
        const dx = playerX - enemyX;
        const dy = playerY - enemyY;
        const dist = Math.hypot(dx, dy);
        if (isFriendlyInLeash(dist)) {
          decision = {
            x: enemyX,
            y: enemyY,
            kind: 'idle',
            targetEid: undefined,
            band,
            bypassPlayerDetection: true,
          };
        } else {
          decision = {
            x: playerX,
            y: playerY,
            kind: 'follow',
            targetEid: playerEid,
            band,
            bypassPlayerDetection: true,
          };
        }
      }
    } else if (band === 'neutral') {
      // Ignore the player entirely; hunt rivals.
      const rival = findNearestRival(world, grid, eid, enemyX, enemyY);
      if (rival !== null) {
        decision = {
          x: rival.x,
          y: rival.y,
          kind: 'rival-primary',
          targetEid: rival.eid,
          band,
          bypassPlayerDetection: true,
        };
      } else {
        // No rival in range → idle wander (bypass detection so a hostile aggro
        // check against the player never re-engages a neutral mob).
        decision = {
          x: enemyX,
          y: enemyY,
          kind: 'idle',
          targetEid: undefined,
          band,
          bypassPlayerDetection: true,
        };
      }
    }
    // hate / hostile: primary target = player. enemyAISystem's built-in
    // FOV/room/aggro checks decide reachability. The FALLBACK — nearest rival
    // when player is unreachable — is handled inside enemyAISystem via
    // `resolveHostileFallback` because it needs live access to
    // `canDetectPlayer`. Here we only stamp the hate speed ramp below.

    // Hate-band speed ramp (FR9). Applied for ANY hate-band mob regardless of
    // whether it has a family-driven override target, because a hate mob
    // pursuing a rival still burns with rage against the player.
    let effectiveSpeed: number | undefined;
    if (band === 'hate' && baseSpeed > 0 && playerSpeed > 0) {
      const boosted = effectiveSpeedForHate(relation, baseSpeed, playerSpeed);
      if (boosted !== baseSpeed) {
        effectiveSpeed = boosted;
      }
    }

    if (decision !== null) {
      if (effectiveSpeed !== undefined) decision.effectiveSpeed = effectiveSpeed;
      decisions.set(eid, decision);
    } else if (effectiveSpeed !== undefined) {
      // Speed-only decision: no target override, just the ramp.
      decisions.set(eid, {
        x: playerX,
        y: playerY,
        kind: 'player',
        targetEid: playerEid,
        band,
        bypassPlayerDetection: false,
        effectiveSpeed,
      });
    }
  }
}

/**
 * Resolve the fallback target for a hate/hostile mob whose player detection
 * failed this frame. Called by `enemyAISystem` after it has determined the
 * player is unreachable — we look up the nearest rival via the same bounded
 * spatial hash the prepass built.
 *
 * Returns `null` when no rival is in range (mob will fall through to its
 * normal idle-wander branch).
 */
export function resolveHostileFallback(
  world: GameWorld,
  eid: number,
): { x: number; y: number; targetEid: number } | null {
  if (!hasComponent(world.ecs, eid, FamilyMembership)) return null;
  const familyId = getMobFamilyId(world, eid);
  if (familyId === undefined) return null;
  const band = bandFor(getRelation(world, familyId));
  if (band !== 'hate' && band !== 'hostile') return null;
  const grid = feudGridByWorld.get(world);
  if (grid === undefined) return null;
  const x = world.stores.position.x[eid] ?? 0;
  const y = world.stores.position.y[eid] ?? 0;
  const rival = findNearestRival(world, grid, eid, x, y);
  if (rival === null) return null;
  const decisions = decisionsByWorld.get(world);
  if (decisions !== undefined) {
    const prior = decisions.get(eid);
    decisions.set(eid, {
      x: rival.x,
      y: rival.y,
      kind: 'rival-fallback',
      targetEid: rival.eid,
      band,
      bypassPlayerDetection: true,
      effectiveSpeed: prior?.effectiveSpeed,
    });
  }
  return { x: rival.x, y: rival.y, targetEid: rival.eid };
}
