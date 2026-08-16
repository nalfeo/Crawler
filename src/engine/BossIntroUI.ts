/**
 * BossIntroUI — the boss-battle introduction lore sheet.
 *
 * Opened by `MainGameScene` the moment a boss encounter starts (see
 * `boss-intro-state.ts` for the trigger rules). While it is open the fixed
 * simulation step freezes — exactly like `LevelUpUI`/`RewardOpeningUI` — so the
 * player reads The Director's billing before taking a single hit.
 *
 * Presentation only: it never mutates world state. The caller owns the
 * "already introduced" bookkeeping and resumes the run from `onDismiss`.
 *
 * Input lock: a full-screen interactive backdrop swallows pointer events so
 * clicks never reach the world underneath, and `Space`/`Enter`/`Escape`
 * dismiss the sheet.
 *
 * The portrait resolves through `resolveRenderKindPortraitTexture`, i.e. the
 * SAME art precedence the live renderer uses, so the sheet can never show a
 * different sprite than the boss the player is about to fight.
 */
import Phaser from 'phaser';
import { GAME } from '../shared/constants.js';
import type { BossIntroContent } from '../shared/boss-intro.js';
import { getRenderScale } from './render-scale.js';
import { resolveRenderKindPortraitTexture } from './PhaserBridge.js';

const FONT_FAMILY = 'Segoe UI, Arial, sans-serif';

/** Sheet geometry, in the fixed GAME.WIDTH/HEIGHT design space. */
const SHEET_WIDTH = 520;
const SHEET_HEIGHT = 300;
const PORTRAIT_BOX = 132;
const DEPTH = 6100;

export interface OpenBossIntroParams {
  /** Lore-sheet content for the boss being introduced. */
  readonly content: BossIntroContent;
  /** Skip the entrance tween when the player prefers reduced motion. */
  readonly reducedMotion?: boolean;
  /** Fired exactly once per `open()`, when the sheet is dismissed. */
  readonly onDismiss: () => void;
}

export interface BossIntroUI {
  open(params: OpenBossIntroParams): void;
  isOpen(): boolean;
  /** Dismiss the sheet, firing `onDismiss`. No-op while closed. */
  dismiss(): void;
  /** Test/automation affordance: intro id currently shown, or null. */
  getIntroId(): string | null;
  destroy(): void;
}

/** `0xRRGGBB` -> `#rrggbb` for Phaser text styles. */
function cssColor(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}

