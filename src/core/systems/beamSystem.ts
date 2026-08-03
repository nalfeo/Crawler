import { entityExists, hasComponent, query } from 'bitecs';
import { Enemy, Health, LineDamage, Owner, Player, Position, Sprite, Team } from '../components.js';
import { applyDamage } from '../apply-damage.js';
import { readDamageMeta } from '../damage-meta.js';
import { isEntityInSafeSpace } from '../safe-space.js';
import { getWorldFloorBehavior } from '../floor-behavior.js';
import type { GameWorld } from '../world.js';
import { emitWeaponHitSkillEventsForSource } from '../weapon-skill-bridge.js';
import type { CollisionResult } from './collisionSystem.js';

/** Distance from a point to a line segment. */
function pointToSegmentDistSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const abLenSq = abx * abx + aby * aby;

  if (abLenSq <= 0.0001) {
    return apx * apx + apy * apy;
  }

  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / abLenSq));
  const cx = ax + t * abx;
  const cy = ay + t * aby;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy;
}

const BEAM_HIT_HALF_WIDTH = 1;

/**
 * Broad-phase epsilon (feet) padding the query radius so floating-point boundary
 * cases — including the grid's Float32 center quantization — can never exclude a
 * candidate the narrow-phase (on live Float64 positions) would accept. 1e-3 ft
 * dominates the Float32 ULP at Floor arena scale (ulp32(C) ≈ C · 2⁻²³, so this
 * holds for |coord| up to ~8.4e3 ft; arenas are hundreds of ft).
 */
const BEAM_BROAD_PHASE_EPS = 1e-3;

/**
 * Canonical iteration-order map for the beam broad-phase (mirrors meleeSwingSystem).
 *
 * Determinism-critical: `applyDamage` draws `world.rng` per qualifying hit, so the
 * ORDER targets are processed is observable (crit/dodge draws, event order). The
 * legacy full scan iterates `query([Health, Position])` in bitecs dense-array
 * order; the grid broad-phase returns candidates in cell order, so we re-sort them
 * back into that canonical order via a rank map built once per system invocation.
 *
 * Generation stamping lets the module-level buffers be reused across worlds/frames
 * without clearing: a rank is valid only when its stamp equals the current
 * generation. This keeps two worlds stepped in lockstep (the differential
 * regression test) fully isolated. Kept beam-local (not shared with melee's
 * buffers) so the two systems can never alias mid-frame.
 */
let beamRankGen = 0;
let beamRankStamp = new Uint32Array(0);
let beamRankIdx = new Int32Array(0);
const beamCandidateScratch: number[] = [];

/**
 * Build the canonical rank map from the current [Health, Position] set and report
 * whether the grid broad-phase is safe to use this invocation.
 *
 * Returns false when any combat target lacks a Sprite: the spatial grid only
 * indexes [Position, Sprite] entities, so a spriteless target would be invisible
 * to `queryRadius` and the caller must fall back to the full scan.
 */
function buildBeamRankMap(world: GameWorld): boolean {
  const targets = query(world.ecs, [Health, Position]);
  const capacity = world.stores.position.x.length;
  if (beamRankStamp.length < capacity) {
    beamRankStamp = new Uint32Array(capacity);
    beamRankIdx = new Int32Array(capacity);
  }
  beamRankGen = (beamRankGen + 1) >>> 0;
  if (beamRankGen === 0) {
    beamRankStamp.fill(0);
    beamRankGen = 1;
  }
  let safe = true;
  for (let i = 0; i < targets.length; i += 1) {
    const eid = targets[i]!;
    if (eid >= capacity) continue;
    beamRankStamp[eid] = beamRankGen;
    beamRankIdx[eid] = i;
    if (!hasComponent(world.ecs, eid, Sprite)) {
      safe = false;
    }
  }
  return safe;
}

/** Dense-array rank of a target this invocation, or -1 if it is not a current [Health, Position] combat target. */
function beamRankOf(eid: number): number {
  return beamRankStamp[eid] === beamRankGen ? beamRankIdx[eid]! : -1;
}

function compareBeamRank(a: number, b: number): number {
  return beamRankOf(a) - beamRankOf(b);
}

/**
 * Gather the [Health, Position] candidates within the beam's bounding circle,
 * ordered identically to the legacy full scan (bitecs dense-array order).
 *
 * `queryRadius` returns a REUSED internal buffer, so we copy the ranked (i.e.
 * current combat-target) candidates into module-owned scratch before
 * sorting/iterating. Non-combat grid entities (props, pickups) rank -1 and are
 * dropped — they are exactly the entities the legacy [Health, Position] query
 * never saw.
 */
function gatherBeamCandidates(
  grid: CollisionResult['grid'],
  x: number,
  y: number,
  radius: number,
): number[] {
  const raw = grid.queryRadius(x, y, radius);
  beamCandidateScratch.length = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const candidate = raw[i]!;
    if (beamRankOf(candidate) !== -1) {
      beamCandidateScratch.push(candidate);
    }
  }
  beamCandidateScratch.sort(compareBeamRank);
  return beamCandidateScratch;
}

