import { readFileSync } from 'node:fs';
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

  // Regression: HudLootCounter and HudSkillTracker used to hardcode their own
  // `GAME.HEIGHT - <magic offset>` Y positions instead of importing the shared
  // stack from this module, which silently drifted out of sync with the XP bar
  // and health bar (which already read VITALS_PANEL_Y) and reopened a ~28px
  // gap between the XP bar and the loot/currency pill above it.
  it('wires the loot counter and skill tracker into the shared vitals stack', () => {
    const lootSource = readFileSync('src/engine/HudLootCounter.ts', 'utf8');
    expect(lootSource).toMatch(
      /import\s+\{[^}]*\bVITALS_X\b[^}]*\}\s+from\s+'\.\/HudVitalsLayout\.js'/,
    );
    expect(lootSource).toMatch(
      /import\s+\{[^}]*\bVITALS_PANEL_Y\b[^}]*\}\s+from\s+'\.\/HudVitalsLayout\.js'/,
    );
    expect(lootSource).toMatch(/const PANEL_X = VITALS_X;/);
    expect(lootSource).toMatch(/const PANEL_Y = VITALS_PANEL_Y\.loot;/);
    expect(lootSource).not.toMatch(/GAME\.HEIGHT/);

    const skillSource = readFileSync('src/engine/HudSkillTracker.ts', 'utf8');
    expect(skillSource).toMatch(
      /import\s+\{[^}]*\bVITALS_X\b[^}]*\}\s+from\s+'\.\/HudVitalsLayout\.js'/,
    );
    expect(skillSource).toMatch(
      /import\s+\{[^}]*\bVITALS_PANEL_Y\b[^}]*\}\s+from\s+'\.\/HudVitalsLayout\.js'/,
    );
    expect(skillSource).toMatch(/const PANEL_X = VITALS_X;/);
    expect(skillSource).toMatch(/const PANEL_Y = VITALS_PANEL_Y\.skill;/);
    expect(skillSource).not.toMatch(/GAME\.HEIGHT/);
  });
});
