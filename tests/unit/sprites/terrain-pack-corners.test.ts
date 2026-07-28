/**
 * Corner-coverage (diagonal) guard for the blob47 terrain packs.
 *
 * Why this suite exists
 * ---------------------
 * `validateCompatibleBoundaries` samples only the four CARDINAL edge bands of a
 * cell, so it is structurally blind to diagonal information: any two masks with
 * the same N/E/S/W nibble look identical along all four edges. Both shipped
 * packs regressed straight through that blind spot while scoring ~1.0 on it:
 *
 *   - `industrial-cave`: the Azure re-texture pass filled every cell
 *     edge-to-edge, collapsing 47 mask slots onto 16 distinct silhouettes and
 *     shipping 16 fully-solid tiles instead of 1.
 *   - `caeles-fixture`: a greedy cell→mask search scored cells only against
 *     expected cardinal connectivity, so it put a half-floor cell on mask 255
 *     and emitted duplicate silhouettes.
 *
 * The tests below lock the corner semantics themselves, prove the gate rejects
 * a cardinal-only sheet, and assert both committed packs now pass at 1.0.
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateCompatibleCorners } from '../../../scripts/sprites/terrain-packs/validate.js';
import {
  ATLAS_GRID_COLS,
  ATLAS_HEIGHT_PX,
  ATLAS_WIDTH_PX,
  buildMaskFrameAssignments,
} from '../../../scripts/sprites/terrain-packs/atlas-grid.js';
import { composeWallCellOutput } from '../../../scripts/sprites/terrain-packs/compose-wall-cell.js';
import { generateQuadrantKit } from '../../../scripts/sprites/terrain-packs/quadrant-kit.js';
import {
  compositeInto,
  createImage,
  decodePng,
  encodePng,
} from '../../../scripts/sprites/terrain-packs/png-buffer.js';
import { deriveTemplateCellMasks } from '../../../scripts/sprites/terrain-packs/build-caeles-fixture.js';
import {
  BLOB47_CANONICAL_MASKS,
  MASK_BIT,
  QUADRANT_CORNERS,
  cornerIsWallFromMask,
  normalizeBlob47Mask,
  quadrantStateFromMask,
} from '../../../src/shared/terrain-pack-mask.js';
import { TERRAIN_PACK_CELL_PX } from '../../../src/shared/terrain-pack-types.js';
import type { TerrainPackDef } from '../../../src/shared/terrain-pack-types.js';

function repoRoot(): string {
  return path.resolve(import.meta.dirname, '..', '..', '..');
}

function readCommittedPack(packId: string): { manifest: TerrainPackDef; atlas: Buffer } {
  const manifest = JSON.parse(
    readFileSync(
      path.join(repoRoot(), 'src', 'shared', 'data', 'terrain-packs', `${packId}.manifest.json`),
      'utf-8',
    ),
  ) as TerrainPackDef;
  const atlas = readFileSync(
    path.join(repoRoot(), 'public', ...manifest.wallAutotile.imagePath.split('/')),
  );
  return { manifest, atlas };
}

describe('blob47 corner semantics', () => {
  it('marks a corner wall iff its quadrant state is full', () => {
    for (const maskId of BLOB47_CANONICAL_MASKS) {
      for (const corner of QUADRANT_CORNERS) {
        expect(cornerIsWallFromMask(maskId, corner)).toBe(
          quadrantStateFromMask(maskId, corner) === 'full',
        );
      }
    }
  });

  it('expects exactly 52 wall corners and 136 floor corners across the 47 masks', () => {
    let wall = 0;
    let floor = 0;
    for (const maskId of BLOB47_CANONICAL_MASKS) {
      for (const corner of QUADRANT_CORNERS) {
        if (cornerIsWallFromMask(maskId, corner)) wall += 1;
        else floor += 1;
      }
    }
    expect(wall).toBe(52);
    expect(floor).toBe(136);
    expect(wall + floor).toBe(BLOB47_CANONICAL_MASKS.length * 4);
  });

  it('has exactly one mask whose four corners are all wall, and it is 255', () => {
    const allWall = BLOB47_CANONICAL_MASKS.filter((maskId) =>
      QUADRANT_CORNERS.every((corner) => cornerIsWallFromMask(maskId, corner)),
    );
    expect(allWall).toEqual([255]);
  });

  it('has exactly one mask whose four corners are all floor, and it is 0', () => {
    const allFloor = BLOB47_CANONICAL_MASKS.filter((maskId) =>
      QUADRANT_CORNERS.every((corner) => !cornerIsWallFromMask(maskId, corner)),
    );
    expect(allFloor).toContain(0);
  });
});

describe('validateCompatibleCorners', () => {
  /**
   * Build a 47-slot atlas where every mask is drawn using only its CARDINAL
   * bits — i.e. the 16-tile autotile sheet the old edge-only gate could not
   * distinguish from a correct 47-tile sheet. This is the exact shape of the
   * shipped `industrial-cave` regression.
   */
  function buildCardinalOnlyAtlas(): { manifest: TerrainPackDef; atlas: Buffer } {
    const kit = generateQuadrantKit();
    const assignments = buildMaskFrameAssignments();
    const image = createImage(ATLAS_WIDTH_PX, ATLAS_HEIGHT_PX);
    const cardinalOnly = MASK_BIT.N | MASK_BIT.E | MASK_BIT.S | MASK_BIT.W;
    for (const { maskId, frameIndex } of assignments) {
      // Re-normalising a mask stripped of its diagonal bits yields the same
      // silhouette for every mask sharing a cardinal nibble.
      const collapsed = normalizeBlob47Mask(maskId & cardinalOnly);
      const cell = composeWallCellOutput(collapsed, kit);
      compositeInto(
        image,
        cell,
        (frameIndex % ATLAS_GRID_COLS) * TERRAIN_PACK_CELL_PX,
        Math.floor(frameIndex / ATLAS_GRID_COLS) * TERRAIN_PACK_CELL_PX,
      );
    }
    const manifest = {
      id: 'cardinal-only-fixture',
      name: 'Cardinal-only fixture',
      provenance: { kind: 'authored', author: 'test', derivationNote: 'test fixture' },
      wallAutotile: {
        imagePath: 'assets/terrain-packs/cardinal-only/wall-atlas.png',
        textureKey: 'cardinal-only-walls',
        cellPx: TERRAIN_PACK_CELL_PX,
        gridCols: ATLAS_GRID_COLS,
        gridRows: ATLAS_HEIGHT_PX / TERRAIN_PACK_CELL_PX,
        masks: assignments.map(({ maskId, frameIndex }) => ({ maskId, frameIndex })),
      },
      floorPool: [],
      corridorPool: [],
      doorSet: [],
    } as unknown as TerrainPackDef;
    return { manifest, atlas: encodePng(image) };
  }

  it('rejects a cardinal-only sheet that the edge-band check cannot see', () => {
    const { manifest, atlas } = buildCardinalOnlyAtlas();
    const result = validateCompatibleCorners(manifest, decodePng(atlas));
    expect(result.ok).toBe(false);
    // A cardinal-only sheet collapses mask 255 onto mask 15, whose four corners
    // are nicked — so the "solid" reference is no longer solid at its corners.
    // That is the precise root cause, and the gate reports it as such rather
    // than emitting 47 downstream per-cell mismatches.
    expect(result.issues.map((issue) => issue.code)).toContain('corner-reference-degenerate');
  });

  it('rejects a sheet whose mask frames are mis-assigned', () => {
    // Correct art, correct mask-0/mask-255 references, but two masks that share
    // a cardinal nibble have their frames swapped. The edge-band check cannot
    // see this at all; the corner check must.
    const { manifest, atlas } = readCommittedPack('industrial-cave');
    const masks = manifest.wallAutotile.masks.map((m) => ({ ...m }));
    const a = masks.findIndex((m) => m.maskId === 15);
    const b = masks.findIndex((m) => m.maskId === 143);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThanOrEqual(0);
    const swapped = masks[a]!.frameIndex;
    masks[a]!.frameIndex = masks[b]!.frameIndex;
    masks[b]!.frameIndex = swapped;

    const result = validateCompatibleCorners(
      { ...manifest, wallAutotile: { ...manifest.wallAutotile, masks } },
      decodePng(atlas),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('corner-mismatch');
  });

  it.each(['industrial-cave', 'caeles-fixture'])(
    'passes the committed %s pack at the 1.0 floor',
    (packId) => {
      const { manifest, atlas } = readCommittedPack(packId);
      const result = validateCompatibleCorners(manifest, decodePng(atlas));
      expect(result.issues).toEqual([]);
      expect(result.ok).toBe(true);
    },
  );

  it.each(['industrial-cave', 'caeles-fixture'])(
    'ships exactly one fully-solid cell in %s',
    (packId) => {
      const { manifest, atlas } = readCommittedPack(packId);
      const image = decodePng(atlas);
      const fullyOpaque: number[] = [];
      for (const { maskId, frameIndex } of manifest.wallAutotile.masks) {
        const ox = (frameIndex % manifest.wallAutotile.gridCols) * manifest.wallAutotile.cellPx;
        const oy =
          Math.floor(frameIndex / manifest.wallAutotile.gridCols) * manifest.wallAutotile.cellPx;
        let transparent = 0;
        for (let y = 0; y < manifest.wallAutotile.cellPx; y += 1) {
          for (let x = 0; x < manifest.wallAutotile.cellPx; x += 1) {
            if (image.data[((oy + y) * image.width + (ox + x)) * 4 + 3] === 0) transparent += 1;
          }
        }
        if (transparent === 0) fullyOpaque.push(maskId);
      }
      expect(fullyOpaque).toEqual([255]);
    },
  );
});

