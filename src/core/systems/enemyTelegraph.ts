/**
 * Enemy projectile telegraph — shared deterministic combat state.
 *
 * Every hostile projectile shot (including boss/rapid-fire follow-ups) must
 * enter a visible telegraph state before firing: the aim vector locks the
 * instant the telegraph begins and stays immutable through spawn, giving the
 * player a fair, readable window to dodge. This module is the single source
 * of truth for that state — `enemyAISystem` (fire logic), `PhaserBridge`
 * (render cue), and `bt-ai-provider` (AI dodge/danger reasoning) all read the
 * same `EnemyBehavior` store fields via the helpers below, so rendering and
 * AI can never diverge or see privileged state ahead of what's actually
 * committed to the world.
 *
 * Effective delay resolution order (per the approved spec):
 *   `mob.telegraphMs ?? configuredDefaultTelegraphMs`
 * where `configuredDefaultTelegraphMs` is `world.enemyTelegraphMs ??
 * ENEMY_PROJECTILE.TELEGRAPH_MS` (250ms production/headless default). A
 * value of exactly 0 (per-mob or world-level) reproduces today's legacy
 * behavior exactly: no cue, no added delay, no locked-trajectory dodge logic.
 */
import { ENEMY_PROJECTILE } from '../../shared/constants.js';
import type { GameWorld } from '../world.js';

/**
 * Sentinel meaning "no per-mob override — use the configured/world default".
 * MUST NOT be 0: the spec requires an explicit per-mob `telegraphMs: 0` to be
 * a legitimate, distinct "force legacy behavior for this one mob" override.
 * Because `clearEntityStores()` zeroes every typed-array slot on every
 * `createEntity()` call (not just recycled EIDs), this sentinel is only
 * reliable because `spawnBehaviorEnemy` re-asserts it explicitly at every
 * spawn — see src/core/spawners/combatants.ts.
 */
export const TELEGRAPH_MS_UNSET = -1;

/** Resolves `mob.telegraphMs ?? world.enemyTelegraphMs ?? ENEMY_PROJECTILE.TELEGRAPH_MS`. */
export function getEffectiveTelegraphMs(world: GameWorld, eid: number): number {
  const perMob = world.stores.enemyBehavior.telegraphMs[eid] ?? TELEGRAPH_MS_UNSET;
  if (perMob >= 0) {
    return perMob;
  }
  return world.enemyTelegraphMs ?? ENEMY_PROJECTILE.TELEGRAPH_MS;
}

/** True while `eid` is in an active telegraph (aim locked, waiting to fire). */
export function isEnemyProjectileTelegraphActive(world: GameWorld, eid: number): boolean {
  return world.stores.enemyBehavior.telegraphActive[eid] === 1;
}

/**
 * True once the active telegraph's resolved delay has elapsed. Uses the delay
 * captured at telegraph-start (`telegraphDelayMs`), not a live re-resolution,
 * so a mid-telegraph config change (lab/debug only) cannot alter an
 * already-committed telegraph's timing.
 */
export function isEnemyProjectileTelegraphReady(world: GameWorld, eid: number): boolean {
  const { enemyBehavior } = world.stores;
  if (enemyBehavior.telegraphActive[eid] !== 1) {
    return false;
  }
  const elapsed = world.elapsedMs - (enemyBehavior.telegraphStartMs[eid] ?? 0);
  return elapsed >= (enemyBehavior.telegraphDelayMs[eid] ?? 0);
}

/**
 * Begins a telegraph: locks the aim direction and firing origin (the enemy's
 * CURRENT position) for the whole telegraph window. The real fire-time spawn
 * and the AI's dodge reasoning both read these locked fields — never live
 * position/direction — so correctness holds even if the enemy is later
 * displaced by an unrelated system (separation, knockback, unstuck jiggle).
 */
export function startEnemyProjectileTelegraph(
  world: GameWorld,
  eid: number,
  dirX: number,
  dirY: number,
): void {
  const { enemyBehavior, position } = world.stores;
  enemyBehavior.telegraphActive[eid] = 1;
  enemyBehavior.telegraphStartMs[eid] = world.elapsedMs;
  enemyBehavior.telegraphDelayMs[eid] = getEffectiveTelegraphMs(world, eid);
  enemyBehavior.telegraphDirX[eid] = dirX;
  enemyBehavior.telegraphDirY[eid] = dirY;
  enemyBehavior.telegraphOriginX[eid] = position.x[eid] ?? 0;
  enemyBehavior.telegraphOriginY[eid] = position.y[eid] ?? 0;
}

/**
 * Cancels an in-progress telegraph without firing (e.g. the enemy died, lost
 * detection, or the player left attack range). Must be called from every
 * early-exit branch in the per-enemy AI loop that occurs before the fire
 * gate, so a stale telegraph can never survive into a state where its locked
 * origin/direction no longer make sense.
 */
export function cancelEnemyProjectileTelegraph(world: GameWorld, eid: number): void {
  world.stores.enemyBehavior.telegraphActive[eid] = 0;
}
