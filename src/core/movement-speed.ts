/**
 * Move-speed pipeline — the single shared formula so real movement
 * (`playerInputSystem`) and AI path-planning (`bt-ai-provider`) can never
 * disagree about how fast the player currently moves.
 *
 * Order matters (per the primary-stat overhaul contract): DEX/equipment/
 * modifier bonus first, THEN status effects (haste/slow), THEN encumbrance
 * LAST — encumbrance applies after every other movement boost.
 *
 *   finalSpeed = baseSpeed * (1 + moveSpeedBonus) * statusMultiplier * encumbranceMultiplier
 */
import { hasComponent } from 'bitecs';
import { EffectiveStats } from './components.js';
import type { GameWorld } from './world.js';
import { computeEffectiveSpeed, getStatusEffects } from './status-effects.js';
import { getEntityEncumbranceMultiplier } from './encumbrance.js';

/**
 * Compute an entity's current move speed from a base speed, folding in its
 * EffectiveStats `moveSpeed` bonus (Dexterity + equipment + ability/skill
 * modifiers), active status effects (e.g. haste/slow), and encumbrance —
 * in that order.
 */
export function computeMoveSpeed(world: GameWorld, eid: number, baseSpeed: number): number {
  const moveSpeedBonus = hasComponent(world.ecs, eid, EffectiveStats)
    ? (world.stores.effectiveStats.moveSpeed[eid] ?? 0)
    : 0;
  const boostedBase = baseSpeed * (1 + moveSpeedBonus);
  const afterStatus = computeEffectiveSpeed(boostedBase, getStatusEffects(world, eid));
  return afterStatus * getEntityEncumbranceMultiplier(world, eid);
}
