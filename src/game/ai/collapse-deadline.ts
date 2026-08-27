/**
 * Floor-collapse deadline resolution for floors whose timer lives on the floor
 * manifest instead of a Floor-1 `FloorObjectiveState`.
 *
 * Floor 1 carries its collapse deadline on `world.floorScenario.objective`
 * (`deadlineMs`, which `floorObjectiveSystem` advances while the player sits in
 * a safe room). Floor 2 sets `world.floorScenario = null` and instead collapses
 * from `floor2ObjectiveTick`, which ends the run the moment
 * `world.elapsedMs >= manifest.timer.durationMs` — a fixed wall the AI used to
 * be completely blind to.
 *
 * That blindness was a real progression bug, not a cosmetic gap: the AI's
 * collapse-panic profile fell back to the "no deadline" profile on Floor 2, so
 * the pre-exit loot sweep (which surrenders on panic/beeline) could never
 * surrender, and runs that had already killed every family boss — with the exit
 * staircase spawned and unlocked — swept loot until the floor collapsed instead
 * of descending.
 *
 * Pure and deterministic: reads world state and the static floor manifest only.
 */
import type { GameWorld } from '../../core/world.js';
import { getFloorManifest } from '../../shared/floor-registry.js';

/**
 * The collapse-relevant slice of a manifest-timer floor: when the floor ends,
 * and the exit-staircase phase the AI is in.
 */
export interface ManifestFloorCollapseState {
  /**
   * Absolute elapsed-time threshold (ms) at which the floor collapses, in the
   * same time base as `world.elapsedMs`. Unlike Floor 1's mutable
   * `objective.deadlineMs`, this floor grants no safe-room credit — the runtime
   * compares raw elapsed time against the manifest duration, so this deadline
   * is the literal wall the run dies at.
   */
  readonly deadlineMs: number;
  /**
   * True when the player may descend right now: the staircase has spawned, is
   * unlocked, and has a resolved world position. Mirrors the availability guard
   * in `autoFloor2ProgressionSystem`, so the AI's panic phase-gating matches
   * exactly when the descend would fire.
   */
  readonly staircaseUnlocked: boolean;
  /** True once the descend has been confirmed (the run is effectively over). */
  readonly staircaseDiscovered: boolean;
  /** World-space (ft) staircase position, or null before it spawns. */
  readonly staircasePos: { readonly x: number; readonly y: number } | null;
}

/**
 * Resolve the collapse state for a manifest-timer floor (currently Floor 2), or
 * `null` when the active floor does not use one.
 *
 * Returns `null` for a Floor-1-style floor (one that owns a
 * `floorScenario.objective`): those callers already resolve their own deadline,
 * which is safe-room-adjusted and clamped by the AI planning horizon, and
 * silently replacing it with a raw manifest duration would change Floor-1
 * behavior.
 */
export function resolveManifestFloorCollapseState(
  world: GameWorld,
): ManifestFloorCollapseState | null {
  if (world.floorScenario?.objective) {
    return null;
  }
  const familyState = world.floorExtendedState?.familyState;
  if (!familyState) {
    return null;
  }
  const durationMs = getFloorManifest(world.floorId)?.timer?.durationMs;
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) {
    return null;
  }
  const staircasePos = familyState.staircasePos ?? null;
  return {
    deadlineMs: durationMs,
    staircaseUnlocked:
      familyState.staircaseUnlocked === true &&
      familyState.staircaseSpawned === true &&
      staircasePos !== null,
    staircaseDiscovered: familyState.staircaseDiscovered === true,
    staircasePos,
  };
}
