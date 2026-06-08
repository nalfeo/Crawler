import { hasComponent } from 'bitecs';
import { Player } from './components.js';
import type { CombatEvent } from '../shared/combat-events.js';
import type { GameWorld } from './world.js';

/**
 * Single choke point for all damage application.
 * Reduces target HP and emits a CombatEvent for VFX.
 * Returns the actual damage dealt (clamped to remaining HP).
 * Skips the event when actual damage is zero (e.g. 0-damage sources).
 */
export function applyDamage(
  world: GameWorld,
  target: number,
  amount: number,
  x: number,
  y: number,
  weaponGoreFactor?: number,
  sourceX?: number,
  sourceY?: number,
): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;

  const current = world.stores.health.current[target] ?? 0;
  const dealt = Math.min(current, amount);
  world.stores.health.current[target] = current - dealt;

  if (dealt > 0) {
    const targetType: CombatEvent['targetType'] = hasComponent(world.ecs, target, Player)
      ? 'player'
      : 'enemy';
    world.combatEvents.push({
      type: 'hit',
      x,
      y,
      amount: dealt,
      targetType,
      timestamp: world.elapsedMs,
      targetEid: target,
      weaponGoreFactor,
      sourceX,
      sourceY,
    });
  }

  return dealt;
}
