import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';

const RUNTIME_KEY = 'equipment/hands/duelist-gloves';

function repoPath(relativePath: string): string {
  return fileURLToPath(new URL(`../../${relativePath}`, import.meta.url));
}

describe('duelist-gloves asset request', () => {
  it('ships a generated-manifest entry keyed by the exact runtime key', () => {
    const manifestPath = repoPath('public/assets/generated/manifest.json');
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      readonly entries: Record<
        string,
        {
          readonly assetPath: string;
          readonly briefId: string;
          readonly spriteName: string;
          readonly type: 'item';
          readonly equipment?: {
            readonly stableId: string;
            readonly runtimeKey: string;
            readonly category: string;
            readonly family: string;
            readonly slot: string;
            readonly productionWaveId: string;
          };
        }
      >;
    };
    const entry = raw.entries[RUNTIME_KEY];
    expect(entry).toBeDefined();
    expect(entry?.briefId).toBe(RUNTIME_KEY);
    expect(entry?.assetPath).toBe('generated/equipment/hands/duelist-gloves.png');
    expect(entry?.spriteName).toBe(RUNTIME_KEY);
    expect(entry?.type).toBe('item');
    expect(entry?.equipment).toEqual({
      stableId: 'hands.duelist-gloves',
      runtimeKey: RUNTIME_KEY,
      category: 'armor',
      family: 'handwear',
      slot: 'hands',
      productionWaveId: 'floor2-equipment-ui-hands',
    });
  });

  it('ships a centered transparent 128×128 icon silhouette', () => {
    const iconPath = repoPath('public/assets/generated/equipment/hands/duelist-gloves.png');
    expect(existsSync(iconPath)).toBe(true);

    const png = PNG.sync.read(readFileSync(iconPath));
    expect(png.width).toBe(128);
    expect(png.height).toBe(128);

    let minX = png.width;
    let maxX = -1;
    let minY = png.height;
    let maxY = -1;
    let opaqueCount = 0;
    for (let y = 0; y < png.height; y++) {
      for (let x = 0; x < png.width; x++) {
        const alpha = png.data[(y * png.width + x) * 4 + 3] ?? 0;
        if (alpha === 0) continue;
        opaqueCount += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    // Silhouette: at least one opaque pixel present.
    expect(opaqueCount).toBeGreaterThan(0);

    // Transparent background: all four corners must have alpha = 0 so a fully
    // opaque fill can never satisfy this test.
    const alphaAt = (x: number, y: number): number =>
      png.data[(y * png.width + x) * 4 + 3] ?? 0;
    expect(alphaAt(0, 0)).toBe(0);
    expect(alphaAt(png.width - 1, 0)).toBe(0);
    expect(alphaAt(0, png.height - 1)).toBe(0);
    expect(alphaAt(png.width - 1, png.height - 1)).toBe(0);

    const centerX = (minX + maxX) / 2;
    expect(centerX).toBeGreaterThanOrEqual(60);
    expect(centerX).toBeLessThanOrEqual(68);
    const centerY = (minY + maxY) / 2;
    expect(centerY).toBeGreaterThanOrEqual(60);
    expect(centerY).toBeLessThanOrEqual(68);
  });
});
