/**
 * statusEffectSystem — advances the per-entity status-effect framework each tick.
 *
 * Two application MODES (see ADR):
 * - Per-tick apply: `hpRegen` is a heal-over-time — this system mutates
 *   `health.current`. Runs BEFORE damage/`healthSystem` in the pipeline, and only
 *   heals living entities (`current > 0`), so a heal can never revive a corpse or
 *   mask a same-frame death.
 * - Read-site fold-in: `speed` is NOT mutated here; movement read-sites fold it in
 *   on demand via `computeEffectiveSpeed`.
 *
 * Timing is deterministic: a fixed `GAME.DELTA_MS` step per frame drives expiry.
 * No `Date.now()`, no `Math.random()`.
 */

import { entityExists, hasComponent } from 'bitecs';
import { GAME } from '../../shared/constants.js';
import { Health } from '../components.js';
import { computeEffectiveValue } from '../status-effects.js';
import type { GameWorld } from '../world.js';

export function statusEffectSystem(world: GameWorld): void {
  const map = world.statusEffectsByEntity;
  if (map.size === 0) return;

  const dtMs = GAME.DELTA_MS;
  const dtSeconds = dtMs / 1000;
  const { health } = world.stores;

  for (const [eid, effects] of map) {
    // Memory hygiene: drop effects orphaned by a recycled/removed entity. The
    // authoritative cleanup is clearEntityStores (entity-core.ts); this sweep is
    // a secondary safety net for entities removed without going through it.
    if (!entityExists(world.ecs, eid)) {
      map.delete(eid);
      continue;
    }

    // 1. Heal-over-time (hpRegen) — living entities only, clamped to max.
    if (hasComponent(world.ecs, eid, Health)) {
      const current = health.current[eid] ?? 0;
      if (current > 0) {
        const rate = computeEffectiveValue(0, effects, 'hpRegen');
        // Guard max > 0 explicitly: health.max is a Float32 store, so an
        // uninitialized slot reads 0 (never undefined) — a bare `?? current`
        // fallback is dead code and `Math.min(0, …)` would zero a live entity.
        const max = health.max[eid] ?? 0;
        if (rate !== 0 && max > 0) {
          // Clamp to [0, max]: hpRegen is heal-only today, but a future
          // negative-add (DoT) spec must not drive current arbitrarily negative
          // in a single tick.
          const next = current + rate * dtSeconds;
          health.current[eid] = Math.min(max, Math.max(0, next));
        }
      }
    }

    // 2. Expire timed effects; persistent effects (Infinity) never tick down.
    //
    // Epsilon guard: repeated float subtraction (e.g. 240 × 16.667ms) can leave
    // a sub-nanosecond positive residual instead of landing exactly on 0, so a
    // bare `<= 0` check misses the intended expiry frame. The 1e-9 ms threshold
    // absorbs that artifact — it is orders of magnitude below a single step
    // (~16.7ms) and therefore never triggers an early expiry in practice.
    for (let i = effects.length - 1; i >= 0; i--) {
      const effect = effects[i]!;
      if (effect.remainingMs === Infinity) continue;
      effect.remainingMs -= dtMs;
      if (effect.remainingMs <= 1e-9) effects.splice(i, 1);
    }

    // 3. Drop the map entry when the entity has no effects left.
    if (effects.length === 0) map.delete(eid);
  }
}
