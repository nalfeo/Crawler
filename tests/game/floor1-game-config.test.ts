import Phaser from 'phaser';
import { describe, expect, it } from 'vitest';
import { createFloor1GameConfig } from '../../src/bootstrap/floor1-game-config.js';
import { createFloor1MainSceneOptions } from '../../src/bootstrap/floor1-main-scene-options.js';
import { BootScene, MainGameScene } from '../../src/engine/index.js';
import { GAME } from '../../src/shared/constants.js';

describe('createFloor1GameConfig', () => {
  it('matches the base game host settings that visual labs should inherit', () => {
    const config = createFloor1GameConfig('game-container', createFloor1MainSceneOptions());

    expect(config.parent).toBe('game-container');
    expect(config.type).toBe(Phaser.AUTO);
    expect(config.width).toBe(GAME.WIDTH);
    expect(config.height).toBe(GAME.HEIGHT);
    expect(config.backgroundColor).toBe('#111111');
    expect(config.pixelArt).toBe(true);
    expect(config.roundPixels).toBe(true);
    expect(config.physics).toEqual({
      default: 'arcade',
      arcade: {
        gravity: { x: 0, y: 0 },
        debug: false,
      },
    });
    expect(config.scale).toEqual({
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    });
    expect(config.scene).toHaveLength(2);
    expect(config.scene?.[0]).toBe(BootScene);
    expect(config.scene?.[1]).toBeInstanceOf(MainGameScene);
  });
});
