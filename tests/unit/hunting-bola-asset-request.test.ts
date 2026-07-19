import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';

const RUNTIME_KEY = 'equipment/weapon/hunting-bola';

function repoPath(relativePath: string): string {
  return fileURLToPath(new URL(`../../${relativePath}`, import.meta.url));
}

describe('hunting-bola asset request', () => {
  it('ships a generated-manifest entry keyed by the exact runtime key', () => {
    const manifestPath = repoPath('public/assets/generated/manifest.json');
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      readonly entries: Record<
        string,
        {
          readonly assetPath: string;
          readonly briefId: string;
          readonly spriteName: string;
          readonly type: 'weapon';
          readonly equipment?: {
            readonly stableId: string;
            readonly runtimeKey: string;
            readonly productionWaveId: string;
          };
        }
      >;
    };
    const entry = raw.entries[RUNTIME_KEY];
    expect(entry).toBeDefined();
    expect(entry?.briefId).toBe(RUNTIME_KEY);
    expect(entry?.assetPath).toBe('generated/equipment/weapon/hunting-bola-placeholder.png');
    expect(entry?.spriteName).toBe(RUNTIME_KEY);
    expect(entry?.type).toBe('weapon');
    expect(entry?.equipment?.stableId).toBe('weapon.hunting-bola');
    expect(entry?.equipment?.runtimeKey).toBe(RUNTIME_KEY);
    expect(entry?.equipment?.productionWaveId).toBe('floor2-equipment-weapon-bow');
  });

  it('ships a centered transparent 128×128 icon silhouette', () => {
    const iconPath = repoPath(
      'public/assets/generated/equipment/weapon/hunting-bola-placeholder.png',
    );
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

    expect(opaqueCount).toBeGreaterThan(0);
    const centerX = (minX + maxX) / 2;
    expect(centerX).toBeGreaterThanOrEqual(60);
    expect(centerX).toBeLessThanOrEqual(68);
    const centerY = (minY + maxY) / 2;
    expect(centerY).toBeGreaterThanOrEqual(60);
    expect(centerY).toBeLessThanOrEqual(68);

    // Transparent margin: the silhouette must not touch any edge, ensuring
    // the background is genuinely transparent around the centered icon.
    const minMargin = 4;
    expect(minX).toBeGreaterThanOrEqual(minMargin);
    expect(maxX).toBeLessThanOrEqual(png.width - 1 - minMargin);
    expect(minY).toBeGreaterThanOrEqual(minMargin);
    expect(maxY).toBeLessThanOrEqual(png.height - 1 - minMargin);
  });
});
