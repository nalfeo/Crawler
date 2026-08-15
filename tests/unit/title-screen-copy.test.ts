import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('title screen copy', () => {
  const bootSceneSource = readFileSync('src/engine/scenes/BootScene.ts', 'utf-8');
  const introSceneSource = readFileSync('src/engine/scenes/IntroScene.ts', 'utf-8');

  it('uses Crawler as the boot loading title', () => {
    expect(bootSceneSource).toContain(".text(CX, TITLE_Y, 'Crawler',");
    expect(bootSceneSource).not.toContain('THE CRAWLER');
  });

  it('uses Crawler as the intro title', () => {
    expect(introSceneSource).toContain(".text(cx, y, 'Crawler',");
    expect(introSceneSource).not.toContain('THE CRAWLER');
  });
});
