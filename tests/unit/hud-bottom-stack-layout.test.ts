import { describe, expect, it } from 'vitest';
import { GAME } from '../../src/shared/constants.js';
import { ABILITY_BAR_LAYOUT } from '../../src/engine/HudAbilityBar.js';

/**
 * The bottom-center HUD stack is: ability bar flush with the canvas bottom,
 * Talk/Descend interaction hint directly above it. Regression guard for
 * issue #3679, where the order was inverted (hint pinned to the bottom edge,
 * ability bar floating ~74px above it).
 */
describe('bottom-center HUD stack geometry', () => {
  it('anchors the ability panel to the bottom of the design canvas', () => {
    const panelBottom = ABILITY_BAR_LAYOUT.panelTop + ABILITY_BAR_LAYOUT.panelHeight;
    expect(GAME.HEIGHT - panelBottom).toBe(ABILITY_BAR_LAYOUT.panelBottomMargin);
  });

  it('keeps the slot row inside the panel', () => {
    expect(ABILITY_BAR_LAYOUT.slotRowTop).toBeGreaterThan(ABILITY_BAR_LAYOUT.panelTop);
    expect(ABILITY_BAR_LAYOUT.slotRowTop + ABILITY_BAR_LAYOUT.slotHeight).toBeLessThanOrEqual(
      ABILITY_BAR_LAYOUT.panelTop + ABILITY_BAR_LAYOUT.panelHeight,
    );
  });

  it('leaves room above the bar for the interaction hint', () => {
    // The hint is a ~56px-tall tap target (22px text + 14px padding, capped at
    // 1.25x scale => ~70px) that stacks above the bar; the bar must not eat the
    // entire lower half of the canvas.
    expect(ABILITY_BAR_LAYOUT.panelTop).toBeGreaterThan(GAME.HEIGHT / 2 + 70);
  });
});
