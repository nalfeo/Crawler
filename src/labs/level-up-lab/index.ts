/**
 * Level-Up Lab — Phaser sandbox for the level-up stat-allocation overlay
 * (`createLevelUpUI`).
 *
 * Spins up a real Phaser scene with a synthetic GameWorld + player, grants
 * unspent points, and opens the actual LevelUpUI so the real render/keyboard/
 * pointer code paths run. Confirming applies the allocation via `spendPoints`
 * and recomputes EffectiveStats via the core `statSystem`, then prints the result.
 */
import GUI from 'lil-gui';
import Phaser from 'phaser';
import { GAME } from '../../shared/constants.js';
import { addComponent } from 'bitecs';
import { SkillHolder } from '../../core/components.js';
import { createGameWorld, type GameWorld } from '../../core/world.js';
import { spawnPlayer, statSystem } from '../../core/index.js';
import { initializeBaseStats } from '../../core/systems/equipmentSystem.js';
import { createLevelUpUI } from '../../engine/LevelUpUI.js';
import { spendPoints } from '../../game/systems/statsSystem.js';
import { PRIMARY_STATS } from '../../shared/stats.js';
import { createLogger } from '../../shared/logger.js';
import { pxToFt } from '../../shared/units.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

const LAB_ID = 'level-up-lab';
const SCENE_KEY = 'LevelUpLabScene';
const logger = createLogger('labs:level-up');

interface LevelUpLabSettings {
  pointsToGrant: number;
}

function createLevelUpLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const settings: LevelUpLabSettings = { pointsToGrant: 5 };

  const root = document.createElement('div');
  root.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
  canvasHost.append(root);

  const gameHost = document.createElement('div');
  gameHost.style.cssText = 'width:100%;height:100%;';
  root.append(gameHost);

  const hint = document.createElement('p');
  hint.textContent =
    'Level-up lab: grant points, then ↑/↓ select a stat, ←/→ adjust, Enter confirm. ' +
    'Confirming calls spendPoints, then the core statSystem recomputes EffectiveStats.';
  hint.style.cssText = 'margin-top:16px;color:#c9d4ff;line-height:1.6;';
  controls.append(hint);

  let game: Phaser.Game | undefined;
  let world: GameWorld | undefined;
  let playerEid = -1;
  let levelUpUI: ReturnType<typeof createLevelUpUI> | undefined;

  const openOverlay = (): void => {
    if (!world || !levelUpUI || playerEid < 0) return;
    if (world.playerLevel.unspentPoints <= 0) {
      world.playerLevel.unspentPoints += settings.pointsToGrant;
      world.playerLevel.level += 1;
    }
    const currentStats = {} as Record<(typeof PRIMARY_STATS)[number], number>;
    for (const stat of PRIMARY_STATS) {
      currentStats[stat] = world.stores.coreStatPoints[stat][playerEid] ?? 0;
    }
    levelUpUI.open({
      level: world.playerLevel.level,
      available: world.playerLevel.unspentPoints,
      currentStats,
    });
  };

  class LevelUpLabScene extends Phaser.Scene {
    constructor() {
      super({ key: SCENE_KEY });
    }

    create(): void {
      world = createGameWorld({ seed: 1337 });
      playerEid = spawnPlayer(world, pxToFt(GAME.WIDTH) / 2, pxToFt(GAME.HEIGHT) / 2);
      initializeBaseStats(world, playerEid);
      addComponent(world.ecs, playerEid, SkillHolder);
      world.playerLevel.unspentPoints = settings.pointsToGrant;
      world.playerLevel.level = 1;
      statSystem(world);

      this.add.rectangle(0, 0, GAME.WIDTH, GAME.HEIGHT, 0x05070f).setOrigin(0, 0);
      this.add
        .text(GAME.WIDTH / 2, 40, 'Level-Up Lab', {
          fontFamily: 'monospace',
          fontSize: '18px',
          color: '#4b5563',
        })
        .setOrigin(0.5, 0.5);

      levelUpUI = createLevelUpUI(this, {
        onConfirm: (allocations) => {
          if (!world) return;
          try {
            spendPoints(world, allocations);
            statSystem(world);
            logger.info('Allocation confirmed', {
              allocations,
              unspent: world.playerLevel.unspentPoints,
            });
          } catch (error) {
            logger.warn('Allocation failed', { error });
          }
        },
      });

      openOverlay();

      this.events.once('shutdown', () => {
        levelUpUI?.destroy();
        levelUpUI = undefined;
      });
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
      scene: [LevelUpLabScene],
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
    };
    game = new Phaser.Game(config);
  };

  gui.add(settings, 'pointsToGrant', 1, 30, 1).name('Points to grant');
  gui.add({ open: () => openOverlay() }, 'open').name('Open level-up screen');
  gui.add({ restart: () => createGame() }, 'restart').name('Restart scene');

  createGame();

  return () => {
    levelUpUI?.destroy();
    game?.destroy(true);
    hint.remove();
    root.remove();
  };
}

registerLab(LAB_ID, {
  category: 'Progression' as LabCategory,
  name: 'Level-Up Lab',
  description: 'Interactive Phaser sandbox for the level-up stat-allocation overlay.',
  create: createLevelUpLab,
});
