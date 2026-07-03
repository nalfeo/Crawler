/**
 * familyRelationshipSystem — drains `world.factionRelationDeltas` and applies
 * each queued delta via `adjustFactionRelation` (which clamps `[0,100]` and
 * emits a `FactionRelationChangedEvent`). Introduced by Floor 2 Slice 1 (see
 * ADR 0040 and `.specify/specs/floor2-family-territories.md`).
 *
 * This system is intentionally light and always-safe to run: on Floor 1 (and
 * any other pre-Floor-2 configuration) the deltas queue is empty and the
 * function is a near-noop, so it can live in every real pipeline without
 * floor-gating.
 *
 * Determinism: reads `world.elapsedMs` only when applying passive decay; never
 * touches `Date.now()` or `Math.random()`.
 */
import type { GameWorld } from '../world.js';
import {
  adjustFactionRelation,
  DEFAULT_RELATION,
  PASSIVE_DECAY_PER_SECOND,
  clampRelation,
  type FamilyId,
} from '../faction-relations.js';

/** Options for {@link familyRelationshipSystem}. */
export interface FamilyRelationshipSystemOptions {
  /**
   * Passive-decay rate in relation points/second, applied toward
   * {@link DEFAULT_RELATION}. Resolved per-call (never captured at module
   * load) so callers and tests can inject a non-zero rate even though the
   * shipped tuning default is `0`. Defaults to {@link PASSIVE_DECAY_PER_SECOND}.
   */
  passiveDecayPerSecond?: number;
}

export function familyRelationshipSystem(
  world: GameWorld,
  options: FamilyRelationshipSystemOptions = {},
): void {
  // 1. Drain queued deltas. Copy-then-clear so a delta handler that itself
  //    enqueues more work processes on the next tick, not this one — bounded.
  const deltas = world.factionRelationDeltas;
  if (deltas.length > 0) {
    // Iterate a snapshot so re-entrancy stays bounded to next frame.
    const snapshot = deltas.slice();
    deltas.length = 0;
    for (const d of snapshot) {
      adjustFactionRelation(world, d.familyId, d.delta);
    }
  }

  // 2. Passive decay (default 0 — off unless tuning or a caller turns it on).
  //    The rate is resolved per-call from `options` (falling back to the tuning
  //    default) so it is injectable and testable; per-world decay timing lives
  //    on `world.factionRelationDecayLastMs`, not a module-level map. Only runs
  //    when Floor 2 state has seeded relations; otherwise there's nothing to
  //    drift. Uses `world.elapsedMs` for dt; never Date.now.
  const decayRate = options.passiveDecayPerSecond ?? PASSIVE_DECAY_PER_SECOND;
  if (decayRate !== 0 && world.factionRelations.size > 0) {
    const now = world.elapsedMs;
    const prev = world.factionRelationDecayLastMs ?? now;
    const dtMs = now - prev;
    world.factionRelationDecayLastMs = now;
    if (dtMs > 0) {
      const dtSec = dtMs / 1000;
      for (const [familyId, current] of world.factionRelations.entries()) {
        const target = DEFAULT_RELATION;
        const dir = current > target ? -1 : current < target ? 1 : 0;
        if (dir === 0) continue;
        const step = decayRate * dtSec * dir;
        const next = clampRelation(
          dir > 0 ? Math.min(target, current + step) : Math.max(target, current + step),
        );
        if (next !== current) {
          // Route through adjustFactionRelation so events + clamping stay uniform.
          adjustFactionRelation(world, familyId as FamilyId, next - current);
        }
      }
    }
  }
}
