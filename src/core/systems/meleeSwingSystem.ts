import { addComponent, entityExists, hasComponent, query, set, setComponent } from 'bitecs';
import {
  Enemy,
  Health,
  Knockback,
  MeleeSwing,
  Owner,
  Player,
  Position,
  Sprite,
  Team,
} from '../components.js';
import { applyDamage } from '../apply-damage.js';
import { readDamageMeta } from '../damage-meta.js';
import { isEntityInSafeSpace } from '../safe-space.js';
import { getWorldFloorBehavior } from '../floor-behavior.js';
import type { GameWorld } from '../world.js';
import { MeleeStyle } from '../../shared/constants.js';
import { emitWeaponHitSkillEventsForSource } from '../weapon-skill-bridge.js';
import { recordWeaponEnemyHit, pruneAttackEntity } from '../weapon-telemetry.js';
import type { CollisionResult } from './collisionSystem.js';

/** Half-width of the blade hitbox in feet. */
const BLADE_HIT_HALF_WIDTH = 1.5;

/**
 * Minimum per-frame knockback speed in feet (was a 1px/frame floor pre-feet).
 * Matches the canonical PIXELS_PER_FOOT=8 conversion (1px = 0.125ft) and the
 * KNOCKBACK_SUBSTEP_FT convention in knockbackSystem.
 */
const MIN_KNOCKBACK_SPEED_FT = 0.125;

/**
 * Broad-phase epsilon (feet) padding the query radius so floating-point boundary
 * cases can never exclude a candidate the narrow-phase would accept.
 */
const MELEE_BROAD_PHASE_EPS = 1e-3;

/**
 * Canonical iteration-order map for the melee broad-phase.
 *
 * Determinism-critical: `applyDamage` draws `world.rng` per qualifying hit, so the
 * ORDER in which targets are processed is observable (crit/dodge draws, event
 * order). The legacy full scan iterates `query([Health, Position])` in bitecs
 * dense-array order; the grid broad-phase returns candidates in cell order, so we
 * re-sort them back into that canonical order using a rank map built once per
 * system invocation.
 *
 * Generation stamping (`meleeRankGen`) lets the module-level buffers be reused
 * across worlds/frames without clearing: a rank is valid only when its stamp
 * equals the current generation. This keeps two worlds stepped in lockstep (e.g.
 * the differential regression test) fully isolated.
 */
let meleeRankGen = 0;
let meleeRankStamp = new Uint32Array(0);
let meleeRankIdx = new Int32Array(0);
const meleeCandidateScratch: number[] = [];

/**
 * Build the canonical rank map from the current [Health, Position] set and report
 * whether the grid broad-phase is safe to use this invocation.
 *
 * Returns false when any combat target lacks a Sprite: the spatial grid only
 * indexes [Position, Sprite] entities, so a spriteless target would be invisible
 * to `queryRadius` and the caller must fall back to the full scan.
 */
function buildMeleeRankMap(world: GameWorld): boolean {
  const targets = query(world.ecs, [Health, Position]);
  const capacity = world.stores.position.x.length;
  if (meleeRankStamp.length < capacity) {
    meleeRankStamp = new Uint32Array(capacity);
    meleeRankIdx = new Int32Array(capacity);
  }
  meleeRankGen = (meleeRankGen + 1) >>> 0;
  if (meleeRankGen === 0) {
    meleeRankStamp.fill(0);
    meleeRankGen = 1;
  }
  let safe = true;
  for (let i = 0; i < targets.length; i += 1) {
    const eid = targets[i]!;
    if (eid >= capacity) continue;
    meleeRankStamp[eid] = meleeRankGen;
    meleeRankIdx[eid] = i;
    if (!hasComponent(world.ecs, eid, Sprite)) {
      safe = false;
    }
  }
  return safe;
}

