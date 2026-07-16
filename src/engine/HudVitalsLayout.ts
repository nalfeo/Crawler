/**
 * HudVitalsLayout — shared stacking geometry for the bottom-left vitals HUD
 * cluster (skill tracker → loot counter → XP bar → health bar).
 *
 * Previously every widget hand-derived its own `GAME.HEIGHT - <magic offset>`
 * position, each one silently assuming its neighbors' heights and gaps without
 * a shared source of truth.
 *
 * This module computes every panel's absolute Y bottom-up from a single
 * ordered list of row heights, a shared horizontal anchor, a fixed inter-panel
 * gutter, and a minimum clearance from the design canvas's bottom edge. Widget
 * modules import `VITALS_X` and their row's `VITALS_PANEL_Y.<row>` instead of
 * hardcoding independent offsets, so inserting/resizing a row can never
 * silently reopen a gap or overlap between neighbors.
 *
 * Engine layer only (Phaser allowed). No imports from core/game/labs.
 */
import { GAME } from '../shared/constants.js';

/** Shared left edge for every panel stacked in the bottom-left vitals cluster. */
export const VITALS_X = 16;

/** Compact lower-stack gap; the existing skill-to-loot separation remains 8px. */
export const VITALS_PANEL_GUTTER = 2;

/** Minimum design-space clearance kept between the lowest panel and the canvas bottom edge. */
export const VITALS_BOTTOM_MARGIN = 4;

/**
 * Row heights, top-to-bottom stacking order. Each value must match the
 * corresponding widget's own `PANEL_H` computation exactly (each widget file
 * documents this correspondence next to its own `PANEL_H` constant) — the two
 * are intentionally kept as separate literals (rather than one widget
 * importing another's `PANEL_H`) so a widget can't accidentally resize
 * without a deliberate, reviewed update here too.
 */
export const VITALS_ROW_HEIGHTS = {
  skill: 64,
  loot: 30,
  xp: 26,
  health: 32,
} as const;

type VitalsRow = keyof typeof VITALS_ROW_HEIGHTS;

const VITALS_ORDER: readonly VitalsRow[] = ['skill', 'loot', 'xp', 'health'];

function computeStackYs(): Record<VitalsRow, number> {
  const ys = {} as Record<VitalsRow, number>;
  let bottomEdge = GAME.HEIGHT - VITALS_BOTTOM_MARGIN;
  for (let i = VITALS_ORDER.length - 1; i >= 0; i -= 1) {
    const row = VITALS_ORDER[i]!;
    const height = VITALS_ROW_HEIGHTS[row];
    const y = bottomEdge - height;
    ys[row] = y;
    bottomEdge = y - (row === 'loot' ? 8 : VITALS_PANEL_GUTTER);
  }
  return ys;
}

/** Absolute design-space top-edge Y for each stacked panel, computed bottom-up once. */
export const VITALS_PANEL_Y: Readonly<Record<VitalsRow, number>> = computeStackYs();

export const VITALS_ABILITY_GUTTER = 12;
const VITALS_MAX_SCALE = 2;

export interface VitalsScaleInput {
  desiredScale: number;
  clusterRightEdge: number;
  clusterTopEdge: number;
  neighborLeftEdge: number;
}

function computeVerticalCap(clusterTopEdge: number): number {
  if (GAME.HEIGHT === clusterTopEdge) {
    return VITALS_MAX_SCALE;
  }
  if (GAME.HEIGHT > clusterTopEdge) {
    return GAME.HEIGHT / (GAME.HEIGHT - clusterTopEdge);
  }
  return VITALS_MAX_SCALE;
}

/**
 * Cap responsive magnification so the bottom-left cluster remains on-canvas
 * and keeps a fixed gutter from the independently anchored ability bar.
 */
export function computeVitalsScale(input: VitalsScaleInput): number {
  const neighborCap =
    input.clusterRightEdge > 0
      ? (input.neighborLeftEdge - VITALS_ABILITY_GUTTER) / input.clusterRightEdge
      : VITALS_MAX_SCALE;
  const verticalCap = computeVerticalCap(input.clusterTopEdge);
  const capped = Math.min(input.desiredScale, VITALS_MAX_SCALE, neighborCap, verticalCap);
  return Math.max(1, Math.floor(capped * 100) / 100);
}
