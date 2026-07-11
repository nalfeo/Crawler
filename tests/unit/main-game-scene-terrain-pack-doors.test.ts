import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Regression guard for the MainGameScene door-overlay terrain-pack wiring
 * (reviewed-design refinement #5's pure resolver, used at the runtime call
 * site). MainGameScene is Phaser-coupled and not instantiable headlessly,
 * so — mirroring tests/unit/boot-scene-generated-sprite-gate.test.ts and
 * tests/unit/main-game-scene-lighting-overlay.test.ts — we assert against
 * its source.
 */
describe('MainGameScene door-overlay terrain-pack wiring', () => {
  const source = readFileSync('src/engine/scenes/MainGameScene.ts', 'utf-8');

  it('imports the pack registry, pure door-variant resolver, and cell-size constant', () => {
    expect(source).toContain(
      "import { getTerrainPack } from '../../shared/terrain-pack-registry.js';",
    );
    expect(source).toContain('resolveDoorPoolVariant');
    expect(source).toContain('resolveDoorOrientationFromFlanks');
    expect(source).toContain("from '../../shared/terrain-pack-variants.js'");
    expect(source).toContain(
      "import { TERRAIN_PACK_CELL_PX, type TerrainPackId } from '../../shared/terrain-pack-types.js';",
    );
  });

  it('passes terrainPackId through to buildTerrainLayer', () => {
    expect(source).toContain(
      'buildTerrainLayer(this, floorMap, { terrainPackId: this.options.terrainPackId });',
    );
  });

  it('resolves the pack door variant BEFORE the legacy resolveDoorRenderMode fallback chain', () => {
    const packBranchIndex = source.indexOf(
      'const variant = resolveDoorPoolVariant(pack.doorSet, { isOpen, orientation });',
    );
    const legacyIndex = source.indexOf(
      'const mode = resolveDoorRenderMode(isOpen, { hasGeneratedClosed, hasSheet });',
    );
    expect(packBranchIndex).toBeGreaterThan(-1);
    expect(legacyIndex).toBeGreaterThan(-1);
    expect(packBranchIndex).toBeLessThan(legacyIndex);
  });

  it('checks textures.exists before stamping a pack door variant, then continues (no fallthrough)', () => {
    expect(source).toMatch(
      /if \(this\.textures\.exists\(variant\.textureKey\)\) \{[\s\S]*?addDoorImage\(cx, cy, variant\.textureKey, undefined, packDoorScale\);[\s\S]*?packDoorCount \+= 1;[\s\S]*?continue;[\s\S]*?\}/,
    );
  });

  it('reports packDoorCount in the door render diagnostic summary', () => {
    expect(source).toMatch(/packDoorCount,\s*\n/);
  });

  it('reports missingPackDoorTextureCount in the door render diagnostic summary (Fix 6)', () => {
    expect(source).toContain('missingPackDoorTextureCount,');
  });

  it('warns about a missing pack door texture at most once per scene', () => {
    expect(source).toContain('private warnedMissingPackDoorTexture = false;');
    expect(source).toContain('if (!this.warnedMissingPackDoorTexture)');
    expect(source).toContain('this.warnedMissingPackDoorTexture = true;');
    expect(source).not.toContain('let missingPackDoorTextureWarned = false;');
  });

  it('uses resolveDoorOrientationFromFlanks for door axis resolution (Fix 2)', () => {
    expect(source).toContain(
      'const orientation = resolveDoorOrientationFromFlanks(horizontalDoorway);',
    );
  });
});
