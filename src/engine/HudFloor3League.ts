import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import { GAME } from '../shared/constants.js';
import { buildFloor3LeagueViewModel, type Floor3LeagueViewModel } from '../shared/floor3-ux.js';
import { resolveFloor3LeagueView } from './floor3-league-state.js';
import { createBeveledPanel, PIXEL_UI, PIXEL_UI_DEPTH } from './pixel-ui.js';
import { applyCrispText, type ScreenBounds } from './ui-scale.js';

const WIDTH = 420;
const HEIGHT = 76;
const X = GAME.WIDTH / 2 - WIDTH / 2;
/**
 * Floor 3 keeps the shared floor timer visible (unlike Floor 4, whose scenario
 * sets `hideFloorTimer`), so this panel starts below the timer panel's
 * `TOP_Y (12) + PANEL_HEIGHT (42) = 54` bottom edge instead of overlapping it.
 */
const Y = 58;
const FONT = '"Press Start 2P", "Courier New", monospace';

export interface HudFloor3LeagueState extends Floor3LeagueViewModel {
  readonly bounds: ScreenBounds | null;
  readonly bracket: readonly ('cleared' | 'active' | 'pending')[];
}

export function createHudFloor3League(
  scene: Phaser.Scene,
  options: { parent?: Phaser.GameObjects.Container } = {},
): {
  sync(world: GameWorld): void;
  setVisible(visible: boolean): void;
  getState(): HudFloor3LeagueState;
  getLayoutBounds(): { panel: ScreenBounds } | null;
  destroy(): void;
} {
  const root = scene.add.container(0, Y).setScrollFactor(0).setDepth(PIXEL_UI_DEPTH.panel);
  options.parent?.add(root);
  const panel = createBeveledPanel(scene, X, 0, WIDTH, HEIGHT, {
    parent: root,
    fill: 0x181329,
    highlight: 0xa855f7,
    shadow: PIXEL_UI.bevelDark,
    border: PIXEL_UI.border,
    fillAlpha: 0.96,
  });
  const headline = scene.add
    .text(X + 12, 10, '', {
      fontFamily: FONT,
      fontSize: '10px',
      fontStyle: 'bold',
      color: '#fef3c7',
      stroke: '#02040a',
      strokeThickness: 2,
    })
    .setOrigin(0, 0)
    .setDepth(PIXEL_UI_DEPTH.content);
  const detail = scene.add
    .text(X + 12, 32, '', {
      fontFamily: FONT,
      fontSize: '8px',
      color: '#d8b4fe',
      stroke: '#02040a',
      strokeThickness: 2,
    })
    .setOrigin(0, 0)
    .setDepth(PIXEL_UI_DEPTH.content);
  const pips = Array.from({ length: 4 }, (_, index) =>
    scene.add
      .rectangle(X + 12 + index * 30, 56, 20, 8, 0x334155)
      .setOrigin(0, 0)
      .setStrokeStyle(1, PIXEL_UI.border)
      .setDepth(PIXEL_UI_DEPTH.content),
  );
  const bracketLabel = scene.add
    .text(X + 142, 51, 'FINAL FOUR', {
      fontFamily: FONT,
      fontSize: '7px',
      color: '#94a3b8',
      stroke: '#02040a',
      strokeThickness: 2,
    })
    .setOrigin(0, 0)
    .setDepth(PIXEL_UI_DEPTH.content);
  root.add([headline, detail, ...pips, bracketLabel]);
  const detachText = applyCrispText(scene, [headline, detail, bracketLabel]);
  let externallyVisible = true;
  let state = buildFloor3LeagueViewModel({
    floorId: null,
    worldState: 'playing',
    victory: false,
    studiosDefeated: 0,
    studios: [],
    finalFourUnlocked: false,
    finalFourRoundIndex: 0,
    rounds: [],
  });

  function bracket(): readonly ('cleared' | 'active' | 'pending')[] {
    return state.rounds.map((round, index) =>
      round.defeated ? 'cleared' : index === state.activeRoundIndex ? 'active' : 'pending',
    );
  }
  function applyVisibility(): void {
    const visible = externallyVisible && state.visible;
    root.setVisible(visible);
    panel.setVisible(visible);
  }
  function sync(world: GameWorld): void {
    state = resolveFloor3LeagueView(world);
    headline.setText(state.headline);
    detail.setText(state.detail);
    bracket().forEach((pipState, index) => {
      pips[index]?.setFillStyle(
        pipState === 'cleared' ? 0x4ade80 : pipState === 'active' ? 0xfacc15 : 0x334155,
      );
    });
    applyVisibility();
  }
  return {
    sync,
    setVisible: (visible) => {
      externallyVisible = visible;
      applyVisibility();
    },
    getState: () => ({
      ...state,
      bounds:
        externallyVisible && state.visible ? { x: X, y: Y, width: WIDTH, height: HEIGHT } : null,
      bracket: bracket(),
    }),
    getLayoutBounds: () =>
      externallyVisible && state.visible
        ? { panel: { x: X, y: Y, width: WIDTH, height: HEIGHT } }
        : null,
    destroy: () => {
      detachText();
      panel.destroy();
      root.destroy();
    },
  };
}