/** Applies line/beam damage using segment-vs-point checks. */
export function beamSystem(world: GameWorld, collisionResult?: CollisionResult): void {
  const beams = query(world.ecs, [LineDamage, Position]);
  const { position, lineDamage, team } = world.stores;

  // Lazy grid broad-phase state: resolved once, on the first beam that passes the
  // tick + safe-space gates (see the gather block below). Beam-absent / no-tick
  // frames therefore add zero [Health, Position] scans, matching legacy.
  let gridResolved = false;
  let useGrid = collisionResult !== undefined;

  for (const eid of beams) {
    if (eid === undefined || !entityExists(world.ecs, eid)) {
      continue;
    }

    const tickMs = lineDamage.tickMs[eid] ?? 0;
    const lastTickMs = lineDamage.lastTickMs[eid] ?? 0;

    if (tickMs > 0 && world.elapsedMs - lastTickMs < tickMs) {
      continue;
    }

    lineDamage.lastTickMs[eid] = world.elapsedMs;

    const ax = position.x[eid] ?? 0;
    const ay = position.y[eid] ?? 0;
    const dirX = lineDamage.dirX[eid] ?? 1;
    const dirY = lineDamage.dirY[eid] ?? 0;
    const length = lineDamage.length[eid] ?? 0;
    const damage = lineDamage.damage[eid] ?? 0;
    const beamTeam = hasComponent(world.ecs, eid, Team) ? (team.id[eid] ?? 0) : -1;
    const ownerEid = hasComponent(world.ecs, eid, Owner) ? (world.stores.owner.eid[eid] ?? 0) : -1;
    if (
      getWorldFloorBehavior(world).safeRoomWeaponImmunity &&
      ownerEid >= 0 &&
      hasComponent(world.ecs, ownerEid, Player) &&
      isEntityInSafeSpace(world, ownerEid)
    ) {
      continue;
    }

    const bx = ax + dirX * length;
    const by = ay + dirY * length;
    const hitDistSq = BEAM_HIT_HALF_WIDTH * BEAM_HIT_HALF_WIDTH;

    // Broad-phase: reuse the spatial-hash grid (built this frame by collisionSystem)
    // instead of scanning every [Health, Position] entity per beam. Behavior-
    // preserving: a superset radius query + the unchanged narrow-phase + preserved
    // legacy iteration order (via the rank map) yields an identical hit set and
    // identical applyDamage/RNG order. Built LAZILY on the first beam to reach this
    // point (past the tick + safe-space gates), so beam-absent/no-tick frames add
    // zero scans. Falls back to the full scan when no grid is supplied or a combat
    // target lacks a Sprite (see buildBeamRankMap).
    if (useGrid && !gridResolved) {
      useGrid = buildBeamRankMap(world);
      gridResolved = true;
    }

    // Bounding circle centered at the beam midpoint. R supersets the exact hit
    // region: half the segment length (L/2) + the hit half-width (w) + the max
    // realized knockback displacement this frame (k — the grid is stale by up to
    // this much because beamSystem runs after knockbackSystem) + an epsilon
    // covering the grid's Float32 center quantization. Segment length is computed
    // from the endpoints (dir may not be unit-length).
    const midX = (ax + bx) * 0.5;
    const midY = (ay + by) * 0.5;
    const halfLen = Math.hypot(bx - ax, by - ay) * 0.5;
    const beamReachRadius =
      halfLen + BEAM_HIT_HALF_WIDTH + world.maxKnockbackStepThisFrame + BEAM_BROAD_PHASE_EPS;
    const targets =
      useGrid && collisionResult
        ? gatherBeamCandidates(collisionResult.grid, midX, midY, beamReachRadius)
        : query(world.ecs, [Health, Position]);

    for (const target of targets) {
      if (
        target === undefined ||
        target === eid ||
        target === ownerEid ||
        !entityExists(world.ecs, target)
      ) {
        continue;
      }

      if (!hasComponent(world.ecs, target, Enemy) && !hasComponent(world.ecs, target, Player)) {
        continue;
      }

      if (beamTeam >= 0 && hasComponent(world.ecs, target, Team)) {
        if ((team.id[target] ?? 0) === beamTeam) {
          continue;
        }
      }

      const tx = position.x[target] ?? 0;
      const ty = position.y[target] ?? 0;
      const distSq = pointToSegmentDistSq(tx, ty, ax, ay, bx, by);

      if (distSq <= hitDistSq) {
        const dealt = applyDamage(
          world,
          target,
          damage,
          position.x[target] ?? 0,
          position.y[target] ?? 0,
          {
            ...readDamageMeta(world, eid),
            sourceX: ax,
            sourceY: ay,
            sourceEid: ownerEid >= 0 ? ownerEid : undefined,
          },
        );
        if (dealt > 0 && ownerEid !== -1 && hasComponent(world.ecs, target, Enemy)) {
          emitWeaponHitSkillEventsForSource(world, ownerEid, eid);
        }
      }
    }
  }
}
