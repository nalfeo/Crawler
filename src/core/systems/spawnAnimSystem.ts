/**
 * Spawn Animation System — drives the spawn-in "pop out + wiggle" beat.
 *
 * Entities with SpawnAnim are emerging into the world (e.g. baby slimes from a
 * slime split). This system counts the timer down each frame and, when it
 * expires, strips SpawnAnim so the entity renders at its normal resting scale.
 *
 * Purely cosmetic: it drives the render-side pop/wiggle and never touches
 * combat. Baby slimes survive their parent's killing swing via swing-immunity
 * (see markImmuneToActiveMeleeSwings), not via this timer.
 *
 * Deterministic: no RNG, no wall-clock — advances by the fixed GAME.DELTA_MS.
 * Mirrors the deathTimerSystem countdown pattern.
 */
import { query, removeComponent } from 'bitecs';
import { SpawnAnim } from '../components.js';
import type { GameWorld } from '../world.js';
import { GAME } from '../../shared/constants.js';

export function spawnAnimSystem(world: GameWorld): void {
  const entities = query(world.ecs, [SpawnAnim]);
  const { spawnAnim } = world.stores;

  for (const eid of Array.from(entities)) {
    if (eid === undefined) continue;

    const remaining = (spawnAnim.remainingMs[eid] ?? 0) - GAME.DELTA_MS;
    spawnAnim.remainingMs[eid] = remaining;

    if (remaining <= 0) {
      removeComponent(world.ecs, eid, SpawnAnim);
    }
  }
}