/** Dense-array rank of a target this invocation, or -1 if it is not a current [Health, Position] combat target. */
function meleeRankOf(eid: number): number {
  return meleeRankStamp[eid] === meleeRankGen ? meleeRankIdx[eid]! : -1;
}

function compareMeleeRank(a: number, b: number): number {
  return meleeRankOf(a) - meleeRankOf(b);
}

/**
 * Gather the [Health, Position] candidates within the swing's bounding circle,
 * ordered identically to the legacy full scan (bitecs dense-array order).
 *
 * `queryRadius` returns a REUSED internal buffer, so we copy the ranked (i.e.
 * current combat-target) candidates into module-owned scratch before
 * sorting/iterating. Non-combat grid entities (props, pickups) rank -1 and are
 * dropped — they are exactly the entities the legacy [Health, Position] query
 * never saw.
 */
function gatherMeleeCandidates(
  grid: CollisionResult['grid'],
  x: number,
  y: number,
  radius: number,
): number[] {
  const raw = grid.queryRadius(x, y, radius);
  meleeCandidateScratch.length = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const candidate = raw[i]!;
    if (meleeRankOf(candidate) !== -1) {
      meleeCandidateScratch.push(candidate);
    }
  }
  meleeCandidateScratch.sort(compareMeleeRank);
  return meleeCandidateScratch;
}

/** Distance from a point to a line segment (squared). */
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

const hitSets = new WeakMap<GameWorld, Map<number, Set<number>>>();

function getHitSet(world: GameWorld, eid: number): Set<number> {
  let worldHits = hitSets.get(world);
  if (worldHits === undefined) {
    worldHits = new Map();
    hitSets.set(world, worldHits);
  }
  let hits = worldHits.get(eid);
  if (hits === undefined) {
    hits = new Set();
    worldHits.set(eid, hits);
  }
  return hits;
}

/** Clean up hit tracking for removed melee swing entities. */
export function clearMeleeSwingHits(world: GameWorld, eid: number): void {
  const worldHits = hitSets.get(world);
  if (worldHits !== undefined) {
    worldHits.delete(eid);
  }
  pruneAttackEntity(world, eid);
}

/**
 * Register a target in every currently-active melee swing's hit set so that no
 * in-progress swing will damage it.
 *
 * This implements "a baby slime survives the swing that killed its parent":
 * when a slime dies mid-swing, dropSystem spawns babies at the parent's
 * position *after* this system already ran for the frame. On the next frame the
 * same still-active swing would otherwise find those fresh babies (absent from
 * its hit set) and cut them down in the same motion. Pre-marking them makes the
 * killing swing skip them — the player must swing again, which spawns a
 * brand-new MeleeSwing entity with an empty hit set that can hit them.
 *
 * Deterministic: pure set membership, no RNG and no wall-clock.
 */
export function markImmuneToActiveMeleeSwings(world: GameWorld, targetEid: number): void {
  const swings = query(world.ecs, [MeleeSwing]);
  for (const swingEid of swings) {
    getHitSet(world, swingEid).add(targetEid);
  }
}

/**
 * Melee swing system — handles blade line-segment collision detection.
 *
 * Each MeleeSwing entity represents a blade sweeping through an arc.
 * Supports head/shaft differentiation: head hits deal full damage,
 * shaft hits deal damage * shaftDamageMult. Knockback displaces
 * enemies away from the player on hit.
 */
