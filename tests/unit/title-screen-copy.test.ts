import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));

describe('title screen copy', () => {
  const bootSceneSource = readFileSync(
    resolve(testDir, '../../src/engine/scenes/BootScene.ts'),
    'utf-8',
  );
  const introSceneSource = readFileSync(
    resolve(testDir, '../../src/engine/scenes/IntroScene.ts'),
    'utf-8',
  );

  it('uses Crawler as the boot loading title', () => {
    expect(bootSceneSource).toContain("'Crawler'");
    expect(bootSceneSource).not.toContain('THE CRAWLER');
  });

  it('uses Crawler as the intro title', () => {
    expect(introSceneSource).toContain("'Crawler'");
    expect(introSceneSource).not.toContain('THE CRAWLER');
  });
});
