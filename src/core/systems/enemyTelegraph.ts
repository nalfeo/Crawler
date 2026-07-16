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

/**
 * True when `candidateMs` is safe to use as-is: finite after Float32
 * rounding, non-negative, and does not silently underflow to exactly `0`.
 * Guards every telegraph-delay entry point — the per-mob override
 * (`spawnBehaviorEnemy({ telegraphMs })`, sanitized before it ever reaches
 * the Float32Array-backed `telegraphMs` store), the world-level default
 * (`world.enemyTelegraphMs`, also validated at config time by
 * `runHeadless`'s `normalizeEnemyTelegraphMs`), and `clampToFloat32SafeTelegraphMs`
 * / `getEffectiveTelegraphMs`'s fallback chain below — against three ways a
 * configured delay can silently corrupt "telegraph every hostile projectile":
 *
 * - **Overflow**: a finite JS number outside Float32's representable range
 *   (e.g. `1e39`) silently rounds to `Infinity` on assignment, and
 *   `isEnemyProjectileTelegraphReady`'s `elapsed >= delayMs` fire check then
 *   never trips — the enemy telegraphs forever and never fires. `Math.fround`
 *   performs the exact same rounding Float32Array does, so it is the correct
 *   generic overflow detector (this also catches `NaN`, since
 *   `Math.fround(NaN)` is `NaN`).
 * - **Negative**: a negative delay (e.g. `world.enemyTelegraphMs = -5`) is
 *   finite and survives `Math.fround` unchanged, but makes
 *   `isEnemyProjectileTelegraphReady` trip immediately (`elapsed >=
 *   negativeDelay` is true from frame one), i.e. an effectively-zero-delay
 *   instant fire with no visible cue window — silently violating the
 *   "every hostile projectile telegraphs" contract (regression:
 *   copilot-pull-request-reviewer finding).
 * - **Underflow**: a tiny nonzero delay (e.g. `1e-50`) is finite and
 *   non-negative, but `Math.fround` rounds it to exactly `0` — the same
 *   Float32 store value used for an intentional, legitimate "legacy: no
 *   telegraph" override. The consequence differs by entry point: a per-mob
 *   override written directly to the Float32Array-backed `telegraphMs` store
 *   (bypassing `spawnBehaviorEnemy`'s spawn-time sanitizer, see
 *   `combatants.ts`) collapses to a stored `0` before this function ever
 *   runs, so it IS silently indistinguishable from an explicit legacy
 *   override once read back. A world-level `world.enemyTelegraphMs`, by
 *   contrast, is a plain JS number preserved at full precision until this
 *   function resolves it — so an underflowing world-level value is caught
 *   right here and falls back to the constant (a real, nonzero telegraph),
 *   never silently firing immediately. Either way, the requested duration
 *   cannot be preserved as configured, so both paths reject any nonzero
 *   input that would round to `0` (regression: copilot-pull-request-reviewer
 *   finding); an explicit, already-zero input still passes.
 */
export function isFloat32SafeNonNegativeTelegraphMs(candidateMs: number): boolean {
  const rounded = Math.fround(candidateMs);
  if (!Number.isFinite(rounded) || candidateMs < 0) {
    return false;
  }
  return !(candidateMs !== 0 && rounded === 0);
}

function clampToFloat32SafeTelegraphMs(candidateMs: number): number {
  return isFloat32SafeNonNegativeTelegraphMs(candidateMs)
    ? candidateMs
    : ENEMY_PROJECTILE.TELEGRAPH_MS;
}

/** Resolves `mob.telegraphMs ?? world.enemyTelegraphMs ?? ENEMY_PROJECTILE.TELEGRAPH_MS`. */
export function getEffectiveTelegraphMs(world: GameWorld, eid: number): number {
  const perMob = world.stores.enemyBehavior.telegraphMs[eid] ?? TELEGRAPH_MS_UNSET;
  // An invalid per-mob override (Float32-overflow, Float32-underflow-to-zero,
  // non-finite, or negative) must be treated the same as "unset" and fall
  // through to the world-level default rather than short-circuiting straight to the
  // hardcoded constant — otherwise a configured `world.enemyTelegraphMs`
  // never has a chance to apply, silently breaking the documented
  // `mob ?? world ?? constant` precedence (regression:
  // copilot-pull-request-reviewer finding).
  if (isFloat32SafeNonNegativeTelegraphMs(perMob)) {
    return perMob;
  }
  return clampToFloat32SafeTelegraphMs(world.enemyTelegraphMs ?? ENEMY_PROJECTILE.TELEGRAPH_MS);
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
  // Sticky render-frame flag: stays set until `PhaserBridge.sync()` clears it
  // at the end of the rendered frame. This ensures a telegraph that starts AND
  // completes entirely within a multi-step catch-up batch (e.g. AI-runner 16×
  // playback) is still visible for one rendered frame even though
  // `telegraphActive` returned to 0 before the next sync call.
  enemyBehavior.telegraphWasActiveThisFrame[eid] = 1;
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
