/**
 * HUD Lab — Phaser-based sandbox for HudHealthBar, HudFloorTimer, and HudMinimap.
 *
 * Spins up a real Phaser.Game instance with a synthetic GameWorld so the actual
 * Phaser code paths (RenderTexture bake, Rectangle fill, tween lifecycle) run.
 * lil-gui sliders mutate the world state and call hudUi.sync() each scene update.
 */
import GUI from 'lil-gui';
import Phaser from 'phaser';
import { GAME, FLOOR } from '../../shared/constants.js';
import { createHudUI } from '../../engine/HudUI.js';
import { createGameWorld, type GameWorld } from '../../core/world.js';
import { spawnPlayer } from '../../core/index.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

interface HudLabSettings {
  hpPercent: number;
  maxHp: number;
  timeRemainingS: number;
  floor: number;
  minimapExpanded: boolean;
}

const LAB_ID = 'hud-lab';

const SCENE_KEY = 'HudLabScene';

function createHudLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const settings: HudLabSettings = {
    hpPercent: 80,
    maxHp: 100,
    timeRemainingS: 180,
    floor: 1,
    minimapExpanded: false,
  };

  const root = document.createElement('div');
  root.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
  canvasHost.append(root);

  const gameHost = document.createElement('div');
  gameHost.style.cssText = 'width:100%;height:100%;';
  root.append(gameHost);

  const hint = document.createElement('p');
  hint.textContent =
    'HUD lab: exercises the real Phaser HUD components in an isolated scene. Use lil-gui to drive state changes.';
  hint.style.cssText = 'margin-top:16px;color:#c9d4ff;line-height:1.6;';
  controls.append(hint);

  let game: Phaser.Game | undefined;
  let world: GameWorld | undefined;
  let playerEid = -1;
  let hudUi: ReturnType<typeof createHudUI> | undefined;
  let elapsedTracker = 0;

  class HudLabScene extends Phaser.Scene {
    constructor() {
      super({ key: SCENE_KEY });
    }

    create(): void {
      world = createGameWorld({ seed: 1 });
      world.floor = settings.floor;

      // Spawn a player entity so health reads are valid
      playerEid = spawnPlayer(world, GAME.WIDTH / 2, GAME.HEIGHT / 2);
      // Override default health to match lab settings
      world.stores.health.current[playerEid] = (settings.hpPercent / 100) * settings.maxHp;
      world.stores.health.max[playerEid] = settings.maxHp;

      // Fake a floor1 objective for timer display
      const deadlineMs = settings.timeRemainingS * 1000;
      world.floor1 = {
        protagonistName: 'HUD Lab Player',
        starterWeaponPool: [],
        starterChoices: [],
        selectedWeaponId: null,
        selectedChoiceIndex: null,
        baseStatBonuses: { maxHp: 0, moveSpeed: 0, pickupRange: 0 },
        enemyArchetypes: new Map(),
        guideNpcEid: null,
        shopkeeperNpcEid: null,
        questItemEid: null,
        bossDoorEids: [],
        objective: {
          requiredRats: 5,
          requiredSlimes: 3,
          requiredGold: 50,
          requiredJunk: 2,
          deadlineMs,
          staircaseSpawnCountdownMs: 30_000,
          safeRoomPos: { x: 300, y: 300 },
          staircasePos: { x: 600, y: 400 },
          welcomeOfficePos: { x: 100, y: 100 },
          shopRoomPos: { x: 500, y: 300 },
          questItemPos: { x: 700, y: 500 },
          markerRadiusPx: 32,
          questAccepted: false,
          questCompleted: false,
          ratsKilled: 0,
          slimesKilled: 0,
          goldCollected: 0,
          junkCollected: 0,
          safeRoomDiscovered: false,
          staircaseSpawnStartedMs: null,
          staircaseSpawnRemainingMs: null,
          staircaseSpawned: false,
          staircaseLocked: false,
          staircaseUnlocked: false,
          staircaseDiscovered: false,
          bossBattleStarted: false,
          staircaseBossEid: null,
          staircaseBossDefeated: false,
        },
        failReason: null,
        runSummary: null,
      };

      elapsedTracker = 0;

      // Dark background
      this.add.rectangle(0, 0, GAME.WIDTH, GAME.HEIGHT, 0x05070f).setOrigin(0, 0);

      // Centre info text
      this.add
        .text(GAME.WIDTH / 2, GAME.HEIGHT / 2, 'HUD Lab\n(no floor map — minimap inactive)', {
          fontFamily: 'monospace',
          fontSize: '18px',
          color: '#4b5563',
          align: 'center',
        })
        .setOrigin(0.5, 0.5);

      hudUi = createHudUI(this);
      if (settings.minimapExpanded) {
        hudUi.sync(world!, playerEid);
      }

      this.events.once('shutdown', () => {
        hudUi?.destroy();
        hudUi = undefined;
      });
    }

    update(_time: number, delta: number): void {
      if (!world || !hudUi) return;

      // Advance elapsed time in the direction of time-remaining
      elapsedTracker += delta;
      const maxMs = settings.timeRemainingS * 1000;
      world.elapsedMs = elapsedTracker % Math.max(maxMs, 1);
      world.floor = settings.floor;

      if (world.floor1) {
        world.floor1.objective = {
          ...world.floor1.objective,
          deadlineMs: maxMs,
        };
      }

      const current = (settings.hpPercent / 100) * settings.maxHp;
      world.stores.health.current[playerEid] = current;
      world.stores.health.max[playerEid] = settings.maxHp;

      hudUi.sync(world, playerEid);
    }
  }

  const createGame = (): void => {
    game?.destroy(true);
    const config: Phaser.Types.Core.GameConfig = {
      type: Phaser.AUTO,
      parent: gameHost,
      width: GAME.WIDTH,
      height: GAME.HEIGHT,
      backgroundColor: '#05070f',
      scene: [HudLabScene],
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
    };
    game = new Phaser.Game(config);
  };

  gui
    .add(settings, 'hpPercent', 0, 100, 1)
    .name('HP %')
    .onChange(() => {});
  gui
    .add(settings, 'maxHp', 10, 500, 10)
    .name('Max HP')
    .onChange(() => {});
  gui
    .add(settings, 'timeRemainingS', 0, FLOOR.MAX_DURATION_S, 5)
    .name('Time remaining (s)')
    .onChange(() => {});
  gui
    .add(settings, 'floor', 1, 10, 1)
    .name('Floor')
    .onChange(() => {});
  gui.add({ restart: () => createGame() }, 'restart').name('Restart scene');

  createGame();

  return () => {
    hudUi?.destroy();
    game?.destroy(true);
    hint.remove();
    root.remove();
  };
}

registerLab(LAB_ID, {
  category: 'Meta' as LabCategory,
  name: 'HUD Lab',
  description: 'Interactive Phaser sandbox for health bar, floor timer, and minimap.',
  create: createHudLab,
});
