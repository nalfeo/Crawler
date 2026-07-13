import Phaser from 'phaser';
import { BootScene, MainGameScene } from '../engine/index.js';
import type { MainGameSceneOptions } from '../engine/scenes/MainGameScene.js';
import { resolveBootRenderScale } from '../engine/render-scale.js';
import { GAME } from '../shared/constants.js';

/**
 * Shared Phaser bootstrap for floor experience surfaces.
 *
 * Keeping the base game and the visual AI runner on the same config path means
 * UX/rendering polish added to the shipped game host is inherited by the lab
 * instead of being re-copied by hand.
 *
 * The canvas is sized `GAME.WIDTH/HEIGHT × renderScale` so the whole game renders
 * into a HiDPI supersampled framebuffer (crisp text + pixel art on high-density
 * displays). The 1280×720 design space is preserved for all gameplay, layout and
 * input via camera zoom — see src/engine/render-scale.ts. On a 1× display shown
 * at the design size `renderScale === 1`, so this is a no-op there.
 * @param floorId - The floor identifier (e.g., "floor1")
 */
export function createFloorGameConfig(
  parent: string | HTMLElement,
  sceneOptions: MainGameSceneOptions,
  _floorId: string = 'floor1',
): Phaser.Types.Core.GameConfig {
  const renderScale = resolveBootRenderScale(parent);
  return {
    type: Phaser.AUTO,
    parent,
    width: GAME.WIDTH * renderScale,
    height: GAME.HEIGHT * renderScale,
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

