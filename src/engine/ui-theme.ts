/**
 * Shared blue-steel UI theme for engine HUD panels (EquipmentUI, InventoryUI,
 * ...).
 *
 * Extracted so the common design-language tokens and text helpers live in one
 * place: the palette is re-tuned as a unit, and keeping a single source of
 * truth stops the two panels from drifting apart the next time it changes.
 * Panel-specific tokens (tabs, cells, stat colours, ...) are layered on top of
 * {@link BLUE_STEEL} in each panel module.
 */

/**
 * Minimum crisp-text resolution (supersample) for pixel-font HUD text.
 *
 * Small pixel fonts need a higher supersample than the shared HUD default
 * (MAX_TEXT_RESOLUTION = 4) or the tiny labels blur. Panels must apply this
 * floor consistently across construction AND relayout — otherwise every resize
 * silently drops text from 6 back to 4, which reads as blurry labels.
 */
export const MIN_TEXT_RESOLUTION = 6;

/** Convert a 0xRRGGBB colour number to a Phaser "#rrggbb" CSS colour string. */
export function hex(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`;
}

/**
 * Base blue-steel palette shared by every HUD panel. Panel modules spread this
 * and add their own tokens, e.g. `const COLORS = { ...BLUE_STEEL, tabBg: ... }`.
 */
export const BLUE_STEEL = {
  panelBg: 0x2f3f61,
  panelBorder: 0x3f5f93,
  textPrimary: 0xd9e2ef,
  textSecondary: 0xaebdd5,
  sectionHeader: 0x355180,
  accent: 0xc2d0e6,
} as const;
