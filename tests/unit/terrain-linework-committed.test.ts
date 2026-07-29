/**
 * Join-contract guard for the COMMITTED industrial linework atlases.
 *
 * Linework is a 2-edge Wang path set: a tile's frame is chosen purely from which
 * of its four neighbours are also occupied, so any two neighbours that agree
 * about their shared edge WILL be drawn adjacent. The art therefore has to
 * satisfy a hard contract, and it is checkable pixel-for-pixel rather than by
 * eye:
 *
 * 1. Every mask that declares an edge connected must paint the IDENTICAL bytes
 *    on that edge's boundary row/column. If a corner's north edge differs from a
 *    straight's north edge by even one pixel, every corner-to-straight join in
 *    the map shows a seam.
 * 2. Every mask that declares an edge unconnected must paint NOTHING on it,
 *    otherwise a run leaks art into a tile that is not part of the run.
 * 3. The opaque part of a connected edge must lie inside the stub span declared
 *    in the manifest, which is what lets the renderer and future art changes
 *    reason about the profile without re-deriving it.
 * 4. Alpha is binary pack-wide.
 *
 * These are the properties that make coherence an invariant instead of a
 * tunable, so they are asserted against the shipped bytes — not against the
 * generator, which could drift from what is committed.
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodePng } from '../../scripts/sprites/terrain-packs/png-buffer.js';
import { EDGE_WANG_FRAME_COUNT } from '../../src/shared/terrain-pack-mask.js';
import type { TerrainPackDef } from '../../src/shared/terrain-pack-types.js';

function repoRoot(): string {
  return path.resolve(import.meta.dirname, '..', '..');
}

const MANIFEST_PATH = path.join(
  repoRoot(),
  'src',
  'shared',
  'data',
  'terrain-packs',
  'industrial-cave.manifest.json',
);

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as TerrainPackDef;

/** N/E/S/W in the same bit order the renderer derives its mask in. */
const EDGES = [
  { name: 'N', bit: 1 },
  { name: 'E', bit: 2 },
  { name: 'S', bit: 4 },
  { name: 'W', bit: 8 },
] as const;

interface Atlas {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
}

/**
 * The RGBA bytes along one boundary edge of one frame, as a comparable string.
 *
 * Boundary rows are read from the outermost pixel line, which is exactly the
 * line that abuts the neighbouring tile.
 */
function edgeBytes(atlas: Atlas, frame: number, cell: number, edgeName: string): string {
  const out: number[] = [];
  for (let i = 0; i < cell; i++) {
    let x: number;
    let y: number;
    if (edgeName === 'N') {
      x = i;
      y = 0;
    } else if (edgeName === 'S') {
      x = i;
      y = cell - 1;
    } else if (edgeName === 'W') {
      x = 0;
      y = i;
    } else {
      x = cell - 1;
      y = i;
    }
    const p = (y * atlas.width + frame * cell + x) * 4;
    const a = atlas.data[p + 3] ?? 0;
    // Fully transparent pixels carry undefined colour, so normalise them.
    out.push(
      a,
      a === 0 ? 0 : (atlas.data[p] ?? 0),
      a === 0 ? 0 : (atlas.data[p + 1] ?? 0),
      a === 0 ? 0 : (atlas.data[p + 2] ?? 0),
    );
  }
  return out.join(',');
}

function edgeOpaqueRange(
  atlas: Atlas,
  frame: number,
  cell: number,
  edgeName: string,
): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < cell; i++) {
    const x = edgeName === 'W' ? 0 : edgeName === 'E' ? cell - 1 : i;
    const y = edgeName === 'N' ? 0 : edgeName === 'S' ? cell - 1 : i;
    const p = (y * atlas.width + frame * cell + x) * 4;
    if ((atlas.data[p + 3] ?? 0) === 0) continue;
    if (i < min) min = i;
    if (i > max) max = i;
  }
  return min === Number.POSITIVE_INFINITY ? null : { min, max };
}

const layers = manifest.linework ?? [];

