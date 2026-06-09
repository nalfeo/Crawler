/**
 * Unit conversion utilities for spatial measurements.
 *
 * All authored design values (WeaponDef fields, tuning.json distances, system
 * constants) are expressed in feet. ECS stores and physics math use pixels.
 * Call ftToPx() at every design→ECS boundary.
 */

/** Number of pixels that represent one foot in game space. */
export const PIXELS_PER_FOOT = 8;

/** Convert feet to pixels. Use at design→ECS boundaries. */
export function ftToPx(feet: number): number {
  return feet * PIXELS_PER_FOOT;
}

/** Convert pixels to feet. Use for UI display. */
export function pxToFt(pixels: number): number {
  return pixels / PIXELS_PER_FOOT;
}

/** Format a pixel distance as a feet string, e.g. "5'" or "4.5'". */
export function formatFeet(pixels: number): string {
  const feet = pxToFt(pixels);
  return `${feet}'`;
}
