import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import { floor4Manifest } from '../shared/floor-manifest.js';
import {
  buildFloor4HudState,
  type Floor4HudPhaseConfig,
  type Floor4HudState,
} from '../shared/floor4-hud.js';
import { GAME } from '../shared/constants.js';
import { PIXEL_UI, PIXEL_UI_DEPTH, createBeveledPanel, createStatBar } from './pixel-ui.js';
import { applyCrispText, type ScreenBounds } from './ui-scale.js';
import { BLUE_STEEL, MIN_TEXT_RESOLUTION, hex } from './ui-theme.js';

const PANEL_WIDTH = 520;
const PANEL_HEIGHT = 152;
const PANEL_X = GAME.WIDTH / 2 - PANEL_WIDTH / 2;
const PANEL_Y = 8;
const PIP_SIZE = 12;
const PIP_GAP = 6;
const FONT_FAMILY = '"Press Start 2P", "Courier New", monospace';

function getFloor4PhaseConfig(): Floor4HudPhaseConfig {
  const config = floor4Manifest.floor4?.phase;
  if (!config) {
    throw new Error('Missing floor4 manifest phase config');
  }
  return {
    actCount: config.actCount,
    actDurationMs: config.actDurationMs,
    waveWindowMs: config.waveWindowMs,
    overtimeCapMs: config.overtimeCapMs,
  };
}

const phaseConfig = getFloor4PhaseConfig();

export interface HudFloor4ArenaProbeState extends Floor4HudState {
  readonly bounds: {
    readonly panel: ScreenBounds;
    readonly clock: ScreenBounds;
    readonly pips: readonly ScreenBounds[];
    readonly headliner: ScreenBounds | null;
    readonly notice: ScreenBounds | null;
    readonly summary: readonly ScreenBounds[];
  } | null;
}

function textBounds(text: Phaser.GameObjects.Text, rootY: number): ScreenBounds {
  return {
    x: text.x - text.displayOriginX,
    y: rootY + text.y - text.displayOriginY,
    width: text.width,
    height: text.height,
  };
}

function rectBounds(rect: Phaser.GameObjects.Rectangle, rootY: number): ScreenBounds {
  return {
    x: rect.x,
    y: rootY + rect.y,
    width: rect.width,
    height: rect.height,
  };
}

function pipColor(state: Floor4HudState['pips'][number]['state']): number {
  switch (state) {
    case 'released':
      return 0x67e8f9;
    case 'armed':
      return PIXEL_UI.gold;
    case 'pending':
      return 0x334155;
  }
}