describe('committed industrial linework atlases', () => {
  it('ships at least one linework layer', () => {
    expect(layers.length).toBeGreaterThan(0);
  });

  for (const layer of layers) {
    describe(layer.id, () => {
      const atlas = decodePng(readFileSync(path.join(repoRoot(), 'public', layer.imagePath)));
      const cell = layer.cellPx;

      it('is a complete 16-frame edge-Wang set at the declared cell size', () => {
        expect(layer.frames).toBe(EDGE_WANG_FRAME_COUNT);
        expect(atlas.height).toBe(cell);
        expect(atlas.width).toBe(cell * EDGE_WANG_FRAME_COUNT);
      });

      it('uses binary alpha only', () => {
        for (let i = 3; i < atlas.data.length; i += 4) {
          const a = atlas.data[i] ?? 0;
          if (a !== 0 && a !== 255) {
            throw new Error(`non-binary alpha ${a} at byte ${i}`);
          }
        }
      });

      it('leaves the empty frame empty', () => {
        for (let y = 0; y < cell; y++) {
          for (let x = 0; x < cell; x++) {
            expect(atlas.data[(y * atlas.width + x) * 4 + 3] ?? 0).toBe(0);
          }
        }
      });

      it('paints one identical stub on every connected edge OF THE SAME AXIS', () => {
        // Real neighbours abut N-against-S and E-against-W — never N against
        // another N. Comparing each edge only against itself passes happily
        // while every join on the map shows a colour step, so the reference
        // profile is shared per AXIS: {N,S} read left-to-right by x, {E,W} read
        // top-to-bottom by y, which is exactly how the two abutting lines meet.
        const axes: ReadonlyArray<{ axis: string; edges: ReadonlyArray<(typeof EDGES)[number]> }> =
          [
            { axis: 'vertical', edges: [EDGES[0], EDGES[2]] },
            { axis: 'horizontal', edges: [EDGES[1], EDGES[3]] },
          ];
        for (const { axis, edges } of axes) {
          let reference: string | undefined;
          for (const edge of edges) {
            for (let mask = 0; mask < EDGE_WANG_FRAME_COUNT; mask++) {
              if ((mask & edge.bit) === 0) continue;
              const bytes = edgeBytes(atlas, mask, cell, edge.name);
              if (reference === undefined) reference = bytes;
              else if (bytes !== reference) {
                throw new Error(
                  `${layer.id}: mask ${mask} edge ${edge.name} differs from the other ${axis} connected edges`,
                );
              }
            }
          }
          expect(reference).toBeDefined();
          expect(reference).not.toMatch(/^(0,0,0,0,)*0,0,0,0$/);
        }
      });

      it('paints nothing on an unconnected edge', () => {
        for (const edge of EDGES) {
          for (let mask = 0; mask < EDGE_WANG_FRAME_COUNT; mask++) {
            if ((mask & edge.bit) !== 0) continue;
            expect(edgeOpaqueRange(atlas, mask, cell, edge.name)).toBeNull();
          }
        }
      });

      it('keeps every connected edge inside the declared stub span', () => {
        const lo = layer.stubOffsetPx;
        const hi = layer.stubOffsetPx + layer.stubWidthPx - 1;
        for (const edge of EDGES) {
          for (let mask = 0; mask < EDGE_WANG_FRAME_COUNT; mask++) {
            if ((mask & edge.bit) === 0) continue;
            const range = edgeOpaqueRange(atlas, mask, cell, edge.name);
            expect(range).not.toBeNull();
            expect(range!.min).toBeGreaterThanOrEqual(lo);
            expect(range!.max).toBeLessThanOrEqual(hi);
          }
        }
      });

      const props = layer.props;
      if (props) {
        describe(`${layer.id} props`, () => {
          const propAtlas = decodePng(
            readFileSync(path.join(repoRoot(), 'public', props.imagePath)),
          );

          it('holds every frame this layer may draw', () => {
            expect(propAtlas.height).toBe(props.cellPx);
            expect(propAtlas.width).toBeGreaterThanOrEqual(
              (props.frameStart + props.frames) * props.cellPx,
            );
          });

          it('uses binary alpha only', () => {
            for (let i = 3; i < propAtlas.data.length; i += 4) {
              const a = propAtlas.data[i] ?? 0;
              if (a !== 0 && a !== 255) {
                throw new Error(`non-binary alpha ${a} at byte ${i}`);
              }
            }
          });

          it('has visible art in every frame this layer may draw', () => {
            for (let f = props.frameStart; f < props.frameStart + props.frames; f++) {
              let opaque = 0;
              for (let y = 0; y < props.cellPx; y++) {
                for (let x = 0; x < props.cellPx; x++) {
                  const p = (y * propAtlas.width + f * props.cellPx + x) * 4;
                  if ((propAtlas.data[p + 3] ?? 0) !== 0) opaque++;
                }
              }
              expect(opaque).toBeGreaterThan(0);
            }
          });
        });
      }
    });
  }
});
