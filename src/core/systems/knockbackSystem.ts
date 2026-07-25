import { hasComponent, query, removeComponent } from 'bitecs';
import { Flying, Immovable, Knockback, Position } from '../components.js';
import { getBodyHalfWidth, getBodyHalfHeight } from '../physics-body.js';
import {
  IMMOVABLE_THRESHOLD,
  KNOCKBACK_WEIGHT_BASELINE_LB,
  KNOCKBACK_WEIGHT_SCALE_MAX,
} from '../physics-defs.js';
import { getMobAbilityKnockbackResistanceMultiplier } from '../mob-abilities/runtime.js';
import type { GameWorld } from '../world.js';

// Sample just inside an entity's footprint so exact tile-edge contact does not
// read as a wall hit because of floating-point rounding.
const COLLISION_EPSILON = 0.001;

// Knockback is resolved in fixed-size substeps so a fast slide cannot tunnel
// through a thin wall. The substep length is the spatial resolution of that
// sweep; ~1px keeps wall contact crisp. Expressed in feet (the canonical unit)
// so the substep count scales with the move distance independent of render px.
const KNOCKBACK_SUBSTEP_FT = 0.125;

function isFootprintPassable(world: GameWorld, eid: number, x: number, y: number): boolean {
  const floorMap = world.floorMap;
  if (!floorMap) {
    return true;
  }

  const halfWidth = getBodyHalfWidth(world, eid, 'knockbackSystem');
  const halfHeight = getBodyHalfHeight(world, eid, 'knockbackSystem');
  const width = halfWidth * 2;
  const height = halfHeight * 2;
  // Small bodies (≤ half a tile) already match the historic center-point rule.
  // Tighten the check only for larger sprites such as the Floor 1 boss, whose
  // footprint can overlap a wall before its center crosses into the blocked tile.
  // Zero/near-zero dimensions also fall back to the center point; knockback in
  // this codebase targets creature-sized sprites, not projectile footprints.
  const tileSizeFt = floorMap.config.tileSizeFt;
  if (
    width <= COLLISION_EPSILON * 2 ||
    height <= COLLISION_EPSILON * 2 ||
    (width <= tileSizeFt * 0.5 && height <= tileSizeFt * 0.5)
  ) {
    return floorMap.isPassableAt(x, y);
  }

  const left = x - halfWidth + COLLISION_EPSILON;
  const right = x + halfWidth - COLLISION_EPSILON;
  const top = y - halfHeight + COLLISION_EPSILON;
  const bottom = y + halfHeight - COLLISION_EPSILON;

  return (
    floorMap.isPassableAt(left, top) &&
    floorMap.isPassableAt(right, top) &&
    floorMap.isPassableAt(left, bottom) &&
    floorMap.isPassableAt(right, bottom)
  );
}

/**
 * Knockback system — smoothly displaces entities each frame, scaled by target
 * weight.
 *
 * Each frame, moves the entity by (dirX * step, dirY * step) where
 * `step = min(speed, remaining) * min(KNOCKBACK_WEIGHT_SCALE_MAX, KNOCKBACK_WEIGHT_BASELINE_LB / max(1, weight))`,
 * and decrements `remaining` by the UNSCALED base step (`min(speed, remaining)`).
 * When remaining <= 0, the Knockback component is removed. Consequences:
 *
 * - Impulse DURATION in frames is weight-invariant (depends only on writer's
 *   `speed` and `remaining`).
 * - Impulse TOTAL displacement scales with `weightScale`: a 60 lb target
 *   travels ~2× as far as a 120 lb target for the same writer-configured
 *   impulse; a 240 lb target travels ~0.5× as far. Matches spec R5.
 * - `weightScale` is capped at `KNOCKBACK_WEIGHT_SCALE_MAX` (2.5×) so an
 *   ultra-light authored mob (rat @ 6 lb → raw 20×; slime @ 20 lb → raw 6×)
 *   clamps to 2.5× instead of getting punted across the room. Cap boundary
 *   is 48 lb; targets ≥48 lb scale linearly. Design-owned via ADR 0044
 *   (Slice 2 refinement).
 *
 * Weight is baseline-identity at `KNOCKBACK_WEIGHT_BASELINE_LB` (120 lb, the
 * median mob), so writers that were tuned pre-Slice-2 against a 120 lb
 * default enemy see bit-identical displacement — no per-writer recalibration
 * needed.
 *
 * Short-circuits (immediate removeComponent without any movement):
 * - `Immovable` tag component.
 * - `weight.value[eid] >= IMMOVABLE_THRESHOLD` (walls @ 10 000 lb, statues).
 *
 * Also records `world.maxKnockbackStepThisFrame` — the max REALIZED (post-clamp)
 * displacement of any entity this frame — so `beamSystem` (which runs after this
 * system, against the pre-knockback collision grid) can inflate its broad-phase
 * radius to still find targets the grid indexed at a now-stale position. Measured
 * from the actually-written position so the bound is writer-agnostic and correct
 * even when a wall/flying-bounds clamp reduces the move.
 *
 * See ADR 0044 §Weight-as-knockback-denominator, spec `entity-physics.md` R5,
 * and `docs/knowledge/game-design/entity-sizing.md` §"Knockback baseline math".
 */
