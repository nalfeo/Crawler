/**
 * Pure state helper for the HUD ability bar's cast-flash highlight.
 *
 * The flash decision is factored out of `HudAbilityBar` (which imports Phaser
 * and cannot run in the unit-test environment) so the flash window is
 * deterministically unit-testable without a Phaser scene — mirroring the
 * `boss-health-bar-state` split. `HudAbilityBar.sync()` calls
 * `isAbilitySlotCastFlashing()` every frame and, when it returns `true`, paints
 * the slot with the cool cast-flash palette (near-white fill + cyan border).
 */

/**
 * Number of frames a slot stays visibly flashed after its ability fires. Sized
 * generously so a 60 fps user still perceives the flash even if their eyes
 * happened to be elsewhere at trigger time.
 */
export const CAST_FLASH_FRAMES = 15;

/**
 * Whether an ability slot should render its cast-flash highlight this frame.
 *
 * The slot flashes for `CAST_FLASH_FRAMES` frames starting on the frame the
 * ability last triggered (`lastTriggerFrame`, sourced from
 * `abilityState.cooldownByAbilityId`). Returns `false` when the ability has
 * never triggered, and guards against a rewound clock (a trigger frame in the
 * future never flashes).
 */
export function isAbilitySlotCastFlashing(
  frameCount: number,
  lastTriggerFrame: number | undefined,
): boolean {
  if (lastTriggerFrame === undefined) return false;
  const framesSinceTrigger = frameCount - lastTriggerFrame;
  return framesSinceTrigger >= 0 && framesSinceTrigger < CAST_FLASH_FRAMES;
}