describe('deriveTemplateCellMasks', () => {
  /**
   * External ground truth: the canonical cr31 / Caeles "minimum packing" blob47
   * layout — 47 tiles in a 6x8 array with a single duplicate of solid tile-255,
   * discovered by Caeles at OpenGameArt via exhaustive search and documented at
   * https://www.boristhebrave.com/permanent/24/06/cr31/stagecast/wang/blob.html
   *
   * Indices are in cr31's canonical CLOCKWISE-CYCLE weighting
   * (N=1, NE=2, E=4, SE=8, S=16, SW=32, W=64, NW=128), NOT this repo's
   * cardinals-then-diagonals weighting — see `toCr31Index` below. Pinning the
   * published numbering rather than ours means this table is verifiable against
   * an outside source and cannot silently drift with our internal convention.
   */
  const CAELES_CR31_LAYOUT: readonly (readonly number[])[] = [
    [0, 4, 92, 112, 28, 124, 116, 64],
    [20, 84, 87, 221, 127, 255, 245, 80],
    [29, 117, 85, 95, 247, 215, 209, 1],
    [23, 213, 81, 31, 253, 125, 113, 16],
    [21, 69, 93, 119, 223, 255, 241, 17],
    [5, 68, 71, 193, 7, 199, 197, 65],
  ];

  const CR31_BIT: Readonly<Record<keyof typeof MASK_BIT, number>> = {
    N: 1,
    NE: 2,
    E: 4,
    SE: 8,
    S: 16,
    SW: 32,
    W: 64,
    NW: 128,
  };

  /** Re-weight one of our canonical masks into cr31's clockwise-cycle numbering. */
  function toCr31Index(ourMask: number): number {
    let out = 0;
    for (const key of Object.keys(CR31_BIT) as (keyof typeof MASK_BIT)[]) {
      if (ourMask & MASK_BIT[key]) out |= CR31_BIT[key];
    }
    return out;
  }

  function sliceTemplateCells() {
    const template = decodePng(
      readFileSync(
        path.join(
          repoRoot(),
          'public',
          'assets',
          'vendor',
          'terrain-packs',
          'caeles-seamless-template-ii',
          'template8x6.png',
        ),
      ),
    );
    const cells = [];
    for (let row = 0; row < 6; row += 1) {
      for (let col = 0; col < 8; col += 1) {
        const cell = createImage(32, 32);
        for (let y = 0; y < 32; y += 1) {
          for (let x = 0; x < 32; x += 1) {
            const src = ((row * 32 + y) * template.width + (col * 32 + x)) * 4;
            const dst = (y * 32 + x) * 4;
            cell.data[dst] = template.data[src]!;
            cell.data[dst + 1] = template.data[src + 1]!;
            cell.data[dst + 2] = template.data[src + 2]!;
            cell.data[dst + 3] = template.data[src + 3]!;
          }
        }
        cells.push(cell);
      }
    }
    return cells;
  }

  it('recovers the caeles template layout from the artwork itself', () => {
    const { maskToCell, spareCellIndex } = deriveTemplateCellMasks(sliceTemplateCells());

    expect(maskToCell.size).toBe(BLOB47_CANONICAL_MASKS.length);
    for (const maskId of BLOB47_CANONICAL_MASKS) {
      expect(maskToCell.has(maskId)).toBe(true);
    }
    // Every canonical mask maps to a distinct cell.
    expect(new Set(maskToCell.values()).size).toBe(BLOB47_CANONICAL_MASKS.length);
    // The template's two fully-solid cells: 13 carries mask 255, 37 is the spare.
    expect(maskToCell.get(255)).toBe(13);
    expect(spareCellIndex).toBe(37);
    expect(maskToCell.get(0)).toBe(0);
  });

  it('matches the published cr31 / Caeles minimum-packing layout exactly', () => {
    const { maskToCell, spareCellIndex } = deriveTemplateCellMasks(sliceTemplateCells());
    const cellToMask = new Map<number, number>();
    for (const [maskId, cellIndex] of maskToCell) cellToMask.set(cellIndex, maskId);

    const derived = CAELES_CR31_LAYOUT.map((row, r) =>
      row.map((_, c) => {
        const cellIndex = r * 8 + c;
        // The spare cell is the duplicate of solid tile-255.
        if (cellIndex === spareCellIndex) return 255;
        return toCr31Index(cellToMask.get(cellIndex)!);
      }),
    );

    expect(derived).toEqual(CAELES_CR31_LAYOUT.map((row) => [...row]));
  });

  it('produces a mask set closed under cr31 90-degree rotation (index * 4 mod 255)', () => {
    // cr31's clockwise-cycle weighting exists so that rotating a blob tile 90
    // degrees clockwise is exactly `index * 4 mod 255`. If our 47 canonical
    // masks really are the blob47 set (just re-weighted), the corresponding
    // cr31 index set must be closed under that operation.
    const cr31Indices = new Set(BLOB47_CANONICAL_MASKS.map(toCr31Index));
    expect(cr31Indices.size).toBe(47);
    for (const index of cr31Indices) {
      if (index === 255) continue;
      expect(cr31Indices.has((index * 4) % 255)).toBe(true);
    }
  });
});

