import Phaser from 'phaser';
import { SHEETS } from '../sprites/index.js';
import { MainGameScene } from './MainGameScene.js';
import { createLogger } from '../../shared/logger.js';
import {
  fetchGeneratedSpriteRegistry,
  GENERATED_SPRITE_REGISTRY_KEY,
  preloadGeneratedSprites,
} from '../generatedAssets/index.js';
import { emptyGeneratedSpriteRegistry } from '../../shared/generated-assets.js';
import { preloadTerrainPacks } from '../sprites/terrain-pack-visuals.js';
import { GAME } from '../../shared/constants.js';
import { getRenderScale } from '../render-scale.js';

const logger = createLogger('engine:boot-scene');
const GENERATED_SPRITE_LOAD_TIMEOUT_MS = 15000;
const CRITICAL_SHEET_KEYS = new Set([
  'kenney-tiny-dungeon',
  'kenney-tiny-town',
  'kenney-roguelike-rpg-pack',
  'custom-pixel-sprites',
]);

// ---------------------------------------------------------------------------
// Loading screen layout constants
// ---------------------------------------------------------------------------
const LOADING_BG_COLOR = 0x080910;
const LOADING_GOLD = '#fcd34d';
const LOADING_SLATE_LIGHT = '#cbd5e1';
const LOADING_SLATE_DIM = '#64748b';
const LOADING_BAR_COLOR = 0x4ea8ff;
const LOADING_TRACK_COLOR = 0x0a0e18;
const LOADING_BORDER_COLOR = 0x02040a;
const LOADING_SHINE_COLOR = 0xffffff;

const CX = GAME.WIDTH / 2;
const TITLE_Y = 286;
const TAGLINE_Y = 324;
const BAR_W = 480;
const BAR_H = 16;
const BAR_X = CX - BAR_W / 2;
const BAR_Y = 382;
const STATUS_Y = BAR_Y + BAR_H + 14;

export class BootScene extends Phaser.Scene {
  static readonly KEY = 'BootScene';
  private startedMainGame = false;

  // Loading screen elements (alive for the duration of preload + sprite fetch)
  private loadingProgressFill?: Phaser.GameObjects.Rectangle;
  private loadingProgressShine?: Phaser.GameObjects.Rectangle;
  private loadingStatusText?: Phaser.GameObjects.Text;

  constructor() {
    super({ key: BootScene.KEY });
  }

  preload(): void {
    if (!this.load) {
      logger.warn('Phaser loader unavailable during preload');
      return;
    }

    // Set up camera so the loading screen occupies the design-space canvas.
    const renderScale = getRenderScale(this);
    this.cameras.main.setOrigin(0, 0);
    this.cameras.main.setZoom(renderScale);

    this.buildLoadingScreen();

    // Failures are non-fatal: PhaserBridge falls back to procedural
    // textures whenever a Kenney sheet fails to load.
    this.load.on('loaderror', (file: Phaser.Loader.File) => {
      logger.warn('Sprite asset failed to load; falling back to procedural texture', {
        key: file.key,
        url: file.url,
      });
    });

    // Map Phaser's built-in load progress (0→1) to the first 80% of the bar.
    // The remaining 20% is reserved for the generated-sprites async phase.
    this.load.on('progress', (value: number) => {
      this.setLoadingProgress(value * 0.8);
    });

    this.load.on('fileprogress', (file: Phaser.Loader.File) => {
      this.loadingStatusText?.setText(`Loading ${file.key}...`);
    });

    const criticalSheets = SHEETS.filter((sheet) => CRITICAL_SHEET_KEYS.has(sheet.key));
    logger.info('Preloading critical sprite sheets', {
      criticalCount: criticalSheets.length,
      deferredCount: SHEETS.length - criticalSheets.length,
    });

    for (const sheet of criticalSheets) {
      logger.debug('Queueing sprite sheet', { key: sheet.key, path: sheet.path });
      this.load.spritesheet(sheet.key, sheet.path, {
        frameWidth: sheet.frameWidth,
        frameHeight: sheet.frameHeight,
        margin: sheet.margin,
        spacing: sheet.spacing,
      });
    }

    // Queue every registered runtime terrain pack's atlas/pool/door textures.
    // Phaser auto-runs the preload() loader before create(), so these are
    // resident before MainGameScene bakes terrain — without this, a floor that
    // wires `terrainPackId` (e.g. Floor 2 → industrial-cave) silently falls
    // through the renderer's `textures.exists()` guard to the legacy path.
    preloadTerrainPacks(this.load);

    // Seed an empty registry so consumers (e.g. InventoryUI) always read
    // a non-null value even before the manifest fetch resolves.
    this.game.registry.set(GENERATED_SPRITE_REGISTRY_KEY, emptyGeneratedSpriteRegistry());
  }

  create(): void {
    // Fetch and queue generated sprites, then start the main game scene once
    // the sprites are loaded. This ensures approved custom art is available
    // before MainGameScene renders any entities.
    void this.loadGeneratedSpritesAndStartGame();
  }

  // ---------------------------------------------------------------------------
  // Loading screen builders
  // ---------------------------------------------------------------------------

