import Phaser from 'phaser';
import { BootScene, MainGameScene } from '../engine/index.js';
import type { MainGameSceneOptions } from '../engine/scenes/MainGameScene.js';
import { GAME } from '../shared/constants.js';

/**
 * Shared Phaser bootstrap for the main Floor 1 experience surfaces.
 *
 * Keeping the base game and the visual AI runner on the same config path means
 * UX/rendering polish added to the shipped game host is inherited by the lab
 * instead of being re-copied by hand.
 */
export function createFloor1GameConfig(
  parent: string | HTMLElement,
  sceneOptions: MainGameSceneOptions,
): Phaser.Types.Core.GameConfig {
  return {
    type: Phaser.AUTO,
    parent,
    width: GAME.WIDTH,
    height: GAME.HEIGHT,
    backgroundColor: '#111111',
    pixelArt: true,
    roundPixels: true,
    physics: {
      default: 'arcade',
      arcade: {
        gravity: { x: 0, y: 0 },
        debug: false,
      },
    },
    scene: [BootScene, new MainGameScene(sceneOptions)],
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
  };
}
