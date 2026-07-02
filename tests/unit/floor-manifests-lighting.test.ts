import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { floorManifestDefSchema } from '../../src/shared/floor-manifest.js';

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
});