  private buildLoadingScreen(): void {
    // Full-screen dark backdrop.
    this.add
      .rectangle(0, 0, GAME.WIDTH, GAME.HEIGHT, LOADING_BG_COLOR, 1)
      .setOrigin(0, 0)
      .setDepth(0);

    // Title.
    this.add
      .text(CX, TITLE_Y, 'THE CRAWLER', {
        fontFamily: 'monospace',
        fontSize: '32px',
        fontStyle: 'bold',
        color: LOADING_GOLD,
      })
      .setOrigin(0.5, 0.5)
      .setDepth(1);

    // Tagline.
    this.add
      .text(CX, TAGLINE_Y, 'Entering the dungeon...', {
        fontFamily: 'monospace',
        fontSize: '14px',
        color: LOADING_SLATE_LIGHT,
      })
      .setOrigin(0.5, 0.5)
      .setDepth(1);

    // Progress bar: 1px dark border, track, fill, shine.
    this.add
      .rectangle(BAR_X - 1, BAR_Y - 1, BAR_W + 2, BAR_H + 2, LOADING_BORDER_COLOR, 1)
      .setOrigin(0, 0)
      .setDepth(1);
    this.add
      .rectangle(BAR_X, BAR_Y, BAR_W, BAR_H, LOADING_TRACK_COLOR, 1)
      .setOrigin(0, 0)
      .setDepth(2);

    const innerH = BAR_H - 2;
    this.loadingProgressFill = this.add
      .rectangle(BAR_X + 1, BAR_Y + 1, 0, innerH, LOADING_BAR_COLOR, 1)
      .setOrigin(0, 0)
      .setDepth(3);
    this.loadingProgressShine = this.add
      .rectangle(
        BAR_X + 1,
        BAR_Y + 1,
        0,
        Math.max(1, Math.floor(innerH / 3)),
        LOADING_SHINE_COLOR,
        0.18,
      )
      .setOrigin(0, 0)
      .setDepth(4);

    // Status text below bar.
    this.loadingStatusText = this.add
      .text(CX, STATUS_Y, 'Loading assets...', {
        fontFamily: 'monospace',
        fontSize: '12px',
        color: LOADING_SLATE_DIM,
      })
      .setOrigin(0.5, 0)
      .setDepth(1);
  }

  /** Update the loading bar fill to reflect progress in [0, 1]. */
  private setLoadingProgress(progress: number): void {
    const clamped = Math.max(0, Math.min(1, progress));
    const innerW = BAR_W - 2;
    const innerH = BAR_H - 2;
    const drawn = Math.max(1, Math.round(clamped * innerW));
    this.loadingProgressFill?.setSize(drawn, innerH);
    this.loadingProgressShine?.setSize(drawn, Math.max(1, Math.floor(innerH / 3)));
  }

  // ---------------------------------------------------------------------------
  // Generated sprites async phase
  // ---------------------------------------------------------------------------

  private async loadGeneratedSpritesAndStartGame(): Promise<void> {
    // Remove the preload-phase progress listeners so they don't fight
    // with the generated-sprites load cycle below (both use load.start()).
    this.load.off('progress');
    this.load.off('fileprogress');

    try {
      this.loadingStatusText?.setText('Loading custom artwork...');
      const registry = await fetchGeneratedSpriteRegistry();
      this.game.registry.set(GENERATED_SPRITE_REGISTRY_KEY, registry);

      if (registry.size === 0 || !this.load) {
        logger.info('No generated sprites to load; starting game now');
        this.setLoadingProgress(1);
        this.startMainGame();
        return;
      }

      const queued = preloadGeneratedSprites(this.load, registry);
      if (queued.length === 0) {
        logger.info('No sprites queued; starting game now');
        this.setLoadingProgress(1);
        this.startMainGame();
        return;
      }

      logger.info('Waiting for generated sprites to load before starting main game', {
        count: queued.length,
      });

      // Wait for all generated sprite loads to complete, then start the game.
      // If the load cycle stalls, continue after a timeout so boot cannot hang.
      await new Promise<void>((resolve) => {
        let settled = false;
        let loaded = 0;
        const onFileResolved = (): void => {
          loaded += 1;
          // Map generated sprite progress to the 80%→100% range.
          this.setLoadingProgress(0.8 + 0.2 * (loaded / queued.length));
        };
        const onComplete = (): void => {
          logger.info('Generated sprites loaded; starting main game scene', {
            count: queued.length,
          });
          finalize();
        };
        const finalize = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          this.load.off(Phaser.Loader.Events.FILE_COMPLETE, onFileResolved);
          this.load.off(Phaser.Loader.Events.FILE_LOAD_ERROR, onFileResolved);
          this.load.off(Phaser.Loader.Events.COMPLETE, onComplete);
          clearTimeout(timeoutId);
          resolve();
        };

        // Count both successful and failed files so the bar advances even
        // when individual generated sprites fail to load.
        this.load.on(Phaser.Loader.Events.FILE_COMPLETE, onFileResolved);
        this.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, onFileResolved);
        this.load.on(Phaser.Loader.Events.COMPLETE, onComplete);
        const timeoutId = setTimeout(() => {
          logger.warn('Generated sprite load timed out; starting game with built-in sprites', {
            count: queued.length,
            timeoutMs: GENERATED_SPRITE_LOAD_TIMEOUT_MS,
          });
          finalize();
        }, GENERATED_SPRITE_LOAD_TIMEOUT_MS);
        this.load.start();
      });
      this.setLoadingProgress(1);
      this.startMainGame();
    } catch (err) {
      logger.warn('Generated sprite load failed; continuing with built-in sprites', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.setLoadingProgress(1);
      this.startMainGame();
    }
  }

  private startMainGame(): void {
    if (this.startedMainGame) {
      return;
    }
    this.startedMainGame = true;
    this.scene.start(MainGameScene.KEY);
  }
}
