import { describe, expect, it } from 'vitest';
import { GAME } from '../../src/shared/constants.js';
import {
  computeVitalsScale,
  VITALS_ABILITY_GUTTER,
  VITALS_BOTTOM_MARGIN,
  VITALS_PANEL_GUTTER,
  VITALS_PANEL_Y,
  VITALS_ROW_HEIGHTS,
} from '../../src/engine/HudVitalsLayout.js';

describe('HudUI mobile layout guards', () => {
  it('keeps the authored vitals stack separated and on-canvas', () => {
    expect(VITALS_PANEL_Y.loot - (VITALS_PANEL_Y.skill + VITALS_ROW_HEIGHTS.skill)).toBe(8);
    expect(VITALS_PANEL_Y.xp - (VITALS_PANEL_Y.loot + VITALS_ROW_HEIGHTS.loot)).toBe(
      VITALS_PANEL_GUTTER,
    );
    expect(VITALS_PANEL_Y.health - (VITALS_PANEL_Y.xp + VITALS_ROW_HEIGHTS.xp)).toBe(
      VITALS_PANEL_GUTTER,
    );
    expect(GAME.HEIGHT - (VITALS_PANEL_Y.health + VITALS_ROW_HEIGHTS.health)).toBe(
      VITALS_BOTTOM_MARGIN,
    );
  });

  it('caps the 960x540 responsive scale before the ability bar', () => {
    const clusterRightEdge = 252;
    const neighborLeftEdge = 284;
    const scale = computeVitalsScale({
      desiredScale: GAME.WIDTH / 960,
      clusterRightEdge,
      clusterTopEdge: VITALS_PANEL_Y.skill,
      neighborLeftEdge,
    });

    expect(scale).toBe(1.07);
    expect(clusterRightEdge * scale + VITALS_ABILITY_GUTTER).toBeLessThanOrEqual(neighborLeftEdge);
    expect(GAME.HEIGHT - scale * (GAME.HEIGHT - VITALS_PANEL_Y.skill)).toBeGreaterThanOrEqual(0);
  });

  it('treats a full-height vitals cluster as max-scale-safe', () => {
    // clusterTopEdge === GAME.HEIGHT would make the legacy vertical-cap divisor
    // zero; the layout should treat that as "already on-canvas" and keep the
    // requested scale instead of producing Infinity.
    expect(
      computeVitalsScale({
        desiredScale: 2,
        clusterRightEdge: 252,
        clusterTopEdge: GAME.HEIGHT,
        neighborLeftEdge: 999,
      }),
    ).toBe(2);
  });
});
