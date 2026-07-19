import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';

const RUNTIME_KEY = 'equipment/weapon/void-rapier';
const BRIGHT_RIM_THRESHOLD = { red: 200, green: 190, blue: 235 } as const;
const SATURATED_ACCENT_THRESHOLD = { red: 140, greenMax: 120, blue: 220 } as const;
const BOTTOM_CENTER_ALPHA_INDEX = (124 * 128 + 64) * 4 + 3;

function repoPath(relativePath: string): string {
  return fileURLToPath(new URL(`../../${relativePath}`, import.meta.url));
}

describe('void-rapier asset request', () => {
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
        }
      >;
    };
    const entry = raw.entries[RUNTIME_KEY];
    expect(entry).toBeDefined();
    expect(entry?.briefId).toBe(RUNTIME_KEY);
    expect(entry?.assetPath).toBe('generated/equipment/weapon/void-rapier.png');
    expect(entry?.spriteName).toBe(RUNTIME_KEY);
    expect(entry?.type).toBe('weapon');
  });

  it('ships a centered upright rapier with readable bright rims and violet accent', () => {
    const iconPath = repoPath('public/assets/generated/equipment/weapon/void-rapier.png');
    expect(existsSync(iconPath)).toBe(true);

    const png = PNG.sync.read(readFileSync(iconPath));
    expect(png.width).toBe(128);
    expect(png.height).toBe(128);

    let minX = png.width;
    let maxX = -1;
    let minY = png.height;
    let maxY = -1;
    let opaqueCount = 0;
    let brightRimCount = 0;
    let saturatedAccentCount = 0;

    for (let y = 0; y < png.height; y++) {
      for (let x = 0; x < png.width; x++) {
        const index = (y * png.width + x) * 4;
        const red = png.data[index] ?? 0;
        const green = png.data[index + 1] ?? 0;
        const blue = png.data[index + 2] ?? 0;
        const alpha = png.data[index + 3] ?? 0;
        if (alpha === 0) continue;
        opaqueCount += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (
          red >= BRIGHT_RIM_THRESHOLD.red &&
          green >= BRIGHT_RIM_THRESHOLD.green &&
          blue >= BRIGHT_RIM_THRESHOLD.blue
        ) {
          brightRimCount += 1;
        }
        if (
          red >= SATURATED_ACCENT_THRESHOLD.red &&
          blue >= SATURATED_ACCENT_THRESHOLD.blue &&
          green <= SATURATED_ACCENT_THRESHOLD.greenMax
        ) {
          saturatedAccentCount += 1;
        }
      }
    }

    expect(opaqueCount).toBeGreaterThan(0);
    expect(minX).toBeGreaterThanOrEqual(1);
    expect(maxX).toBeLessThanOrEqual(126);
    expect(minY).toBeGreaterThanOrEqual(1);
    expect(maxY).toBeLessThanOrEqual(126);

    const centerX = (minX + maxX) / 2;
    expect(centerX).toBeGreaterThanOrEqual(60);
    expect(centerX).toBeLessThanOrEqual(68);
    expect(minY).toBeLessThanOrEqual(2);
    expect(png.data[BOTTOM_CENTER_ALPHA_INDEX] ?? 0).toBeGreaterThan(0);

    expect(brightRimCount).toBeGreaterThanOrEqual(40);
    expect(saturatedAccentCount).toBeGreaterThanOrEqual(20);

    // Directional orientation: point-up means the blade tip (top band) is narrower
    // than the grip region (bottom band). A vertically flipped replacement fails this.
    const bandHeight = Math.floor(png.height * 0.2);
    let topBandOpaqueSum = 0;
    let bottomBandOpaqueSum = 0;
    for (let row = 0; row < bandHeight; row++) {
      for (let x = 0; x < png.width; x++) {
        if ((png.data[(row * png.width + x) * 4 + 3] ?? 0) > 0) topBandOpaqueSum += 1;
      }
    }
    for (let row = png.height - bandHeight; row < png.height; row++) {
      for (let x = 0; x < png.width; x++) {
        if ((png.data[(row * png.width + x) * 4 + 3] ?? 0) > 0) bottomBandOpaqueSum += 1;
      }
    }
    const topBandAvgWidth = topBandOpaqueSum / bandHeight;
    const bottomBandAvgWidth = bottomBandOpaqueSum / bandHeight;
    // Bottom grip must be at least 1.5× wider than top tip to confirm point-up orientation.
    expect(bottomBandAvgWidth).toBeGreaterThan(topBandAvgWidth * 1.5);

    const visited = new Uint8Array(png.width * png.height);
    const queue = new Uint32Array(Math.max(opaqueCount, 1));
    let componentCount = 0;
    for (let y = 0; y < png.height; y++) {
      for (let x = 0; x < png.width; x++) {
        const start = y * png.width + x;
        if (visited[start] === 1) continue;
        if ((png.data[start * 4 + 3] ?? 0) === 0) continue;
        componentCount += 1;
        let head = 0;
        let tail = 0;
        queue[tail++] = start;
        visited[start] = 1;
        while (head < tail) {
          const point = queue[head++]!;
          const px = point % png.width;
          const py = (point / png.width) | 0;
          const deltas = [
            [-1, 0],
            [1, 0],
            [0, -1],
            [0, 1],
          ] as const;
          for (const [dx, dy] of deltas) {
            const nx = px + dx;
            const ny = py + dy;
            if (nx < 0 || ny < 0 || nx >= png.width || ny >= png.height) continue;
            const next = ny * png.width + nx;
            if (visited[next] === 1) continue;
            if ((png.data[next * 4 + 3] ?? 0) === 0) continue;
            visited[next] = 1;
            queue[tail++] = next;
          }
        }
      }
    }
    expect(componentCount).toBe(1);
  });
});