export function knockbackSystem(world: GameWorld): void {
  const entities = query(world.ecs, [Knockback, Position]);
  const { position, knockback, weight } = world.stores;
  const floorMap = world.floorMap;
  world.maxKnockbackStepThisFrame = 0;

  for (const eid of entities) {
    if (eid === undefined) continue;

    // Short-circuit: Immovable tag OR weight ≥ threshold ⇒ drop impulse
    // without moving. Order matters: check before reading speed/remaining so
    // a stale Knockback on an entity that gained Immovable mid-flight still
    // aborts cleanly.
    const targetWeight = weight.value[eid] ?? 0;
    if (hasComponent(world.ecs, eid, Immovable) || targetWeight >= IMMOVABLE_THRESHOLD) {
      removeComponent(world.ecs, eid, Knockback);
      continue;
    }

    const remaining = knockback.remaining[eid] ?? 0;
    const speed = knockback.speed[eid] ?? 0;

    if (remaining <= 0 || speed <= 0) {
      removeComponent(world.ecs, eid, Knockback);
      continue;
    }

    // Weight scale: 120 lb median = 1.0×, 60 lb = 2×, 240 lb = 0.5×.
    // Capped at KNOCKBACK_WEIGHT_SCALE_MAX (2.5×) so ultra-light authored
    // mobs (rat 6 lb → 20×, slime 20 lb → 6×) don't get punted absurd
    // distances and break game feel. Cap boundary is 48 lb — targets at or
    // above that scale linearly; targets below clamp to 2.5×. Design-owned
    // via ADR 0044 (Slice 2 refinement); authored per-mob weights are
    // intentionally left as-shipped until a later `ai-combat-balance` slice.
    //
    // max(1, ...) guards against a spawner shipping a 0 or missing weight;
    // that entity should have been caught by check:weight-coverage, but a
    // zero-weight bug here would divide-by-zero instead of just clamping.
    //
    // We scale the per-frame displacement (`step`) but decrement `remaining`
    // in *base* units (unscaled `min(speed, remaining)`). Because `remaining`
    // is written by writers as an untuned base distance, this means:
    //   - The impulse's DURATION in frames is identical for any weight.
    //   - The TOTAL displacement over the impulse life scales with weightScale:
    //     60 lb travels 2× as far total as 120 lb, 240 lb travels 0.5× as far.
    //     Sub-48 lb targets all travel exactly 2.5× (capped).
    // Matches spec R5.
    const rawWeightScale = KNOCKBACK_WEIGHT_BASELINE_LB / Math.max(1, targetWeight);
    const weightScale = Math.min(rawWeightScale, KNOCKBACK_WEIGHT_SCALE_MAX);
    const baseStep = Math.min(speed, remaining);
    const step = baseStep * weightScale * getMobAbilityKnockbackResistanceMultiplier(world, eid);
    const dirX = knockback.dirX[eid] ?? 0;
    const dirY = knockback.dirY[eid] ?? 0;
    const oldX = position.x[eid] ?? 0;
    const oldY = position.y[eid] ?? 0;
    let currentX = oldX;
    let currentY = oldY;

    if (floorMap) {
      const isFlying = hasComponent(world.ecs, eid, Flying);
      if (isFlying) {
        const newX = oldX + dirX * step;
        const newY = oldY + dirY * step;
        const inBoundsX = newX >= 0 && newX < floorMap.widthFt;
        const inBoundsY = newY >= 0 && newY < floorMap.heightFt;

        if (inBoundsX) {
          position.x[eid] = newX;
        }
        if (inBoundsY) {
          position.y[eid] = newY;
        }
      } else {
        const substepCount = Math.max(1, Math.ceil(step / KNOCKBACK_SUBSTEP_FT));
        const substep = step / substepCount;

        for (let i = 0; i < substepCount; i += 1) {
          const nextX = currentX + dirX * substep;
          const nextY = currentY + dirY * substep;

          if (isFootprintPassable(world, eid, nextX, nextY)) {
            currentX = nextX;
            currentY = nextY;
          } else if (isFootprintPassable(world, eid, nextX, currentY)) {
            currentX = nextX;
          } else if (isFootprintPassable(world, eid, currentX, nextY)) {
            currentY = nextY;
          } else {
            break;
          }
        }

        position.x[eid] = currentX;
        position.y[eid] = currentY;
      }
    } else {
      position.x[eid] = oldX + dirX * step;
      position.y[eid] = oldY + dirY * step;
    }

    // Record the max realized displacement (post-clamp) so beamSystem can bound
    // its stale-grid broad-phase radius. Reading the written position — rather
    // than `step` or the commanded (dirX,dirY)*step — makes this correct
    // regardless of the writer's dir magnitude or any wall/bounds clamp above.
    const finalX = position.x[eid] ?? oldX;
    const finalY = position.y[eid] ?? oldY;
    const realized = Math.hypot(finalX - oldX, finalY - oldY);
    if (realized > world.maxKnockbackStepThisFrame) {
      world.maxKnockbackStepThisFrame = realized;
    }

    // Decrement `remaining` by the BASE (unscaled) step so impulse duration
    // in frames is weight-invariant and total displacement scales with
    // weightScale. See docblock.
    const newRemaining = remaining - baseStep;
    knockback.remaining[eid] = newRemaining;

    if (newRemaining <= 0) {
      removeComponent(world.ecs, eid, Knockback);
    }
  }
}
