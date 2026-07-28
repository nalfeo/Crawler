/**
 * Art-quality + determinism guard for the procedurally-authored terrain-pack
 * door tiles produced by `renderDoorTile` (heavy powered steel bulkheads for
 * Floor 2's industrial-cave, shared byte-for-byte by the caeles-fixture pack).
 *
 * The sibling `terrain-pack-committed.test.ts` only validates door *existence*,
 * dimensions, and path-safety (`validatePoolAndDoorImages`); nothing asserted
 * the door ART was on-style — which is exactly how the previous placeholder
 * shipped as flat 985-colour orange slabs (maxChroma ~104) and open doors that
 * were literal transparent holes in the wall. This suite locks the doors to the
 * same chunky pixel-art budget as the restyled ground (colours, luminance
 * levels, mean luminance, chroma, 2px min feature, binary alpha), proves the
 * generator is deterministic, and pins the committed PNGs on disk to the
 * generator output so the art cannot silently drift from its source.
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  renderDoorTile,
  type DoorOrientation,
} from '../../../scripts/sprites/terrain-packs/procedural-surfaces.js';
import {
  encodePng,
  decodePng,
  type RgbaImage,
} from '../../../scripts/sprites/terrain-packs/png-buffer.js';
import { isPixelArtGround } from '../../../scripts/sprites/terrain-packs/gen/image-ops.js';
import { TERRAIN_PACK_CELL_PX } from '../../../src/shared/terrain-pack-types.js';

function repoRoot(): string {
  return path.resolve(import.meta.dirname, '..', '..', '..');
}

interface DoorMetrics {
  colorCount: number;
  lumLevels: number;
  mean: number;
  maxChroma: number;
  binaryAlpha: boolean;
  opaque: number;
  transparent: number;
}

function metrics(image: RgbaImage): DoorMetrics {
  let count = 0;
  let lumSum = 0;
  let maxChroma = 0;
  let binaryAlpha = true;
  let opaque = 0;
  let transparent = 0;
  const colors = new Set<string>();
  const lumLevels = new Set<number>();
  for (let i = 0; i < image.data.length; i += 4) {
    const a = image.data[i + 3] ?? 0;
    if (a !== 0 && a !== 255) binaryAlpha = false;
    if (a === 0) {
      transparent++;
      continue;
    }
    opaque++;
    const r = image.data[i] ?? 0;
    const g = image.data[i + 1] ?? 0;
    const b = image.data[i + 2] ?? 0;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    count++;
    lumSum += lum;
    maxChroma = Math.max(maxChroma, chroma);
    colors.add(`${r},${g},${b}`);
    lumLevels.add(Math.round(lum));
  }
  return {
    colorCount: colors.size,
    lumLevels: lumLevels.size,
    mean: count === 0 ? 0 : lumSum / count,
    maxChroma,
    binaryAlpha,
    opaque,
    transparent,
  };
}

const ALL_DOORS: { isOpen: boolean; orientation: DoorOrientation }[] = [
  { isOpen: false, orientation: 'horizontal' },
  { isOpen: false, orientation: 'vertical' },
  { isOpen: true, orientation: 'horizontal' },
  { isOpen: true, orientation: 'vertical' },
];

function label(isOpen: boolean, orientation: DoorOrientation): string {
  return `door-${isOpen ? 'open' : 'closed'}-${orientation}`;
}

describe('terrain-pack door tiles (renderDoorTile)', () => {
  for (const { isOpen, orientation } of ALL_DOORS) {
    const name = label(isOpen, orientation);

    it(`${name}: is a 64x64 binary-alpha tile`, () => {
      const img = renderDoorTile(isOpen, orientation);
      expect(img.width).toBe(TERRAIN_PACK_CELL_PX);
      expect(img.height).toBe(TERRAIN_PACK_CELL_PX);
      expect(TERRAIN_PACK_CELL_PX).toBe(64);
      expect(metrics(img).binaryAlpha).toBe(true);
    });

    it(`${name}: matches the chunky pixel-art style budget`, () => {
      const m = metrics(renderDoorTile(isOpen, orientation));
      // Colour + luminance budget: sit in the same world as the restyled ground
      // (ground 69-178 colours / 13-18 lum levels), NOT the 985-colour placeholder.
      expect(m.colorCount).toBeLessThanOrEqual(200);
      expect(m.lumLevels).toBeGreaterThanOrEqual(10);
      expect(m.lumLevels).toBeLessThanOrEqual(24);
      // Mean luminance stays in the mid band (readable metal, not a bright slab).
      expect(m.mean).toBeGreaterThanOrEqual(35);
      expect(m.mean).toBeLessThanOrEqual(60);
      // Body is cool neutral steel; only the hazard marking is allowed a little
      // saturation, capped well under the 101-104 the placeholder reached.
      expect(m.maxChroma).toBeLessThanOrEqual(45);
    });

    it(`${name}: is authored on a >=2px grid (min feature size)`, () => {
      const img = renderDoorTile(isOpen, orientation);
      expect(isPixelArtGround(img, 2)).toBe(true);
    });

    it(`${name}: is deterministic (byte-identical across renders)`, () => {
      const first = encodePng(renderDoorTile(isOpen, orientation));
      const second = encodePng(renderDoorTile(isOpen, orientation));
      expect(first.equals(second)).toBe(true);
    });
  }

  it('open doors keep the centre passage transparent; closed doors are solid', () => {
    for (const orientation of ['horizontal', 'vertical'] as const) {
      const open = metrics(renderDoorTile(true, orientation));
      const closed = metrics(renderDoorTile(false, orientation));
      // Open door must be REAL ART framing an actual opening: it has both a
      // meaningful transparent region (the floor renders through) AND solid
      // machinery (retracted leaves + rails), not "just a hole" nor a full slab.
      expect(open.transparent).toBeGreaterThan(400);
      expect(open.opaque).toBeGreaterThan(1500);
      // Closed door is a fully-sealed slab.
      expect(closed.transparent).toBe(0);
      expect(closed.opaque).toBe(TERRAIN_PACK_CELL_PX * TERRAIN_PACK_CELL_PX);
    }
  });

  it('vertical orientation is the exact transpose of horizontal', () => {
    for (const isOpen of [false, true]) {
      const h = renderDoorTile(isOpen, 'horizontal');
      const v = renderDoorTile(isOpen, 'vertical');
      const n = h.width;
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const from = (y * n + x) * 4;
          const to = (x * n + y) * 4;
          expect(v.data[to]).toBe(h.data[from]);
          expect(v.data[to + 1]).toBe(h.data[from + 1]);
          expect(v.data[to + 2]).toBe(h.data[from + 2]);
          expect(v.data[to + 3]).toBe(h.data[from + 3]);
        }
      }
    }
  });

  it('committed PNGs for both packs match the generator output', () => {
    for (const pack of ['industrial-cave', 'caeles-fixture']) {
      for (const { isOpen, orientation } of ALL_DOORS) {
        const rel = path.join(
          'public',
          'assets',
          'terrain-packs',
          pack,
          `${label(isOpen, orientation)}.png`,
        );
        const committed = readFileSync(path.join(repoRoot(), rel));
        const generated = encodePng(renderDoorTile(isOpen, orientation));
        expect(committed.equals(generated), `${rel} is stale — re-run terrain-packs:build`).toBe(
          true,
        );
        // Sanity: the committed bytes decode to a valid 64x64 tile.
        const decoded = decodePng(committed);
        expect(decoded.width).toBe(TERRAIN_PACK_CELL_PX);
        expect(decoded.height).toBe(TERRAIN_PACK_CELL_PX);
      }
    }
  });
});