export function createBossIntroUI(scene: Phaser.Scene): BossIntroUI {
  const baseResolution = getRenderScale(scene);
  const centerX = GAME.WIDTH / 2;
  const centerY = GAME.HEIGHT / 2;
  const sheetLeft = centerX - SHEET_WIDTH / 2;

  const crispText = (
    x: number,
    y: number,
    text: string,
    style: Phaser.Types.GameObjects.Text.TextStyle,
  ): Phaser.GameObjects.Text =>
    scene.add.text(Math.round(x), Math.round(y), text, style).setResolution(baseResolution);

  const container = scene.add.container(0, 0).setDepth(DEPTH).setVisible(false).setScrollFactor(0);

  const backdrop = scene.add.rectangle(centerX, centerY, GAME.WIDTH, GAME.HEIGHT, 0x04060d, 0.86);
  backdrop.setInteractive();
  container.add(backdrop);

  const sheet = scene.add.rectangle(centerX, centerY, SHEET_WIDTH, SHEET_HEIGHT, 0x11131f, 0.98);
  sheet.setStrokeStyle(2, 0xffc65c, 0.9);
  container.add(sheet);

  const portraitFrame = scene.add.rectangle(
    sheetLeft + 24 + PORTRAIT_BOX / 2,
    centerY - 12,
    PORTRAIT_BOX,
    PORTRAIT_BOX,
    0x05070f,
    0.95,
  );
  portraitFrame.setStrokeStyle(1, 0xffc65c, 0.6);
  container.add(portraitFrame);

  const portrait = scene.add.image(portraitFrame.x, portraitFrame.y, '__cw_enemy_boss');
  portrait.setVisible(false);
  container.add(portrait);

  const textLeft = sheetLeft + 24 + PORTRAIT_BOX + 20;
  const textWidth = SHEET_WIDTH - (textLeft - sheetLeft) - 24;

  const header = crispText(textLeft, centerY - SHEET_HEIGHT / 2 + 26, '', {
    fontFamily: FONT_FAMILY,
    fontSize: '12px',
    color: '#ffc65c',
  });
  header.setOrigin(0, 0);
  container.add(header);

  const name = crispText(textLeft, centerY - SHEET_HEIGHT / 2 + 44, '', {
    fontFamily: FONT_FAMILY,
    fontSize: '24px',
    fontStyle: 'bold',
    color: '#f8fafc',
    wordWrap: { width: textWidth },
  });
  name.setOrigin(0, 0);
  container.add(name);

  const subtitle = crispText(textLeft, 0, '', {
    fontFamily: FONT_FAMILY,
    fontSize: '12px',
    color: '#9ca3af',
    wordWrap: { width: textWidth },
  });
  subtitle.setOrigin(0, 0);
  container.add(subtitle);

  const rule = scene.add.rectangle(textLeft, 0, textWidth, 1, 0xffc65c, 0.55).setOrigin(0, 0.5);
  container.add(rule);

  const flavor = crispText(textLeft, 0, '', {
    fontFamily: FONT_FAMILY,
    fontSize: '12px',
    color: '#d6d9f1',
    lineSpacing: 4,
    wordWrap: { width: textWidth },
  });
  flavor.setOrigin(0, 0);
  container.add(flavor);

  const footer = crispText(centerX, centerY + SHEET_HEIGHT / 2 - 22, '', {
    fontFamily: FONT_FAMILY,
    fontSize: '12px',
    color: '#9ca3af',
  });
  footer.setOrigin(0.5, 0.5);
  container.add(footer);

  let openContent: BossIntroContent | null = null;
  let onDismissCallback: (() => void) | null = null;

  /** Fit the boss art inside the portrait frame without distorting it. */
  function layoutPortrait(content: BossIntroContent): void {
    const resolved = resolveRenderKindPortraitTexture(scene, content.renderKind);
    if (scene.textures?.exists(resolved.key) !== true) {
      portrait.setVisible(false);
      return;
    }
    if (resolved.frame === undefined) {
      portrait.setTexture(resolved.key);
    } else {
      portrait.setTexture(resolved.key, resolved.frame);
    }
    const width = portrait.width || 1;
    const height = portrait.height || 1;
    const inner = PORTRAIT_BOX - 16;
    portrait.setScale(Math.min(inner / width, inner / height));
    portrait.setVisible(true);
  }

  function render(content: BossIntroContent): void {
    sheet.setStrokeStyle(2, content.accentColor, 0.9);
    portraitFrame.setStrokeStyle(1, content.accentColor, 0.6);
    rule.setFillStyle(content.accentColor, 0.55);

    header.setText(content.title.toUpperCase()).setColor(cssColor(content.accentColor));
    name.setText(content.name);
    subtitle.setText(content.subtitle);
    subtitle.setY(Math.round(name.y + name.height + 6));
    rule.setY(Math.round(subtitle.y + subtitle.height + 10));
    flavor.setText(content.flavorLines.join('\n\n'));
    flavor.setY(Math.round(rule.y + 10));
    footer.setText('Click or press [Space] to begin the fight');

    layoutPortrait(content);
  }

  function close(): void {
    openContent = null;
    onDismissCallback = null;
    container.setVisible(false);
    scene.tweens.killTweensOf(container);
    container.setAlpha(1);
  }

  function handleDismiss(): void {
    if (!openContent) return;
    const callback = onDismissCallback;
    close();
    callback?.();
  }

  backdrop.on('pointerdown', handleDismiss);

  const keyListener = (event: KeyboardEvent): void => {
    if (!openContent) return;
    switch (event.code) {
      case 'Enter':
      case 'Space':
      case 'Escape':
        event.preventDefault();
        handleDismiss();
        break;
      default:
        break;
    }
  };
  scene.input.keyboard?.on('keydown', keyListener);

  return {
    open(params: OpenBossIntroParams): void {
      openContent = params.content;
      onDismissCallback = params.onDismiss;
      render(params.content);
      container.setVisible(true);
      if (params.reducedMotion === true) {
        container.setAlpha(1);
      } else {
        container.setAlpha(0);
        scene.tweens.add({
          targets: container,
          alpha: 1,
          duration: 180,
          ease: 'Cubic.easeOut',
        });
      }
    },
    isOpen(): boolean {
      return openContent !== null;
    },
    dismiss: handleDismiss,
    getIntroId(): string | null {
      return openContent?.introId ?? null;
    },
    destroy(): void {
      backdrop.off('pointerdown', handleDismiss);
      scene.input.keyboard?.off('keydown', keyListener);
      close();
      container.destroy(true);
    },
  };
}
