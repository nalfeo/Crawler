import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { floorManifestDefSchema } from '../../src/shared/floor-manifest.js';
import { BiomeType } from '../../src/shared/map-types.js';

const floorsDir = join(dirname(fileURLToPath(import.meta.url)), '../../src/shared/data/floors');

const manifestFiles = readdirSync(floorsDir).filter((file) => file.endsWith('.manifest.json'));

describe('floor manifest lighting defaults', () => {
  it('discovers at least the two shipped floors', () => {
    expect(manifestFiles.length).toBeGreaterThanOrEqual(2);
  });

  it.each(manifestFiles)('%s declares a schema-valid per-floor ambient in [0,1]', (file) => {
    const raw = JSON.parse(readFileSync(join(floorsDir, file), 'utf-8'));
    const manifest = floorManifestDefSchema.parse(raw);
    expect(typeof manifest.lighting.ambient).toBe('number');
    expect(manifest.lighting.ambient).toBeGreaterThanOrEqual(0);
    expect(manifest.lighting.ambient).toBeLessThanOrEqual(1);
  });

  it('floor2 manifest declares cave-system biome and floor2 config', () => {
    const raw = JSON.parse(readFileSync(join(floorsDir, 'floor2.manifest.json'), 'utf-8'));
    const manifest = floorManifestDefSchema.parse(raw);
    expect(manifest.map.biome).toBe(BiomeType.CAVE_SYSTEM);
    expect(manifest.floor2?.presentCount).toBeGreaterThanOrEqual(3);
    expect(manifest.floor2?.settlement?.shopCountRange[0]).toBeGreaterThanOrEqual(1);
  });

  it('floor3 manifest declares the biome-overworld layout and seven biome regions', () => {
    const raw = JSON.parse(readFileSync(join(floorsDir, 'floor3.manifest.json'), 'utf-8'));
    const manifest = floorManifestDefSchema.parse(raw);
    expect(manifest.map.biome).toBe(BiomeType.CAVE_SYSTEM_BIOMES);
    expect(manifest.enemyPackId).toBe('floor3-wild');
    expect(manifest.floor3?.biomeRegionCount).toBe(7);
  });
});
