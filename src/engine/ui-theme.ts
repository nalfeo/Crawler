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
 * Minimum crisp-text resolution (supersample) for small HUD text.
 *
 * Equipment and inventory labels stay readable at their intentionally compact
 * sizes when panels are rendered through Phaser's canvas text pipeline.
 */
export const MIN_TEXT_RESOLUTION = 6;

/** Legibility-first face shared by the equipment and inventory surfaces. */
export const UI_FONT_FAMILY = '"Arial", "Segoe UI", sans-serif';

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
