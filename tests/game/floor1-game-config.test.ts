import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('createFloor1GameConfig', () => {
  it('captures the shared base-game host settings that visual labs should inherit', () => {
    const source = readFileSync('src/bootstrap/floor1-game-config.ts', 'utf-8');

    expect(source).toContain("backgroundColor: '#111111'");
    expect(source).toContain('width: GAME.WIDTH');
    expect(source).toContain('height: GAME.HEIGHT');
    expect(source).toContain('pixelArt: true');
    expect(source).toContain('roundPixels: true');
    expect(source).toContain("default: 'arcade'");
    expect(source).toContain('mode: Phaser.Scale.FIT');
    expect(source).toContain('autoCenter: Phaser.Scale.CENTER_BOTH');
    expect(source).toContain('scene: [BootScene, new MainGameScene(sceneOptions)]');
  });

  it('makes the main game boot through the shared helper', () => {
    const source = readFileSync('src/main.ts', 'utf-8');

    expect(source).toContain(
      "const config = createFloor1GameConfig('game-container', createFloor1MainSceneOptions());",
    );
  });
});
