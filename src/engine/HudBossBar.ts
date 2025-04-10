/**
 * HudBossBar — screen-space boss health bar for Floor 1 boss fights.
 *
 * Anchored top-center directly beneath the floor-timer panel so the two HUD
 * elements never overlap. It is parented into the same scaled `topCenter` HUD
 * group as the floor timer (see HudUI), so the vertical gap below the timer
 * holds at every UI scale. Hidden unless a boss battle is active.
 */
import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import { GAME } from '../shared/constants.js';
import { PIXEL_UI, PIXEL_UI_DEPTH, createBeveledPanel, createStatBar } from './pixel-ui.js';
import { resolveBossHealthBar } from './boss-health-bar-state.js';
import { applyCrispText, type ScreenBounds } from './ui-scale.js';
import {
  BOSS_PANEL_HEIGHT,
  ENCOUNTER_PANEL_WIDTH,
  ENCOUNTER_FIRST_ROW_Y,
  ellipsizeEncounterLabel,
} from './hud-encounter-layout.js';

const CENTER_X = GAME.WIDTH / 2;
const PANEL_WIDTH = ENCOUNTER_PANEL_WIDTH;
const PANEL_X = CENTER_X - PANEL_WIDTH / 2;
const BAR_X = PANEL_X + 10;
const BAR_Y = 34;
const BAR_WIDTH = PANEL_WIDTH - 20;
const BAR_HEIGHT = 16;
const MAX_NAME_CHARACTERS = 48;

export function createHudBossBar(
  scene: Phaser.Scene,
  options: { parent?: Phaser.GameObjects.Container } = {},
): {
  sync(world: GameWorld): void;
  setTop(top: number): void;
  getLayoutBounds(): { panel: ScreenBounds; text: ScreenBounds } | null;
  destroy(): void;
} {
  const parent = options.parent;
  const wrapper = scene.add
    .container(0, ENCOUNTER_FIRST_ROW_Y)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.panel);
  parent?.add(wrapper);

  const panel = createBeveledPanel(scene, PANEL_X, 0, PANEL_WIDTH, BOSS_PANEL_HEIGHT, {
    parent: wrapper,
  });

  const bar = createStatBar(scene, BAR_X, BAR_Y, BAR_WIDTH, BAR_HEIGHT, {
    fill: PIXEL_UI.hpHigh,
    segment: 40,
    parent: wrapper,
  });

  const label = scene.add
    .text(PANEL_X + 10, 17, 'BOSS', {
      fontFamily: 'monospace',
      fontSize: '12px',
      fontStyle: 'bold',
      color: '#fde68a',
    })
    .setOrigin(0, 0.5)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.overlay)
    .setVisible(false);
  wrapper.add(label);

  const nameText = scene.add
    .text(PANEL_X + 58, 17, '', {
      fontFamily: 'monospace',
      fontSize: '13px',
      color: '#f8fafc',
    })
    .setOrigin(0, 0.5)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.overlay)
    .setVisible(false);
  wrapper.add(nameText);

  const hpText = scene.add
    .text(PANEL_X + PANEL_WIDTH - 10, 17, '', {
      fontFamily: 'monospace',
      fontSize: '12px',
      color: '#cbd5e1',
    })
    .setOrigin(1, 0.5)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.overlay)
    .setVisible(false);
  wrapper.add(hpText);
  const detachCrispText = applyCrispText(scene, [label, nameText, hpText]);

  function sync(world: GameWorld): void {
    const state = resolveBossHealthBar(
      world.floorScenario?.objective.bossBattles ??
        world.floorExtendedState?.familyState?.bossEncounters,
      world.ecs,
      world.stores.health,
    );
    const visible = state !== null;
    panel.setVisible(visible);
    bar.setVisible(visible);
    label.setVisible(visible);
    nameText.setVisible(visible);
    hpText.setVisible(visible);
    if (!state) {
      return;
    }

    bar.setPercent(state.pct);
    bar.setColor(state.fillColor);
    nameText.setText(ellipsizeEncounterLabel(state.displayName, MAX_NAME_CHARACTERS));
    hpText.setText(`${Math.ceil(state.current)} / ${Math.ceil(state.max)}`);
  }

  function destroy(): void {
    detachCrispText();
    panel.destroy();
    bar.destroy();
    label.destroy();
    nameText.destroy();
    hpText.destroy();
    wrapper.destroy();
  }

  function getLayoutBounds(): { panel: ScreenBounds; text: ScreenBounds } | null {
    if (!label.visible) return null;
    const textLeft = Math.min(label.x, nameText.x, hpText.x - hpText.width);
    const textRight = Math.max(label.x + label.width, nameText.x + nameText.width, hpText.x);
    const textTop =
      wrapper.y +
      Math.min(
        label.y - label.height / 2,
        nameText.y - nameText.height / 2,
        hpText.y - hpText.height / 2,
      );
    const textBottom =
      wrapper.y +
      Math.max(
        label.y + label.height / 2,
        nameText.y + nameText.height / 2,
        hpText.y + hpText.height / 2,
      );
    return {
      panel: {
        x: PANEL_X,
        y: wrapper.y,
        width: PANEL_WIDTH,
        height: BOSS_PANEL_HEIGHT,
      },
      text: {
        x: textLeft,
        y: textTop,
        width: textRight - textLeft,
        height: textBottom - textTop,
      },
    };
  }

  return {
    sync,
    setTop: (top: number) => wrapper.setY(top),
    getLayoutBounds,
    destroy,
  };
}