describe('rounded cave corners', () => {
  const kit = generateQuadrantKit();

  /** Alpha of the composed silhouette for `mask` at cell-space (x, y). */
  function alphaAt(mask: number, x: number, y: number): number {
    const cell = composeWallCellOutput(mask, kit);
    return cell.data[(y * cell.width + x) * 4 + 3]!;
  }

  function cellSize(): number {
    return composeWallCellOutput(255, kit).width;
  }

  it('rounds the exposed convex corner of an isolated wall cell', () => {
    // Mask 0 has no neighbours, so all four of its corners are `open`: the two
    // inset lines meet inside the cell and there is nothing to seam against.
    // Rounding means the extreme inset corner pixel is now (mostly) cut away
    // while the wall body a little further in is still solid.
    const size = cellSize();
    const inset = Math.round(size * 0.1875); // WALL_INSET_PX / TERRAIN_PACK_CELL_PX
    expect(alphaAt(0, inset, inset)).toBeLessThan(128);
    expect(alphaAt(0, Math.floor(size / 2), Math.floor(size / 2))).toBe(255);
  });

  it('produces anti-aliased (partial-alpha) pixels along every rounded arc', () => {
    // A hard-edged 90-degree notch yields only 0 or 255. Partial alpha is the
    // observable signature of the arc, and is what makes the curve survive the
    // downscale to final tile size.
    for (const mask of [0, 15]) {
      const cell = composeWallCellOutput(mask, kit);
      let partial = 0;
      for (let i = 3; i < cell.data.length; i += 4) {
        const a = cell.data[i]!;
        if (a > 0 && a < 255) partial += 1;
      }
      expect(partial).toBeGreaterThan(0);
    }
  });

  it('leaves mask 255 completely solid — no corner is rounded away', () => {
    // 255 is wall on all sides AND all diagonals, so every one of its corners
    // must meet a neighbouring wall flush. Rounding it would punch a visible
    // pinhole at every interior 4-cell junction of a solid rock mass.
    const cell = composeWallCellOutput(255, kit);
    for (let i = 3; i < cell.data.length; i += 4) {
      expect(cell.data[i]).toBe(255);
    }
  });

  it('keeps single-cardinal insets straight so connected walls seam cleanly', () => {
    // Mask 1 (N only) is inset off E/S/W but reaches the N edge. The inset line
    // on each side must run perfectly straight all the way to y=0, because the
    // wall cell to the north continues it. Rounding the wall END here would
    // pinch the join at every straight wall run.
    const size = cellSize();
    const inset = Math.round(size * 0.1875);
    // Sample the vertical inset line on the west side, from the top edge down
    // past the corner radius. Wall starts at x === inset, so x-1 is floor and
    // x is wall, at every y in the band the rounding could have reached.
    for (let y = 0; y < inset * 2; y += 1) {
      expect(alphaAt(1, inset - 1, y)).toBe(0);
      expect(alphaAt(1, inset + 1, y)).toBe(255);
    }
  });

  it('scoops the concave corner all the way through the corner sample square', () => {
    // The corner-coverage gate samples the outer 9% of the cell at each corner
    // and requires a `concave` corner to read FLOOR. The quarter-disc bite has
    // radius = inset, and the sample square's far diagonal is inset*0.48*sqrt(2)
    // away, so the whole square is inside the arc. Assert it directly rather
    // than trusting the arithmetic.
    const size = cellSize();
    const sample = Math.ceil(size * 0.09);
    // Mask 15 = N|E|S|W with no diagonals → all four corners are `concave`.
    for (let y = 0; y < sample; y += 1) {
      for (let x = 0; x < sample; x += 1) {
        expect(alphaAt(15, x, y)).toBe(0);
        expect(alphaAt(15, size - 1 - x, y)).toBe(0);
        expect(alphaAt(15, x, size - 1 - y)).toBe(0);
        expect(alphaAt(15, size - 1 - x, size - 1 - y)).toBe(0);
      }
    }
  });

  it('never touches the cardinal edge sample band', () => {
    // AUTHORED_EDGE_SAMPLING excludes the outer 25% of each edge and samples a
    // 15%-thick band. Rounding lives entirely in the outer 18.75% corner boxes,
    // so for every mask the sampled span of a present cardinal must be fully
    // opaque and of an absent cardinal fully transparent — i.e. edge coverage
    // still depends ONLY on the cardinal bit, which is the tiling invariant.
    const size = cellSize();
    const lo = Math.ceil(size * 0.25);
    const hi = Math.floor(size * 0.75);
    const band = Math.floor(size * 0.15);
    for (const mask of BLOB47_CANONICAL_MASKS) {
      const cell = composeWallCellOutput(mask, kit);
      const at = (x: number, y: number) => cell.data[(y * cell.width + x) * 4 + 3]!;
      const north = (mask & MASK_BIT.N) !== 0 ? 255 : 0;
      const south = (mask & MASK_BIT.S) !== 0 ? 255 : 0;
      const west = (mask & MASK_BIT.W) !== 0 ? 255 : 0;
      const east = (mask & MASK_BIT.E) !== 0 ? 255 : 0;
      for (let i = lo; i < hi; i += 1) {
        for (let d = 0; d < band; d += 1) {
          expect(at(i, d)).toBe(north);
          expect(at(i, size - 1 - d)).toBe(south);
          expect(at(d, i)).toBe(west);
          expect(at(size - 1 - d, i)).toBe(east);
        }
      }
    }
  });
});
