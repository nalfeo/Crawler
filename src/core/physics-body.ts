/**
 * Read-side helpers for the `Size` physics body.
 *
 * Every core/game system that used to reach into `world.stores.sprite.width /
 * .height` for collision or knockback math routes through these helpers
 * instead. Sprite dims stay purely a render concern (see ADR 0044).
 *
 * The helpers return `0` (and warn once per eid) when Size is unset on an
 * entity — no sprite fallback. The shim counters guard that: they count
 * calls to any helper on a Size-less entity. Slice-1's `check:size-coverage`
 * asserts the counter stays at 0 across a real headless seed-42 run, which
 * proves every collision-grid entity spawned on Floor 1's live path carries
 * a Size. It is a live-path assertion, not a static enumeration.
 */

import type { GameWorld } from './world.js';

const shimHitEids = new Set<number>();
let shimHitCount = 0;

/**
 * Reset the shim counters. `check:size-coverage` calls this before its
 * headless run, then asserts `getShimStats().count === 0` at the end.
 */
export function resetShimStats(): void {
  shimHitCount = 0;
  shimHitEids.clear();
}

/**
 * Diagnostic counter of missing-Size occurrences since `resetShimStats()`.
 * Post-Slice-1 this must stay zero — a non-zero count means a spawner
 * regressed and stopped attaching `Size`. `check:size-coverage` gates it.
 */
export function getShimStats(): { count: number; uniqueEids: number } {
  return { count: shimHitCount, uniqueEids: shimHitEids.size };
}

function recordMissingSize(system: string, eid: number): void {
  shimHitCount += 1;
  if (shimHitEids.has(eid)) return;
  shimHitEids.add(eid);
  console.warn(
    `[physics-body] Entity ${eid} in ${system} has no Size — spawner regression. ` +
      `Attach Size at spawn time (see src/core/physics-defs.ts).`,
  );
}

/**
 * Half-width of `eid`'s body in ft.
 * - Boxes → `size.halfWidth`.
 * - Circles → `size.radius`.
 * - No Size → 0 (and a one-shot warn); this is a spawner regression.
 */
export function getBodyHalfWidth(world: GameWorld, eid: number, system = 'unknown'): number {
  const { size } = world.stores;
  const hw = size.halfWidth[eid] ?? 0;
  if (hw > 0) return hw;
  const r = size.radius[eid] ?? 0;
  if (r > 0) return r;
  recordMissingSize(system, eid);
  return 0;
}

/**
 * Half-height of `eid`'s body in ft.
 * - Boxes → `size.halfHeight`.
 * - Circles → `size.radius`.
 * - No Size → 0 (and a one-shot warn); this is a spawner regression.
 */
export function getBodyHalfHeight(world: GameWorld, eid: number, system = 'unknown'): number {
  const { size } = world.stores;
  const hh = size.halfHeight[eid] ?? 0;
  if (hh > 0) return hh;
  const r = size.radius[eid] ?? 0;
  if (r > 0) return r;
  recordMissingSize(system, eid);
  return 0;
}

/**
 * Bounding-circle radius of `eid`'s body in ft.
 *
 * For BOX bodies this returns `max(halfWidth, halfHeight)` — the legacy
 * `Math.max(spriteW, spriteH) * 0.5` semantic that `weaponSystem` and other
 * targeting-radius consumers used before Slice 1. Slice-1 parity depends on
 * this. If a future slice needs the tighter *circumscribing* (diagonal)
 * radius or a per-axis extent, it should read `size.halfWidth`/`halfHeight`
 * directly rather than change this helper.
 */
export function getBodyRadius(world: GameWorld, eid: number, system = 'unknown'): number {
  const { size } = world.stores;
  const r = size.radius[eid] ?? 0;
  if (r > 0) return r;
  const hw = size.halfWidth[eid] ?? 0;
  const hh = size.halfHeight[eid] ?? 0;
  if (hw > 0 || hh > 0) return Math.max(hw, hh);
  recordMissingSize(system, eid);
  return 0;
}

/**
 * True iff `eid` has a valid Size — radius > 0 OR (halfWidth > 0 AND
 * halfHeight > 0). Used by `check:size-coverage`.
 */
export function hasValidSize(world: GameWorld, eid: number): boolean {
  const { size } = world.stores;
  if ((size.radius[eid] ?? 0) > 0) return true;
  return (size.halfWidth[eid] ?? 0) > 0 && (size.halfHeight[eid] ?? 0) > 0;
}
