/**
 * Tests for `scripts/sprites/terrain-packs/wall-accent-tools.ts` — the
 * mask-aware wall-accent atlas assembly (2026-07-25 terrain-variance
 * adversarial-review resolution #3: "no accent may spill outside valid wall
 * topology").
 */
import { describe, expect, it } from 'vitest';
import {
  buildWallAccentAtlas,
  maskAccentCellToWallCell,
} from '../../../scripts/sprites/terrain-packs/wall-accent-tools.js';
import {
  buildMaskFrameAssignments,
  ATLAS_GRID_COLS,
} from '../../../scripts/sprites/terrain-packs/atlas-grid.js';
import {
  createImage,
  cropImage,
  fillRect,
  type RgbaImage,
} from '../../../scripts/sprites/terrain-packs/png-buffer.js';
import { TERRAIN_PACK_CELL_PX } from '../../../src/shared/terrain-pack-types.js';
import { buildIndustrialCavePack } from '../../../scripts/sprites/terrain-packs/build-industrial-cave.js';
import { decodePng } from '../../../scripts/sprites/terrain-packs/png-buffer.js';

function opaqueMotif(): RgbaImage {
  const img = createImage(TERRAIN_PACK_CELL_PX, TERRAIN_PACK_CELL_PX);
  fillRect(img, 0, 0, TERRAIN_PACK_CELL_PX, TERRAIN_PACK_CELL_PX, 200, 50, 50, 255);
  return img;
}

function halfTransparentWallCell(): RgbaImage {
  // Left half opaque (wall), right half transparent (floor bleeding in).
  const img = createImage(TERRAIN_PACK_CELL_PX, TERRAIN_PACK_CELL_PX);
  fillRect(img, 0, 0, TERRAIN_PACK_CELL_PX / 2, TERRAIN_PACK_CELL_PX, 60, 60, 60, 255);
  return img;
}

describe('maskAccentCellToWallCell', () => {
  it('forces the accent transparent wherever the wall cell is transparent', () => {
    const motif = opaqueMotif();
    const wallCell = halfTransparentWallCell();
    const clipped = maskAccentCellToWallCell(motif, wallCell);
    for (let y = 0; y < TERRAIN_PACK_CELL_PX; y++) {
      for (let x = 0; x < TERRAIN_PACK_CELL_PX; x++) {
        const idx = (y * TERRAIN_PACK_CELL_PX + x) * 4;
        const wallAlpha = wallCell.data[idx + 3] ?? 0;
        const clippedAlpha = clipped.data[idx + 3] ?? 0;
        if (wallAlpha === 0) {
          expect(clippedAlpha).toBe(0);
        } else {
          expect(clippedAlpha).toBe(motif.data[idx + 3]);
        }
      }
    }
  });

  it('preserves the motif exactly where the wall cell is fully opaque', () => {
    const motif = opaqueMotif();
    const fullyOpaqueWall = createImage(TERRAIN_PACK_CELL_PX, TERRAIN_PACK_CELL_PX);
    fillRect(fullyOpaqueWall, 0, 0, TERRAIN_PACK_CELL_PX, TERRAIN_PACK_CELL_PX, 1, 1, 1, 255);
    const clipped = maskAccentCellToWallCell(motif, fullyOpaqueWall);
    expect(Buffer.from(clipped.data)).toEqual(Buffer.from(motif.data));
  });

  it('throws on a size mismatch between motif and wall cell', () => {
    const motif = createImage(32, 32);
    const wallCell = createImage(64, 64);
    expect(() => maskAccentCellToWallCell(motif, wallCell)).toThrow(/size mismatch/);
  });
});

describe('buildWallAccentAtlas', () => {
  const { manifest } = buildIndustrialCavePack();
  const wallAtlasBuffer = (() => {
    // Use the freshly-built placeholder atlas (not the shipped Azure one) so
    // this test is independent of the committed generated art.
    const result = buildIndustrialCavePack();
    const atlasFile = result.files.find((f) => f.relativePath.endsWith('wall-atlas.png'))!;
    return atlasFile.buffer;
  })();
  const wallAtlas = decodePng(wallAtlasBuffer);

  it('produces an atlas matching the wall atlas dimensions exactly', () => {
    const motif = opaqueMotif();
    const accentAtlas = buildWallAccentAtlas(motif, wallAtlas);
    expect(accentAtlas.width).toBe(wallAtlas.width);
    expect(accentAtlas.height).toBe(wallAtlas.height);
  });

  it('never has an opaque accent pixel where the wall atlas is transparent, for every canonical mask (no spill, provable by construction)', () => {
    const motif = opaqueMotif();
    const accentAtlas = buildWallAccentAtlas(motif, wallAtlas);
    const assignments = buildMaskFrameAssignments();
    for (const { frameIndex } of assignments) {
      const col = frameIndex % ATLAS_GRID_COLS;
      const row = Math.floor(frameIndex / ATLAS_GRID_COLS);
      const wallCell = cropImage(
        wallAtlas,
        col * TERRAIN_PACK_CELL_PX,
        row * TERRAIN_PACK_CELL_PX,
        TERRAIN_PACK_CELL_PX,
        TERRAIN_PACK_CELL_PX,
      );
      const accentCell = cropImage(
        accentAtlas,
        col * TERRAIN_PACK_CELL_PX,
        row * TERRAIN_PACK_CELL_PX,
        TERRAIN_PACK_CELL_PX,
        TERRAIN_PACK_CELL_PX,
      );
      for (let i = 3; i < wallCell.data.length; i += 4) {
        if ((wallCell.data[i] ?? 0) === 0) {
          expect(accentCell.data[i] ?? 0).toBe(0);
        }
      }
    }
  });

  it('leaves the spare (48th, unassigned) grid cell fully transparent', () => {
    const motif = opaqueMotif();
    const accentAtlas = buildWallAccentAtlas(motif, wallAtlas);
    const assignedFrames = new Set(manifest.wallAutotile.masks.map((m) => m.frameIndex));
    const totalCells =
      (accentAtlas.width / TERRAIN_PACK_CELL_PX) * (accentAtlas.height / TERRAIN_PACK_CELL_PX);
    for (let frameIndex = 0; frameIndex < totalCells; frameIndex++) {
      if (assignedFrames.has(frameIndex)) continue;
      const col = frameIndex % ATLAS_GRID_COLS;
      const row = Math.floor(frameIndex / ATLAS_GRID_COLS);
      const cell = cropImage(
        accentAtlas,
        col * TERRAIN_PACK_CELL_PX,
        row * TERRAIN_PACK_CELL_PX,
        TERRAIN_PACK_CELL_PX,
        TERRAIN_PACK_CELL_PX,
      );
      for (let i = 3; i < cell.data.length; i += 4) {
        expect(cell.data[i] ?? 0).toBe(0);
      }
    }
  });

  it('throws when the motif is not exactly 64x64', () => {
    const motif = createImage(32, 32);
    expect(() => buildWallAccentAtlas(motif, wallAtlas)).toThrow(/must be/);
  });

  it('is deterministic: rebuilding from the same motif + wall atlas yields byte-identical output', () => {
    const motif = opaqueMotif();
    const first = buildWallAccentAtlas(motif, wallAtlas);
    const second = buildWallAccentAtlas(motif, wallAtlas);
    expect(Buffer.from(first.data)).toEqual(Buffer.from(second.data));
  });
});
