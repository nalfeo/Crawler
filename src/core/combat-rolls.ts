/**
 * Pure crit/dodge resolution helpers.
 *
 * These are deterministic, side-effect-free functions so combat outcomes can be
 * unit-tested without a world. The caller supplies a roll from `world.rng.next()`
 * (a float in [0, 1)); the helpers never call the RNG themselves.
 */

export interface CritResult {
  /** Final damage after applying the crit multiplier (unchanged on a non-crit). */
  amount: number;
  /** True when the roll landed a critical strike. */
  isCrit: boolean;
}

/**
 * Resolve a critical-strike roll for an outgoing hit.
 *
 * A crit lands when `roll < critChance`, scaling `amount` by `critMultiplier`.
 * `roll` is expected in [0, 1) (e.g. `world.rng.next()`).
 */
export function resolveCrit(
  roll: number,
  amount: number,
  critChance: number,
  critMultiplier: number,
): CritResult {
  if (critChance > 0 && roll < critChance) {
    const mult = critMultiplier > 0 ? critMultiplier : 1;
    return { amount: amount * mult, isCrit: true };
  }
  return { amount, isCrit: false };
}

/**
 * Resolve a dodge roll for an incoming hit. Returns true when the hit is fully
 * avoided. `roll` is expected in [0, 1) (e.g. `world.rng.next()`).
 */
export function resolveDodge(roll: number, dodgeChance: number): boolean {
  return dodgeChance > 0 && roll < dodgeChance;
}
