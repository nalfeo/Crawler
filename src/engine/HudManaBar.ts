/**
 * HudManaBar — fixed-position mana (MP) bar rendered in the Phaser scene.
 *
 * Rebuilt on the shared pixel-UI builders (see engine/pixel-ui) so it reads as
 * the same "modern pixel game" chrome as HudHealthBar/HudExperienceBar rather
 * than a standalone raw-rectangle widget: a beveled panel holds a pixel mana
 * icon, an inset sky-blue stat bar with a glossy shine, and a centered
 * "current / max" readout. Only visible when the spells feature is unlocked.
 *
 * Stacked directly beneath HudHealthBar via the shared bottom-left vitals
 * layout (see HudVitalsLayout.ts). The previous `GAME.HEIGHT - 24` anchor put
 * the padded value label against and partly below the canvas edge; the shared
 * stack now reserves an explicit bottom margin and inter-panel gap.
 */
import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import {
  PIXEL_UI,
  PIXEL_UI_DEPTH,
  PIXEL_ICON,
  createBeveledPanel,
  createStatBar,
  addPixelIcon,
} from './pixel-ui.js';
import { applyCrispText } from './ui-scale.js';
import { VITALS_X, VITALS_PANEL_Y } from './HudVitalsLayout.js';

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const PAD = 7;
const ICON_SIZE = 16;
const BAR_WIDTH = 200;
const BAR_HEIGHT = 12;
const PANEL_W = PAD + ICON_SIZE + 6 + BAR_WIDTH + PAD;
/** Must match `VITALS_ROW_HEIGHTS.mana` (26) in HudVitalsLayout.ts. */
const PANEL_H = PAD + BAR_HEIGHT + PAD;

const PANEL_X = VITALS_X;
const PANEL_Y = VITALS_PANEL_Y.mana;

export interface HudManaBarOptions {
  /** Optional container to parent all created objects into (for group scaling). */
  parent?: Phaser.GameObjects.Container;
}

export function createHudManaBar(
  scene: Phaser.Scene,
  options: HudManaBarOptions = {},
): {
  sync(world: GameWorld): void;
  destroy(): void;
} {
  const parent = options.parent;

  const panel = createBeveledPanel(scene, PANEL_X, PANEL_Y, PANEL_W, PANEL_H, { parent });

  const iconCx = PANEL_X + PAD + ICON_SIZE / 2;
  const iconCy = PANEL_Y + PANEL_H / 2;
  const icon = addPixelIcon(scene, PIXEL_ICON.mana, iconCx, iconCy, {
    depth: PIXEL_UI_DEPTH.overlay,
    parent,
  });

  const innerBarX = PANEL_X + PAD + ICON_SIZE + 6;
  const innerBarY = PANEL_Y + (PANEL_H - BAR_HEIGHT) / 2;

  const bar = createStatBar(scene, innerBarX, innerBarY, BAR_WIDTH, BAR_HEIGHT, {
    fill: PIXEL_UI.mpFill,
    depth: PIXEL_UI_DEPTH.content,
    parent,
  });

  const label = scene.add
    .text(innerBarX + BAR_WIDTH / 2, innerBarY + BAR_HEIGHT / 2, '', {
      fontFamily: 'monospace',
      fontSize: '11px',
      color: '#f8fafc',
      stroke: '#02040a',
      strokeThickness: 3,
    })
    .setOrigin(0.5, 0.5)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.overlay);
  parent?.add(label);
  const detachCrispText = applyCrispText(scene, [label]);

  function setAllVisible(visible: boolean): void {
    panel.setVisible(visible);
    icon.setVisible(visible);
    bar.setVisible(visible);
    label.setVisible(visible);
  }

  // Initially hidden until feature unlock.
  setAllVisible(false);

  function sync(world: GameWorld): void {
    const isVisible = world.featureUnlocks.spells;
    if (!isVisible) {
      setAllVisible(false);
      return;
    }
    setAllVisible(true);

    const current = world.playerMp;
    const max = world.playerMaxMp;
    const pct = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;

    bar.setPercent(pct);
    label.setText(`${Math.ceil(current)} / ${Math.ceil(max)}`);
  }

  function destroy(): void {
    detachCrispText();
    panel.destroy();
    icon.destroy();
    bar.destroy();
    label.destroy();
  }

  return { sync, destroy };
}
