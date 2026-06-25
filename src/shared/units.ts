/**
 * Unit conventions for spatial measurements.
 *
 * Feet are the single internal spatial unit. All non-rendering layers
 * (src/core, src/game, src/shared) express positions, velocities, distances,
 * radii, and sizes in feet (decimals allowed — never rounded to integers).
 *
 * Pixels exist ONLY in the rendering layer (src/engine). The renderer scales
 * feet → pixels at draw time using PIXELS_PER_FOOT (folded into the world
 * camera zoom), so internal game logic never deals in pixels.
 */

/**
 * Render-only scale: number of screen pixels that represent one foot at the
 * base (un-zoomed) render scale. Used exclusively by src/engine to convert
 * feet → pixels when drawing. Never use this in core/game/shared logic.
 */
export const PIXELS_PER_FOOT = 8;

/**
 * Convert feet to pixels. RENDERING LAYER ONLY — use at the feet→screen
 * boundary in src/engine. Do not call from core/game/shared.
 */
export function ftToPx(feet: number): number {
  return feet * PIXELS_PER_FOOT;
}

/**
 * Convert pixels to feet. RENDERING LAYER ONLY — use when mapping screen/input
 * pixel coordinates back into feet world-space. Do not call from
 * core/game/shared.
 */
export function pxToFt(pixels: number): number {
  return pixels / PIXELS_PER_FOOT;
}

/** Format a feet distance as a string, e.g. "5'" or "4.5'". */
export function formatFeet(feet: number): string {
  const rounded = Math.round(feet * 10) / 10;
  return `${rounded}'`;
}