export function meleeSwingSystem(world: GameWorld, collisionResult?: CollisionResult): void {
  const swings = query(world.ecs, [MeleeSwing, Position]);
  const { position, meleeSwing, team } = world.stores;
  const hitDistSq = BLADE_HIT_HALF_WIDTH * BLADE_HIT_HALF_WIDTH;
  const storeSize = position.x.length;

  // Broad-phase: reuse the spatial hash grid (built this frame by collisionSystem)
  // to avoid scanning every [Health, Position] entity per swing. Behavior-preserving:
  // a superset query + the unchanged narrow-phase + preserved legacy iteration order
  // (via the rank map) yields an identical hit set and identical applyDamage/RNG
  // order. Falls back to the full scan when no grid is supplied or a combat target
  // lacks a Sprite (see buildMeleeRankMap). Melee is grid-staleness-free: nothing
  // moves entities between the collisionSystem build and this stage.
  //
  // Built LAZILY on the first swing to reach the gather (past the safe-space gate),
  // so swing-absent frames add zero [Health, Position] scans (matching legacy).
  let gridResolved = false;
  let useGrid = collisionResult !== undefined;

  for (const eid of swings) {
    if (!entityExists(world.ecs, eid) || eid >= storeSize) continue;

    // Follow owner position
    if (hasComponent(world.ecs, eid, Owner)) {
      const ownerEid = world.stores.owner.eid[eid]!;
      if (
        ownerEid >= 0 &&
        ownerEid < storeSize &&
        entityExists(world.ecs, ownerEid) &&
        hasComponent(world.ecs, ownerEid, Position)
      ) {
        position.x[eid] = position.x[ownerEid]!;
        position.y[eid] = position.y[ownerEid]!;
      }
    }

    const px = position.x[eid]!;
    const py = position.y[eid]!;
    const bladeLength = meleeSwing.bladeLength[eid]!;
    const arcCenter = meleeSwing.arcCenterRad[eid]!;
    const arcHalf = meleeSwing.arcHalfRad[eid]!;
    const damage = meleeSwing.damage[eid]!;
    const spawnAt = meleeSwing.spawnAtMs[eid]!;
    const duration = meleeSwing.durationMs[eid]!;
    const style = meleeSwing.style[eid]!;
    const headRadius = meleeSwing.headRadius[eid]!;
    const shaftDamageMult = meleeSwing.shaftDamageMult[eid]!;
    const knockback = meleeSwing.knockback[eid]!;
    const swingTeam = hasComponent(world.ecs, eid, Team) ? team.id[eid]! : -1;
    const ownerEid = hasComponent(world.ecs, eid, Owner) ? world.stores.owner.eid[eid]! : -1;
    if (
      getWorldFloorBehavior(world).safeRoomWeaponImmunity &&
      ownerEid >= 0 &&
      hasComponent(world.ecs, ownerEid, Player) &&
      isEntityInSafeSpace(world, ownerEid)
    ) {
      continue;
    }

    const elapsed = world.elapsedMs - spawnAt;
    const progress = Math.min(1, Math.max(0, elapsed / duration));

    let tipX: number;
    let tipY: number;

    if (style === MeleeStyle.STAB) {
      const reach =
        progress <= 0.5 ? (progress / 0.5) * bladeLength : ((1 - progress) / 0.5) * bladeLength;
      tipX = px + Math.cos(arcCenter) * reach;
      tipY = py + Math.sin(arcCenter) * reach;
    } else {
      const startAngle = arcCenter + arcHalf;
      const endAngle = arcCenter - arcHalf;
      const currentAngle = startAngle + (endAngle - startAngle) * progress;
      tipX = px + Math.cos(currentAngle) * bladeLength;
      tipY = py + Math.sin(currentAngle) * bladeLength;
    }

    const hitSet = getHitSet(world, eid);
    const headRadiusSq = headRadius * headRadius;

    // Broad-phase candidates (grid) ordered to match the legacy full scan, or the
    // full [Health, Position] scan when the grid path is unavailable/unsafe. The
    // bounding radius is attacker-centered and supersets the exact hit region: the
    // blade segment (length <= bladeLength) inflated by BLADE_HIT_HALF_WIDTH, unioned
    // with the head circle (headRadius) at the tip.
    // Resolve the grid path lazily on the first swing that reaches the gather (this
    // is past the safe-space gate above). Because apply-damage never mutates the
    // [Health, Position] set, the map built here equals one built before the loop —
    // this only defers the O(N) build so swing-free frames pay nothing.
    if (useGrid && !gridResolved) {
      useGrid = buildMeleeRankMap(world);
      gridResolved = true;
    }
    const bladeReachRadius =
      bladeLength + Math.max(BLADE_HIT_HALF_WIDTH, headRadius) + MELEE_BROAD_PHASE_EPS;
    const targets =
      useGrid && collisionResult
        ? gatherMeleeCandidates(collisionResult.grid, px, py, bladeReachRadius)
        : query(world.ecs, [Health, Position]);
    for (const target of targets) {
      if (target >= storeSize || target === eid || target === ownerEid) continue;
      if (!entityExists(world.ecs, target)) continue;
      if (!hasComponent(world.ecs, target, Enemy) && !hasComponent(world.ecs, target, Player))
        continue;
      if (swingTeam >= 0 && hasComponent(world.ecs, target, Team)) {
        if (target < team.id.length && team.id[target] === swingTeam) continue;
      }
      if (hitSet.has(target)) continue;

      const tx = position.x[target]!;
      const ty = position.y[target]!;

      // Walls block melee. A swing cannot damage a target on the far side of an
      // opaque tile — whether that's the player swinging a sword through a wall
      // into the next room or an enemy striking the player through one. The tile
      // line-of-sight walk treats the attacker/target endpoint tiles as clear, so
      // legitimate adjacent and same-room hits still land; only a wall strictly
      // between the swing origin and the target suppresses the hit. Skipped when
      // there is no floor map (unit fixtures), preserving existing behavior.
      const floorMap = world.floorMap;
      if (floorMap && !floorMap.hasLineOfSight(px, py, tx, ty)) {
        continue;
      }

      // Check head hit first (circle around tip)
      let hitDamage = 0;
      if (headRadius > 0) {
        const dxHead = tx - tipX;
        const dyHead = ty - tipY;
        const headDistSq = dxHead * dxHead + dyHead * dyHead;
        if (headDistSq <= headRadiusSq) {
          hitDamage = damage;
        }
      }

      // If no head hit, check shaft hit (line segment)
      if (hitDamage === 0) {
        const segDist = pointToSegmentDistSq(tx, ty, px, py, tipX, tipY);
        if (segDist <= hitDistSq) {
          hitDamage = damage * shaftDamageMult;
        }
      }

      if (hitDamage > 0) {
        const dealt = applyDamage(world, target, hitDamage, tx, ty, {
          ...readDamageMeta(world, eid),
          sourceX: px,
          sourceY: py,
          sourceEid: ownerEid >= 0 ? ownerEid : undefined,
        });
        if (dealt > 0 && ownerEid !== -1 && hasComponent(world.ecs, target, Enemy)) {
          emitWeaponHitSkillEventsForSource(world, ownerEid, eid);
          recordWeaponEnemyHit(world, eid, target);
        }
        hitSet.add(target);

        // Apply knockback as smooth impulse via Knockback component
        if (knockback > 0) {
          const kbDx = tx - px;
          const kbDy = ty - py;
          const kbDist = Math.hypot(kbDx, kbDy);
          if (kbDist > 0.001) {
            const nx = kbDx / kbDist;
            const ny = kbDy / kbDist;
            // Spread the knockback over ~10 frames for smooth motion
            const kbSpeed = Math.max(MIN_KNOCKBACK_SPEED_FT, knockback / 10);
            if (hasComponent(world.ecs, target, Knockback)) {
              setComponent(world.ecs, target, Knockback, {
                dirX: nx,
                dirY: ny,
                remaining: knockback,
                speed: kbSpeed,
              });
            } else {
              addComponent(
                world.ecs,
                target,
                set(Knockback, {
                  dirX: nx,
                  dirY: ny,
                  remaining: knockback,
                  speed: kbSpeed,
                }),
              );
            }
          }
        }
      }
    }
  }
}
