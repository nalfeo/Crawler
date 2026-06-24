/**
 * Render depth constants shared between the Phaser scene and world-space VFX.
 *
 * `MainGameScene.refreshCameraMasks()` partitions every display object onto either
 * the world camera or the screen-space UI camera using a single depth threshold:
 * objects with `depth >= UI_DEPTH_CUTOFF` are treated as UI (pinned to the screen,
 * ignored by the world camera); everything below renders in world space and
 * scrolls/zooms with the world camera.
 *
 * Any world-space VFX (gore splatter, floating combat text, AI debug path overlay)
 * MUST therefore use a depth strictly below `UI_DEPTH_CUTOFF`, or it gets pinned to
 * the screen and renders at the wrong world position. `WORLD_VFX_DEPTH` centralises
 * those values so the dependency is explicit and lives in one place that both
 * `src/engine` and `src/labs` can legally import.
 */

/**
 * Depth at/above which a display object is treated as screen-space UI by
 * `MainGameScene.refreshCameraMasks()`. Keep world-space content strictly below.
 */
export const UI_DEPTH_CUTOFF = 900;

/**
 * Depths for world-space VFX layers. All values are well below `UI_DEPTH_CUTOFF`
 * so `refreshCameraMasks()` keeps them on the world camera. Relative ordering
 * controls which VFX draws on top (gore < combat text < debug path).
 */
export const WORLD_VFX_DEPTH = {
  /** Persistent blood/ichor pools left on the ground after an enemy dies. */
  bloodPool: 5,
  /** Blood/gore splatter particles. */
  gore: 10,
  /** Floating damage numbers / MISS / BLOCKED text. */
  combatText: 20,
  /** AI debug path overlay (labs only). */
  debugPath: 50,
} as const;
