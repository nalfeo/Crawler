/**
 * Asset-opacity validator for the terrain bake's underdraw skip.
 *
 * The bake skips the `floorPool` underdraw beneath a wall whose canonical
 * blob47 mask is {@link FULLY_OPAQUE_BLOB47_MASK}, and it skips the per-cell
 * `rt.clear` whenever the cell ends in an opaque full-cell repaint. Both are
 * safe ONLY because of a property of the shipped art, not of the code:
 *
 *   1. the wall-atlas frame for mask 255 covers its whole cell opaquely
 *      (a wall only insets a quadrant on an OPEN edge, and mask 255 has none),
 *      and
 *   2. every floor/corridor/special pool tile is opaque edge to edge.
 *
 * If a pack is re-authored — a softer border radius, an alpha vignette, a
 * bevelled edge — either assumption can quietly break and the bake starts
 * leaving stale pixels or showing the bare RenderTexture through an inset.
 * That is a visual regression no command-count assertion can catch, so it is
 * pinned here against the real decoded PNGs.
 *
 * Test 1 additionally asserts mask 255 is the ONLY fully-opaque frame, which
 * is what makes it correct to key the skip on that single mask value rather
 * than on a per-frame opacity table.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import { getAllTerrainPackIds, getTerrainPack } from '../../src/shared/terrain-pack-registry.js';
import { FULLY_OPAQUE_BLOB47_MASK } from '../../src/shared/terrain-pack-mask.js';
import type { TerrainPackDef } from '../../src/shared/terrain-pack-types.js';

const PUBLIC_DIR = resolve(import.meta.dirname, '../../public');

function decode(imagePath: string): PNG {
  return PNG.sync.read(readFileSync(resolve(PUBLIC_DIR, imagePath)));
}

/** Lowest alpha byte inside the given rect of a decoded PNG. */
function minAlpha(png: PNG, x0: number, y0: number, w: number, h: number): number {
  let min = 255;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const a = png.data[(y * png.width + x) * 4 + 3]!;
      if (a < min) min = a;
    }
  }
  return min;
}

/** Min alpha of one atlas cell, addressed by `frameIndex`. */
function frameMinAlpha(png: PNG, pack: TerrainPackDef, frameIndex: number): number {
  const { cellPx, gridCols } = pack.wallAutotile;
  const col = frameIndex % gridCols;
  const row = Math.floor(frameIndex / gridCols);
  return minAlpha(png, col * cellPx, row * cellPx, cellPx, cellPx);
}

const PACK_IDS = getAllTerrainPackIds();

describe('terrain pack wall atlases — only the enclosed mask is fully opaque', () => {
  it.each(PACK_IDS)('%s', (packId) => {
    const pack = getTerrainPack(packId);
    const png = decode(pack.wallAutotile.imagePath);

    const opaqueMasks: number[] = [];
    for (const entry of pack.wallAutotile.masks) {
      if (frameMinAlpha(png, pack, entry.frameIndex) === 255) opaqueMasks.push(entry.maskId);
    }

    // Exactly one fully-opaque frame, and it is the mask the bake keys its
    // underdraw skip off. Any other opaque frame would mean the skip is
    // leaving free performance on the table; a mask-255 frame that is NOT
    // opaque would mean the skip is a visual bug.
    expect(opaqueMasks).toEqual([FULLY_OPAQUE_BLOB47_MASK]);
  });
});

describe('terrain pack floor pools — every pool tile is opaque edge to edge', () => {
  it.each(PACK_IDS)('%s', (packId) => {
    const pack = getTerrainPack(packId);
    const pools = [
      ...pack.floorPool,
      ...pack.corridorPool,
      ...Object.values(pack.specialFloorPools ?? {}).flatMap((pool) => pool ?? []),
    ];
    expect(pools.length).toBeGreaterThan(0);

    const translucent = pools
      .filter((variant) => {
        const png = decode(variant.imagePath);
        return minAlpha(png, 0, 0, png.width, png.height) !== 255;
      })
      .map((variant) => variant.id);

    // A pool stamp is what makes the wall underdraw and the cover-cell
    // repaint able to destroy any overhanging ink beneath them. If a pool
    // tile were translucent, the bake's skipped `rt.clear` would show
    // through it.
    expect(translucent).toEqual([]);
  });
});