export function createHudFloor4Arena(
  scene: Phaser.Scene,
  options: { parent?: Phaser.GameObjects.Container } = {},
): {
  sync(world: GameWorld): void;
  setVisible(visible: boolean): void;
  getLayoutBounds(): { panel: ScreenBounds } | null;
  getState(): HudFloor4ArenaProbeState;
  destroy(): void;
} {
  const root = scene.add.container(0, PANEL_Y).setScrollFactor(0).setDepth(PIXEL_UI_DEPTH.panel);
  options.parent?.add(root);

  const panel = createBeveledPanel(scene, PANEL_X, 0, PANEL_WIDTH, PANEL_HEIGHT, {
    parent: root,
    fill: 0x20162d,
    highlight: 0x7c3aed,
    shadow: PIXEL_UI.bevelDark,
    border: PIXEL_UI.border,
    fillAlpha: 0.96,
  });

  const title = scene.add
    .text(PANEL_X + 14, 10, '', {
      fontFamily: FONT_FAMILY,
      fontSize: '10px',
      fontStyle: 'bold',
      color: '#fef3c7',
      stroke: '#02040a',
      strokeThickness: 2,
      padding: { top: 3, bottom: 3 },
    })
    .setOrigin(0, 0)
    .setDepth(PIXEL_UI_DEPTH.content);
  const clock = scene.add
    .text(PANEL_X + PANEL_WIDTH - 14, 8, '', {
      fontFamily: FONT_FAMILY,
      fontSize: '16px',
      fontStyle: 'bold',
      color: '#f8fafc',
      stroke: '#02040a',
      strokeThickness: 3,
      padding: { top: 3, bottom: 3 },
    })
    .setOrigin(1, 0)
    .setDepth(PIXEL_UI_DEPTH.content);
  const subline = scene.add
    .text(PANEL_X + 14, 32, '', {
      fontFamily: FONT_FAMILY,
      fontSize: '8px',
      color: hex(BLUE_STEEL.textSecondary),
      stroke: '#02040a',
      strokeThickness: 2,
      padding: { top: 2, bottom: 2 },
    })
    .setOrigin(0, 0)
    .setDepth(PIXEL_UI_DEPTH.content);

  const pipStartX = PANEL_X + 14;
  const pipY = 54;
  const pips = Array.from({ length: 8 }, (_, index) =>
    scene.add
      .rectangle(pipStartX + index * (PIP_SIZE + PIP_GAP), pipY, PIP_SIZE, PIP_SIZE, 0x334155)
      .setOrigin(0, 0)
      .setStrokeStyle(1, PIXEL_UI.border)
      .setDepth(PIXEL_UI_DEPTH.content),
  );

  const headlinerTitle = scene.add
    .text(PANEL_X + 14, 78, '', {
      fontFamily: FONT_FAMILY,
      fontSize: '10px',
      fontStyle: 'bold',
      color: '#fda4af',
      stroke: '#02040a',
      strokeThickness: 2,
      padding: { top: 3, bottom: 3 },
    })
    .setOrigin(0, 0)
    .setDepth(PIXEL_UI_DEPTH.content);
  const headlinerSubtitle = scene.add
    .text(PANEL_X + 14, 98, '', {
      fontFamily: FONT_FAMILY,
      fontSize: '8px',
      color: '#fecdd3',
      stroke: '#02040a',
      strokeThickness: 2,
      padding: { top: 2, bottom: 2 },
    })
    .setOrigin(0, 0)
    .setDepth(PIXEL_UI_DEPTH.content);
  const headlinerBar = createStatBar(scene, PANEL_X + 230, 86, 180, 14, {
    fill: PIXEL_UI.hpLow,
    segment: 45,
    parent: root,
  });
  const headlinerHp = scene.add
    .text(PANEL_X + 420, 82, '', {
      fontFamily: FONT_FAMILY,
      fontSize: '8px',
      color: '#f8fafc',
      stroke: '#02040a',
      strokeThickness: 2,
      padding: { top: 2, bottom: 2 },
    })
    .setOrigin(0, 0)
    .setDepth(PIXEL_UI_DEPTH.content);
  const notice = scene.add
    .text(PANEL_X + PANEL_WIDTH / 2, 122, '', {
      fontFamily: FONT_FAMILY,
      fontSize: '11px',
      fontStyle: 'bold',
      color: '#facc15',
      stroke: '#450a0a',
      strokeThickness: 3,
      padding: { top: 3, bottom: 3 },
    })
    .setOrigin(0.5, 0)
    .setDepth(PIXEL_UI_DEPTH.overlay);

  const summaryLines = Array.from({ length: 5 }, (_, index) =>
    scene.add
      .text(PANEL_X + 14, 74 + index * 14, '', {
        fontFamily: FONT_FAMILY,
        fontSize: index === 0 ? '9px' : '8px',
        fontStyle: index === 0 ? 'bold' : '',
        color: index === 0 ? '#bbf7d0' : '#d9e2ef',
        stroke: '#02040a',
        strokeThickness: 2,
        padding: { top: 2, bottom: 2 },
      })
      .setOrigin(0, 0)
      .setDepth(PIXEL_UI_DEPTH.content),
  );

  root.add([
    title,
    clock,
    subline,
    ...pips,
    headlinerTitle,
    headlinerSubtitle,
    headlinerHp,
    notice,
    ...summaryLines,
  ]);

  const detachCrispText = applyCrispText(
    scene,
    [
      title,
      clock,
      subline,
      headlinerTitle,
      headlinerSubtitle,
      headlinerHp,
      notice,
      ...summaryLines,
    ],
    MIN_TEXT_RESOLUTION,
  );

  let externallyVisible = true;
  let lastState: Floor4HudState = buildFloor4HudState({
    phaseConfig,
    playerGold: 0,
  });

  function applyVisibility(): void {
    const visible = externallyVisible && lastState.visible;
    root.setVisible(visible);
    panel.setVisible(visible);
  }

  function setVisible(visible: boolean): void {
    externallyVisible = visible;
    applyVisibility();
  }

  function sync(world: GameWorld): void {
    const arena = world.floorExtendedState?.floor4Arena;
    const activeHeadliner = arena?.activeHeadliner;
    const bossEid = activeHeadliner?.bossEid;
    const headlinerHealth =
      bossEid != null
        ? {
            current: world.stores.health.current[bossEid] ?? 0,
            max: world.stores.health.max[bossEid] ?? 0,
          }
        : undefined;
    lastState = buildFloor4HudState({
      arena,
      greenRoom: world.floorExtendedState?.floor4GreenRoom,
      phaseConfig,
      playerGold: world.playerGold,
      headlinerHealth,
    });
    applyVisibility();
    if (!lastState.visible) {
      return;
    }

    title.setText(lastState.title);
    title.setColor(lastState.winner ? '#bbf7d0' : '#fef3c7');
    clock.setText(lastState.clock);
    clock.setColor(lastState.overtime ? '#fecaca' : '#f8fafc');
    subline.setText(lastState.subline);

    for (const [index, pip] of pips.entries()) {
      const state = lastState.pips[index];
      pip.setVisible(state !== undefined);
      if (state) {
        pip.setFillStyle(pipColor(state.state), state.state === 'pending' ? 0.72 : 1);
      }
    }

    const showHeadliner = lastState.headliner !== null;
    headlinerTitle.setVisible(showHeadliner);
    headlinerSubtitle.setVisible(showHeadliner);
    headlinerHp.setVisible(showHeadliner && lastState.headliner?.hpLabel != null);
    headlinerBar.setVisible(showHeadliner && lastState.headliner?.hpPercent != null);
    if (lastState.headliner) {
      headlinerTitle.setText(lastState.headliner.title);
      headlinerSubtitle.setText(lastState.headliner.subtitle);
      headlinerHp.setText(lastState.headliner.hpLabel ?? '');
      headlinerBar.setPercent(lastState.headliner.hpPercent ?? 0);
      headlinerBar.setColor(lastState.overtime ? 0xf97316 : PIXEL_UI.hpLow);
    }

    notice.setVisible(lastState.notice !== null);
    notice.setText(lastState.notice ?? '');

    for (const [index, line] of summaryLines.entries()) {
      const value = lastState.summary[index] ?? '';
      line.setVisible(value.length > 0);
      line.setText(value);
    }
  }

  function getLayoutBounds(): { panel: ScreenBounds } | null {
    if (!root.visible || !lastState.visible) return null;
    return {
      panel: {
        x: PANEL_X,
        y: PANEL_Y,
        width: PANEL_WIDTH,
        height: PANEL_HEIGHT,
      },
    };
  }

  function getState(): HudFloor4ArenaProbeState {
    const layout = getLayoutBounds();
    if (!layout) {
      return { ...lastState, bounds: null };
    }
    return {
      ...lastState,
      bounds: {
        panel: layout.panel,
        clock: textBounds(clock, PANEL_Y),
        pips: pips.filter((pip) => pip.visible).map((pip) => rectBounds(pip, PANEL_Y)),
        headliner: headlinerTitle.visible ? textBounds(headlinerTitle, PANEL_Y) : null,
        notice: notice.visible ? textBounds(notice, PANEL_Y) : null,
        summary: summaryLines
          .filter((line) => line.visible)
          .map((line) => textBounds(line, PANEL_Y)),
      },
    };
  }

  function destroy(): void {
    detachCrispText();
    panel.destroy();
    headlinerBar.destroy();
    for (const child of [
      title,
      clock,
      subline,
      ...pips,
      headlinerTitle,
      headlinerSubtitle,
      headlinerHp,
      notice,
      ...summaryLines,
    ]) {
      child.destroy();
    }
    root.destroy();
  }

  applyVisibility();

  return {
    sync,
    setVisible,
    getLayoutBounds,
    getState,
    destroy,
  };
}
