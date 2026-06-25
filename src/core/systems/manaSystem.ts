/**
 * Mana System — per-frame MP pool maintenance for the player singleton.
 *
 * Completes the Wisdom half of the core-stat payoff: derives `playerMaxMp` from
 * the player's EFFECTIVE Wisdom (`deriveMaxMp`), regenerates `playerMp` a fixed
 * amount per fixed-timestep frame, and clamps current MP into `[0, max]`.
 *
 * Pure, deterministic `(world) => void`: no `Date.now`, no RNG. Regen is derived
 * from `GAME.DELTA_MS` (via `MANA_REGEN_PER_FRAME`) like every other timed
 * system, so headless and visual runs stay reproducible.
 *
 * Gated on a `Player` entity that also carries `EffectiveStats` (the Floor 1
 * player set up by `initializeBaseStats`). Bare test/lab worlds without that
 * singleton are a no-op, so they keep the world's default 100/100 MP untouched.
 *
 * Ordering: run AFTER `statSystem` so the effective Wisdom it reads already
 * folds in this frame's level-up allocation and equipment.
 */

import { query } from 'bitecs';
import { Player, EffectiveStats } from '../components.js';
import type { GameWorld } from '../world.js';
import { deriveMaxMp, MANA_REGEN_PER_FRAME } from '../../shared/mana.js';

/**
 * Recompute the player's max MP from effective Wisdom, apply one frame of MP
 * regen, and clamp. Safe to call every frame — idempotent given fixed inputs.
 */
export function manaSystem(world: GameWorld): void {
  const player = query(world.ecs, [Player, EffectiveStats])[0];
  if (player === undefined) {
    return;
  }

  const effectiveWisdom = world.stores.effectiveStats.wisdom[player] ?? 0;
  world.playerMaxMp = deriveMaxMp(effectiveWisdom);

  const regenerated = world.playerMp + MANA_REGEN_PER_FRAME;
  world.playerMp = Math.max(0, Math.min(world.playerMaxMp, regenerated));
}
