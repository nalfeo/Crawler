import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));

function readSceneSource(sceneFileName: string): string {
  return readFileSync(resolve(testDir, '../../src/engine/scenes', sceneFileName), 'utf-8');
}

describe('title screen copy', () => {
  it('uses Crawler as the boot loading title', () => {
    const bootSceneSource = readSceneSource('BootScene.ts');

    expect(bootSceneSource).toContain("'Crawler'");
    expect(bootSceneSource).not.toContain('THE CRAWLER');
  });

  it('uses Crawler as the intro title', () => {
    const introSceneSource = readSceneSource('IntroScene.ts');

    expect(introSceneSource).toContain("'Crawler'");
    expect(introSceneSource).not.toContain('THE CRAWLER');
  });
});
