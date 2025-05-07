import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('createFloor1GameConfig', () => {
  it('captures the shared base-game host settings that visual labs should inherit', () => {
    const source = readFileSync('src/bootstrap/floor-game-config.ts', 'utf-8');

    expect(source).toContain("backgroundColor: '#111111'");
    expect(source).toContain('width: GAME.WIDTH');
    expect(source).toContain('height: GAME.HEIGHT');
    expect(source).toContain('pixelArt: true');
    expect(source).toContain('roundPixels: true');
    expect(source).toContain("default: 'arcade'");
    expect(source).toContain('mode: Phaser.Scale.FIT');
    expect(source).toContain('autoCenter: Phaser.Scale.CENTER_BOTH');
    expect(source).toMatch(
      /scene:\s*\[\s*new IntroScene\(\),\s*BootScene,\s*new MainGameScene\(sceneOptions\)\s*\]/,
    );
  });

  it('makes the main game boot through the shared helper', () => {
    const source = readFileSync('src/main.ts', 'utf-8');

    // main.ts now uses createFloorGameConfig (floor-aware) and reads ?floor= URL param
    expect(source).toContain('createFloorGameConfig');
    expect(source).toContain('createFloorMainSceneOptions');
  });

  it('passes replacement options as queued scene-restart data', () => {
    const source = readFileSync('src/engine/scenes/MainGameScene.ts', 'utf-8');

    expect(source).toContain('this.scene.restart({ mainGameSceneOptions: composedNextOptions })');
    expect(source).toContain(
      'this.options.recomposeFloorTransitionOptions?.(nextOptions) ?? nextOptions',
    );
    expect(source).toContain('this.options = data.mainGameSceneOptions');
    expect(source).not.toContain('this.options = nextOptions');
  });
});
