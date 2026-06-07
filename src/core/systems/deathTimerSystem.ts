/**
 * Death Timer System — delays entity removal after death.
 *
 * Entities with DeathTimer have already been marked dead (HP=0, drops spawned).
 * This system counts down their timer each frame and removes them when it expires.
 * During the delay, knockback/death animations can play out visibly.
 *
 * Runs AFTER knockbackSystem so the corpse slides, and BEFORE healthSystem
 * (which skips entities that have DeathTimer).
 */
import { query, removeEntity } from 'bitecs';
import { DeathTimer } from '../components.js';
import { clearEntityStores } from '../helpers.js';
import type { GameWorld } from '../world.js';
import { GAME } from '../../shared/constants.js';

export function deathTimerSystem(world: GameWorld): void {
  const entities = query(world.ecs, [DeathTimer]);
  const { deathTimer } = world.stores;

  for (const eid of Array.from(entities)) {
    if (eid === undefined) continue;

    const remaining = (deathTimer.remainingMs[eid] ?? 0) - GAME.DELTA_MS;
    deathTimer.remainingMs[eid] = remaining;

    if (remaining <= 0) {
      clearEntityStores(world, eid);
      removeEntity(world.ecs, eid);
    }
  }
}
