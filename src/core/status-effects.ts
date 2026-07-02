/**
 * Status-effect / stat-modifier framework — core runtime.
 *
 * Applies, stacks, and reads per-entity modifiers stored in the
 * `world.statusEffectsByEntity` sidecar. Pure with respect to input state apart
 * from mutating that map — no `Date.now()`, no `Math.random()`. Timing is driven
 * by the caller (`statusEffectSystem`) using the fixed-step frame clock.
 *
 * Effective-value math is a documented product-of-factors:
 *   raw = (base + Σ add.value) * Π multiply.value ; then clamp.
 * This is intentionally distinct from the character-sheet `statsSystem` `(1 + Σ)`
 * convention so multiple multiplicative slows compose and can never flip sign.
 */

import type {
  StatusEffect,
  StatusEffectSpec,
  StatusEffectStat,
  StatusEffectClamps,
} from '../shared/status-effect-types.js';
import type { GameWorld } from './world.js';

/** Shared frozen empty list so the no-effect hot path allocates nothing. */
const EMPTY_EFFECTS: readonly StatusEffect[] = Object.freeze([]);

/** Stack identity: two effects collide iff these four fields match. */
export function stackKey(spec: StatusEffectSpec): string {
  return `${spec.sourceType}:${spec.sourceId}:${spec.stat}:${spec.op}`;
}

/**
 * Validate a spec. Rejects non-finite values, negative `multiply` factors,
 * non-positive or non-finite durations (`durationMs` must be finite `> 0`, or
 * `null` for persistent), and `stack` rules without a sane positive-integer cap.
 */
export function isValidSpec(spec: StatusEffectSpec): boolean {
  if (!Number.isFinite(spec.value)) return false;
  if (spec.op === 'multiply' && spec.value < 0) return false;
  // Persistence is represented by null; a non-null duration must be finite and
  // positive (Infinity would be a persistent effect masquerading as timed).
  if (spec.durationMs !== null && !(Number.isFinite(spec.durationMs) && spec.durationMs > 0)) {
    return false;
  }
  // A stack rule needs a positive-integer cap or applyStatusEffect's cap logic
  // misbehaves (a 0/negative/NaN cap settles at a surprising steady state).
  if (
    spec.stackRule.mode === 'stack' &&
    !(Number.isInteger(spec.stackRule.maxStacks) && spec.stackRule.maxStacks >= 1)
  ) {
    return false;
  }
  return true;
}

/** Active effects for an entity (a shared frozen empty array if none). */
export function getStatusEffects(world: GameWorld, eid: number): readonly StatusEffect[] {
  return world.statusEffectsByEntity.get(eid) ?? EMPTY_EFFECTS;
}

function getOrCreateList(world: GameWorld, eid: number): StatusEffect[] {
  let list = world.statusEffectsByEntity.get(eid);
  if (!list) {
    list = [];
    world.statusEffectsByEntity.set(eid, list);
  }
  return list;
}

/**
 * Apply one spec to an entity, honouring its stack rule. Returns `false`
 * (no-op) when the spec is invalid — callers that require atomicity should
 * pre-validate with {@link isValidSpec}.
 */
export function applyStatusEffect(world: GameWorld, eid: number, spec: StatusEffectSpec): boolean {
  if (!isValidSpec(spec)) return false;

  const remainingMs = spec.durationMs === null ? Infinity : spec.durationMs;
  const effect: StatusEffect = { ...spec, remainingMs };
  const list = getOrCreateList(world, eid);
  const key = stackKey(spec);

  switch (spec.stackRule.mode) {
    case 'replace': {
      const idx = list.findIndex((e) => stackKey(e) === key);
      if (idx >= 0) list[idx] = effect;
      else list.push(effect);
      break;
    }
    case 'refresh': {
      const existing = list.find((e) => stackKey(e) === key);
      if (existing) existing.remainingMs = Math.max(existing.remainingMs, remainingMs);
      else list.push(effect);
      break;
    }
    case 'stack': {
      const matching = list.filter((e) => stackKey(e) === key).length;
      if (matching >= spec.stackRule.maxStacks) {
        // Drop the oldest matching effect (first by array insertion order).
        const oldestIdx = list.findIndex((e) => stackKey(e) === key);
        if (oldestIdx >= 0) list.splice(oldestIdx, 1);
      }
      list.push(effect);
      break;
    }
  }
  return true;
}

/**
 * Remove effects for an entity. With no predicate, clears all effects; with a
 * predicate, removes only matching effects (e.g. by `sourceId`). Deletes the map
 * entry when no effects remain.
 */
export function clearStatusEffects(
  world: GameWorld,
  eid: number,
  predicate?: (effect: StatusEffect) => boolean,
): void {
  const list = world.statusEffectsByEntity.get(eid);
  if (!list) return;
  if (!predicate) {
    world.statusEffectsByEntity.delete(eid);
    return;
  }
  const kept = list.filter((e) => !predicate(e));
  if (kept.length === 0) world.statusEffectsByEntity.delete(eid);
  else world.statusEffectsByEntity.set(eid, kept);
}

/**
 * Generic effective-value math for one stat channel:
 *   raw = (base + Σ add.value) * Π multiply.value ; clamped when `clamps` given.
 * Only effects whose `stat` matches participate. Deterministic and pure.
 */
export function computeEffectiveValue(
  base: number,
  effects: readonly StatusEffect[],
  stat: StatusEffectStat,
  clamps?: StatusEffectClamps,
): number {
  let addSum = 0;
  let multProduct = 1;
  for (const effect of effects) {
    if (effect.stat !== stat) continue;
    if (effect.op === 'add') addSum += effect.value;
    else multProduct *= effect.value;
  }
  let raw = (base + addSum) * multProduct;
  if (clamps) raw = Math.min(clamps.max, Math.max(clamps.min, raw));
  return raw;
}

/**
 * Effective movement speed with the `speed` channel folded in. Defaults to a
 * `[0, base * 3]` clamp; callers (e.g. a future Floor 2 hate-ramp) may pass
 * explicit bounds such as `{ min: baseSpeed, max: playerSpeed }`.
 */
export function computeEffectiveSpeed(
  base: number,
  effects: readonly StatusEffect[],
  clamps?: StatusEffectClamps,
): number {
  return computeEffectiveValue(base, effects, 'speed', clamps ?? { min: 0, max: base * 3 });
}
