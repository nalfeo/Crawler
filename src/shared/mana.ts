/**
 * Mana (MP) resource model — Wisdom-scaled max pool + frame-based regen.
 *
 * Kept in `shared/` (no Phaser/DOM, no ECS) so the constants and the pure
 * derivation are usable by the core `manaSystem`, the HUD mana bar, labs, and
 * unit tests alike without dragging in the ECS world.
 *
 * Tuning intent: a fresh Floor 1 player has effective Wisdom 1 (base 1, no
 * allocation), which must map to the historical hardcoded 100 MP pool — so
 * `MANA_BASE + MANA_PER_WISDOM × 1 === 100`. Each further point of effective
 * Wisdom then adds `MANA_PER_WISDOM` Max MP.
 */
import { GAME } from './constants.js';

/** Flat mana every character has before any Wisdom scaling. */
export const MANA_BASE = 80;

/** Max MP granted per point of effective Wisdom. Effective Wisdom 1 → 100 MP. */
export const MANA_PER_WISDOM = 20;

/** Mana regenerated per second of game time (fixed-timestep, deterministic). */
export const MANA_REGEN_PER_SECOND = 5;

/**
 * Mana regenerated per fixed-timestep frame. Derived from `GAME.DELTA_MS` so it
 * tracks the same deterministic clock every other timed system uses — never
 * `Date.now`. At 60 fps this is 5 / 60 ≈ 0.0833 MP/frame.
 */
export const MANA_REGEN_PER_FRAME = (MANA_REGEN_PER_SECOND * GAME.DELTA_MS) / 1000;

/**
 * Derive a character's maximum MP from its EFFECTIVE Wisdom. Pure: the same
 * input always yields the same output. Non-finite or negative wisdom is floored
 * to 0 so the pool never drops below `MANA_BASE`.
 */
export function deriveMaxMp(effectiveWisdom: number): number {
  const wisdom = Number.isFinite(effectiveWisdom) ? Math.max(0, effectiveWisdom) : 0;
  return MANA_BASE + MANA_PER_WISDOM * wisdom;
}
