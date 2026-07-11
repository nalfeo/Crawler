import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Regression guard for the BootScene terrain-pack static preload wiring
 * (reviewed-design refinement #1). BootScene.ts is Phaser-coupled and not
 * instantiable headlessly, so — mirroring
 * tests/unit/boot-scene-generated-sprite-gate.test.ts — we assert against
 * its source.
 */
describe('BootScene terrain-pack preload wiring', () => {
  const source = readFileSync('src/engine/scenes/BootScene.ts', 'utf-8');

  it('imports preloadTerrainPacks from the static terrain-pack visuals registry', () => {
    expect(source).toContain(
      "import { preloadTerrainPacks } from '../sprites/terrain-pack-visuals.js';",
    );
  });

  it('calls preloadTerrainPacks(this.load) inside preload(), before the scene ever starts', () => {
    expect(source).toMatch(
      /preload\(\): void \{[\s\S]*?const terrainPackEntries = preloadTerrainPacks\(this\.load\);[\s\S]*?\n {2}\}/,
    );
  });

  it('logs the queued terrain-pack asset count for observability', () => {
    expect(source).toMatch(
      /preloadTerrainPacks\(this\.load\);[\s\S]*?logger\.info\('Preloading terrain-pack assets', \{ count: terrainPackEntries\.length \}\);/,
    );
  });
});
