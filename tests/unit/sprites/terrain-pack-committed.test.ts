/**
 * Validation guard for the COMMITTED, SHIPPED `industrial-cave` terrain pack —
 * the runtime source of truth loaded by `src/shared/terrain-pack-registry.ts`.
 *
 * The sibling `terrain-pack-build.test.ts` suite validates the in-memory
 * `buildIndustrialCavePack()` output (the PROCEDURAL placeholder builder). But
 * the shipped Floor 2 art is Azure gpt-image-1-generated pixels composed over
 * the blob47 silhouettes and committed under
 * `public/assets/terrain-packs/industrial-cave/` — those bytes are NOT the
 * builder's output (the procedural writer is env-guarded so it can't clobber
 * them). Nothing else asserts the committed manifest + PNGs are valid, so a bad
 * edit to the committed manifest (or a corrupted/regenerated atlas) would ship
 * green. This suite reads the committed artifact from disk and validates it
 * independently of the builder.
 *
 * The compatible-boundary edge check at the 1.0 authored floor asserts every
 * cardinal (N/E/S/W) edge of all 47 masks classifies correctly against the
 * mask-0/mask-255 references — precisely the defect class of the crenellation
 * bug (a notched wall top fails its north-edge classification). A dedicated
 * silhouette test below adds a *direct* anti-crenellation guard (exposed wall
 * faces must be a single flat band, not battlements) so the fix is locked
 * beyond the aggregate cardinal-edge metric.
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  validateManifestSchema,
  validateMaskCoverage,
  validateAtlasDimensions,
  validateCompatibleBoundaries,
  validateWallAutotileImagePath,
  validatePoolAndDoorImages,
  validateWallAccentImagePaths,
  validateWallAccentTopology,
  validateCrossPackWallSilhouettes,
} from '../../../scripts/sprites/terrain-packs/validate.js';
import { decodePng } from '../../../scripts/sprites/terrain-packs/png-buffer.js';
import {
  BORDER_MARGIN_PX,
  rebuildSharedBasePools,
  processWallAccents,
  restyleWallAtlas,
} from '../../../scripts/sprites/terrain-packs/rebuild-shared-base-pools.js';
import type { TerrainPackDef } from '../../../src/shared/terrain-pack-types.js';

function repoRoot(): string {
  return path.resolve(import.meta.dirname, '..', '..', '..');
}

const COMMITTED_MANIFEST_PATH = path.join(
  repoRoot(),
  'src',
  'shared',
  'data',
  'terrain-packs',
  'industrial-cave.manifest.json',
);

function readCommittedManifest(): TerrainPackDef {
  return JSON.parse(readFileSync(COMMITTED_MANIFEST_PATH, 'utf-8')) as TerrainPackDef;
}

function readCommittedAtlas(manifest: TerrainPackDef): Buffer {
  return readFileSync(path.join(repoRoot(), 'public', manifest.wallAutotile.imagePath));
}

type DecodedAtlas = ReturnType<typeof decodePng>;

function artMetrics(image: DecodedAtlas): {
  mean: number;
  stdDev: number;
  meanChroma: number;
  maxChroma: number;
  colorCount: number;
  binaryAlpha: boolean;
} {
  let count = 0;
  let luminanceSum = 0;
  let luminanceSquaredSum = 0;
  let chromaSum = 0;
  let maxChroma = 0;
  let binaryAlpha = true;
  const colors = new Set<string>();
  for (let index = 0; index < image.data.length; index += 4) {
    const alpha = image.data[index + 3] ?? 0;
    if (alpha !== 0 && alpha !== 255) binaryAlpha = false;
    if (alpha === 0) continue;
    const red = image.data[index] ?? 0;
    const green = image.data[index + 1] ?? 0;
    const blue = image.data[index + 2] ?? 0;
    const luminance = 0.299 * red + 0.587 * green + 0.114 * blue;
    const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
    count++;
    luminanceSum += luminance;
    luminanceSquaredSum += luminance * luminance;
    chromaSum += chroma;
    maxChroma = Math.max(maxChroma, chroma);
    colors.add(`${red},${green},${blue}`);
  }
  const mean = count === 0 ? 0 : luminanceSum / count;
  return {
    mean,
    stdDev: count === 0 ? 0 : Math.sqrt(Math.max(0, luminanceSquaredSum / count - mean * mean)),
    meanChroma: count === 0 ? 0 : chromaSum / count,
    maxChroma,
    colorCount: colors.size,
    binaryAlpha,
  };
}

function frameForMask(manifest: TerrainPackDef, maskId: number): number {
  const mask = manifest.wallAutotile.masks.find((m) => m.maskId === maskId);
  if (!mask) throw new Error(`committed manifest is missing blob47 mask ${maskId}`);
  return mask.frameIndex;
}

/**
 * Contiguous horizontal opaque runs (alpha > threshold) in row `y` of the
 * 64px wall cell at `frameIndex`. A flat wall face yields exactly one run; a
 * crenellated / battlemented edge splits into two or more.
 */
function cellRowRuns(
  atlas: DecodedAtlas,
  manifest: TerrainPackDef,
  frameIndex: number,
  y: number,
  alphaThreshold = 16,
): number[] {
  const { cellPx, gridCols } = manifest.wallAutotile;
  const col = frameIndex % gridCols;
  const row = Math.floor(frameIndex / gridCols);
  const runs: number[] = [];
  let run = 0;
  for (let x = 0; x < cellPx; x += 1) {
    const gx = col * cellPx + x;
    const gy = row * cellPx + y;
    const alpha = atlas.data[(gy * atlas.width + gx) * 4 + 3] ?? 0;
    if (alpha > alphaThreshold) {
      run += 1;
    } else if (run > 0) {
      runs.push(run);
      run = 0;
    }
  }
  if (run > 0) runs.push(run);
  return runs;
}

function firstOpaqueRow(atlas: DecodedAtlas, manifest: TerrainPackDef, frameIndex: number): number {
  for (let y = 0; y < manifest.wallAutotile.cellPx; y += 1) {
    if (cellRowRuns(atlas, manifest, frameIndex, y).length > 0) return y;
  }
  return -1;
}

describe('committed industrial-cave terrain pack (runtime source of truth)', () => {
  const repoRoot_ = repoRoot();
  const manifest = readCommittedManifest();

  it('committed manifest passes the strict Zod schema', () => {
    const result = validateManifestSchema(manifest);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('committed manifest carries exactly the 47 canonical blob47 masks', () => {
    const result = validateMaskCoverage(manifest);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(manifest.wallAutotile.masks).toHaveLength(47);
  });

  it('every committed pool/door PNG exists on disk at 64×64 under assets/terrain-packs/', () => {
    const result = validatePoolAndDoorImages(manifest, { repoRoot: repoRoot_ });
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('every floor/corridor variant is the shared base plus interior-only detail', () => {
    // COHESION IS STRUCTURAL, NOT MEASURED. Every pool variant is `<surface>-0`
    // with a detail patch stamped strictly inside a border margin, so all
    // variants share byte-identical border pixels and a cross-variant seam is
    // arithmetically the base's own self-seam. The 2026-07-25 design generated
    // each variant from an INDEPENDENT Azure generation — each tiled against
    // ITSELF but never against a sibling, giving ~3x cross-seam delta (relative
    // to self-seam) and the quilt the human rejected. The independence is what
    // hurt: variants cut as quadrants of ONE generation share global tone and
    // palette and measure far milder (Floor 1 measured 1.2-1.6x its interior
    // baseline). That milder failure is still unbounded, which is why this pack
    // makes the property structural rather than merely small. These assertions
    // lock the replacement.
    // LUMINANCE BOUNDS TRACK THE APPROVED VALUE HIERARCHY. These were originally
    // calibrated when the floor sat below the wall. The design was later flipped
    // (ADR: wall/floor separation comes from STRUCTURE, not from making the wall
    // brighter — the floor is now the brightest broad surface, generated at
    // FLOOR_TILE.targetMeanLuminance = 74, corridor 8 below it). The old ceilings
    // of 54/40 would drag the floor back down toward wall luminance and undo that
    // flip. The bands below are tight around the generator's targets so they still
    // catch drift, and the ordering invariant is asserted separately after this
    // loop — that ordering, not any single absolute number, is the actual law.
    for (const [label, pool, limits] of [
      ['floor', manifest.floorPool, { minMean: 66, maxMean: 82, maxStdDev: 12, maxChroma: 24 }],
      [
        'corridor',
        manifest.corridorPool,
        { minMean: 58, maxMean: 74, maxStdDev: 12, maxChroma: 24 },
      ],
    ] as const) {
      expect(pool, `${label} pool`).toHaveLength(8);
      const base = pool[0]!;
      expect(base.id, `${label} base id`).toBe(`${label}-0`);
      const baseImage = decodePng(readFileSync(path.join(repoRoot_, 'public', base.imagePath)));
      const baseMetrics = artMetrics(baseImage);
      expect(baseImage.width, `${label} base width`).toBe(64);
      expect(baseImage.height, `${label} base height`).toBe(64);

      for (const variant of pool) {
        const image = decodePng(readFileSync(path.join(repoRoot_, 'public', variant.imagePath)));
        const metrics = artMetrics(image);
        expect(metrics.mean, `${variant.id} mean`).toBeGreaterThanOrEqual(limits.minMean);
        expect(metrics.mean, `${variant.id} mean`).toBeLessThanOrEqual(limits.maxMean);
        // Detail is injected as deviation from the detail source's OWN mean, so
        // the base's exposure must survive it.
        expect(
          Math.abs(metrics.mean - baseMetrics.mean),
          `${variant.id} mean drift from base (${metrics.mean} vs ${baseMetrics.mean})`,
        ).toBeLessThanOrEqual(1.5);
        expect(metrics.stdDev, `${variant.id} stddev`).toBeLessThanOrEqual(limits.maxStdDev);
        // Scale-invariant companion to the absolute ceiling above. The absolute
        // number was calibrated when the bases sat at stdDev ~3.5; the pixel-art
        // restyle deliberately raised them to ~7.3, so 12 is now a much tighter
        // multiple of base than originally intended and would stop catching
        // runaway detail if a future base got darker/flatter. This ratio pins the
        // actual intent — a detail variant may add texture, never dominate.
        expect(
          metrics.stdDev,
          `${variant.id} stddev vs base ratio (${metrics.stdDev} / ${baseMetrics.stdDev})`,
        ).toBeLessThanOrEqual(baseMetrics.stdDev * 2);
        expect(metrics.maxChroma, `${variant.id} chroma`).toBeLessThanOrEqual(limits.maxChroma);
        expect(metrics.binaryAlpha, `${variant.id} alpha`).toBe(true);

        // Border ring must be byte-identical to the base — this is the property
        // that makes cohesion provable rather than probabilistic.
        for (let y = 0; y < 64; y += 1) {
          for (let x = 0; x < 64; x += 1) {
            const inBorder =
              x < BORDER_MARGIN_PX ||
              y < BORDER_MARGIN_PX ||
              x >= 64 - BORDER_MARGIN_PX ||
              y >= 64 - BORDER_MARGIN_PX;
            if (!inBorder) continue;
            const i = (y * 64 + x) * 4;
            for (let ch = 0; ch < 4; ch += 1) {
              expect(
                image.data[i + ch],
                `${variant.id} border pixel (${x},${y}) channel ${ch}`,
              ).toBe(baseImage.data[i + ch]);
            }
          }
        }

        if (variant.id === base.id) continue;
        // FALSE-POSITIVE GUARD. A detail mask that fits to ~0 emits a
        // byte-identical copy of the base — and every structural validator,
        // seam check and luminance guard still passes green, because a perfect
        // copy of a valid tile is itself valid. That shipped once (a
        // `smoothstep` that returned 0 for descending ranges). Assert the
        // interior actually differs.
        let changedInteriorPixels = 0;
        for (let y = BORDER_MARGIN_PX; y < 64 - BORDER_MARGIN_PX; y += 1) {
          for (let x = BORDER_MARGIN_PX; x < 64 - BORDER_MARGIN_PX; x += 1) {
            const i = (y * 64 + x) * 4;
            if (
              image.data[i] !== baseImage.data[i] ||
              image.data[i + 1] !== baseImage.data[i + 1] ||
              image.data[i + 2] !== baseImage.data[i + 2]
            ) {
              changedInteriorPixels += 1;
            }
          }
        }
        expect(changedInteriorPixels, `${variant.id} interior detail pixels`).toBeGreaterThan(40);
        expect(metrics.stdDev, `${variant.id} stddev vs base`).toBeGreaterThan(baseMetrics.stdDev);
      }
    }
  });

  it('the ground reads brighter than the wall (approved value hierarchy)', () => {
    // THE ACTUAL LAW. Wall/floor separation in this pack comes from structure —
    // silhouette, contact shadow, facet lighting — and the ground is deliberately
    // the brightest broad surface. An earlier iteration inverted this and the
    // human's verdict was "walls read as floors". A single absolute luminance
    // ceiling on the floor cannot express that; this ordering can, and it fails
    // loudly if anyone re-flips the hierarchy.
    const wallMean = artMetrics(decodePng(readCommittedAtlas(manifest))).mean;
    const floorMean = artMetrics(
      decodePng(readFileSync(path.join(repoRoot_, 'public', manifest.floorPool[0]!.imagePath))),
    ).mean;
    const corridorMean = artMetrics(
      decodePng(readFileSync(path.join(repoRoot_, 'public', manifest.corridorPool[0]!.imagePath))),
    ).mean;
    expect(floorMean - wallMean, 'floor minus wall mean luma').toBeGreaterThanOrEqual(20);
    expect(corridorMean - wallMean, 'corridor minus wall mean luma').toBeGreaterThanOrEqual(12);
    expect(floorMean, 'floor mean vs corridor mean').toBeGreaterThan(corridorMean);
  });

  it('pool weights keep the plain base and quiet variant dominant', () => {
    for (const [label, pool] of [
      ['floor', manifest.floorPool],
      ['corridor', manifest.corridorPool],
    ] as const) {
      const weights = pool.map((variant) => variant.weight ?? 1);
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      const quietShare = ((weights[0] ?? 0) + (weights[1] ?? 0)) / total;
      expect(quietShare, `${label} base+quiet share`).toBeGreaterThanOrEqual(0.65);
      expect(quietShare, `${label} base+quiet share`).toBeLessThanOrEqual(0.85);
      expect(weights[0], `${label} base weight`).toBeGreaterThanOrEqual(weights[1] ?? 0);
      for (let i = 2; i < weights.length; i += 1) {
        expect(weights[i], `${label} detail weight ${i}`).toBeLessThan(weights[1] ?? 1);
      }
    }
  });

  it('ground decals carry crack structure that spans more than one tile', () => {
    const decalSets = manifest.groundDecals;
    expect(decalSets, 'pack declares groundDecals').toBeDefined();
    if (!decalSets) return;
    expect(decalSets.length, 'decal set count').toBeGreaterThanOrEqual(2);
    // A single set leaves visible bands of untouched ground wherever its anchor
    // lattice misses line up, so the pack must ship lattices of differing pitch.
    expect(new Set(decalSets.map((s) => s.strideTiles)).size, 'distinct decal strides').toBe(
      decalSets.length,
    );

    for (const decals of decalSets) {
      const label = `${decals.spanTiles}x decals`;
      const atlas = decodePng(readFileSync(path.join(repoRoot_, 'public', decals.imagePath)));
      expect(atlas.height, `${label} atlas height`).toBe(decals.cellPx);
      expect(atlas.width, `${label} atlas width`).toBe(decals.cellPx * decals.frames);
      expect(artMetrics(atlas).binaryAlpha, `${label} alpha`).toBe(true);

      const tilePx = decals.cellPx / decals.spanTiles;
      const masks: Uint8Array[] = [];
      for (let frame = 0; frame < decals.frames; frame += 1) {
        const x0 = frame * decals.cellPx;
        // Flood-fill the opaque pixels of this frame and measure the largest
        // connected component. This is the whole reason ground decals exist: a
        // pool tile's border is byte-restored from the shared base, so no pool
        // feature can cross a tile edge. A decal whose biggest connected mark
        // fits inside one tile would be indistinguishable from pool detail and
        // would silently fail the "cracks span tiles" requirement.
        const seen = new Uint8Array(decals.cellPx * decals.cellPx);
        const mask = new Uint8Array(decals.cellPx * decals.cellPx);
        const opaqueAt = (x: number, y: number): boolean =>
          x >= 0 &&
          y >= 0 &&
          x < decals.cellPx &&
          y < decals.cellPx &&
          atlas.data[(y * atlas.width + x0 + x) * 4 + 3] === 255;
        let bestSpan = 0;
        let opaque = 0;
        for (let sy = 0; sy < decals.cellPx; sy += 1) {
          for (let sx = 0; sx < decals.cellPx; sx += 1) {
            if (opaqueAt(sx, sy)) {
              opaque += 1;
              mask[sy * decals.cellPx + sx] = 1;
            }
            if (seen[sy * decals.cellPx + sx] || !opaqueAt(sx, sy)) continue;
            let minX = sx;
            let maxX = sx;
            let minY = sy;
            let maxY = sy;
            const stack = [[sx, sy] as const];
            seen[sy * decals.cellPx + sx] = 1;
            while (stack.length > 0) {
              const [cx, cy] = stack.pop()!;
              if (cx < minX) minX = cx;
              if (cx > maxX) maxX = cx;
              if (cy < minY) minY = cy;
              if (cy > maxY) maxY = cy;
              for (const [nx, ny] of [
                [cx - 1, cy],
                [cx + 1, cy],
                [cx, cy - 1],
                [cx, cy + 1],
              ] as const) {
                if (!opaqueAt(nx, ny) || seen[ny * decals.cellPx + nx]) continue;
                seen[ny * decals.cellPx + nx] = 1;
                stack.push([nx, ny]);
              }
            }
            bestSpan = Math.max(bestSpan, maxX - minX + 1, maxY - minY + 1);
          }
        }
        expect(bestSpan, `${label} frame ${frame} largest connected mark span`).toBeGreaterThan(
          tilePx,
        );
        // Decals draw ON the ground, so they must stay a mark and never become a
        // second opaque ground layer that hides the pool art underneath.
        const coverage = opaque / (decals.cellPx * decals.cellPx);
        expect(coverage, `${label} frame ${frame} coverage`).toBeGreaterThan(0.01);
        expect(coverage, `${label} frame ${frame} coverage`).toBeLessThan(0.45);
        masks.push(mask);
      }

      // Frames are cut from the SAME material, so a densest-first selection with
      // no spatial suppression happily returns near-identical overlapping
      // windows — the atlas then advertises N variants but draws one crack N
      // times, which is the exact repetition decals exist to break.
      for (let a = 0; a < masks.length; a += 1) {
        for (let b = a + 1; b < masks.length; b += 1) {
          let inter = 0;
          let union = 0;
          for (let i = 0; i < masks[a]!.length; i += 1) {
            const inA = masks[a]![i] === 1;
            const inB = masks[b]![i] === 1;
            if (inA && inB) inter += 1;
            if (inA || inB) union += 1;
          }
          const jaccard = union === 0 ? 0 : inter / union;
          expect(jaccard, `${label} frames ${a}/${b} similarity`).toBeLessThan(0.5);
        }
      }
    }
  });

  it('ground decal strokes are bold and free of interior pinholes', () => {
    const decalSets = manifest.groundDecals;
    expect(decalSets, 'pack declares groundDecals').toBeDefined();
    if (!decalSets) return;

    for (const decals of decalSets) {
      const label = `${decals.spanTiles}x decals`;
      const atlas = decodePng(readFileSync(path.join(repoRoot_, 'public', decals.imagePath)));
      const size = decals.cellPx;
      let thinRuns = 0;
      let runs = 0;
      let specks = 0;

      for (let frame = 0; frame < decals.frames; frame += 1) {
        const x0 = frame * size;
        const opaqueAt = (x: number, y: number): boolean =>
          atlas.data[(y * atlas.width + x0 + x) * 4 + 3] === 255;

        // A 1px-wide horizontal run is a hairline: at the pack's 1:1..2:1 material
        // scale it renders as a single screen pixel and reads as noise, not a crack.
        for (let y = 0; y < size; y += 1) {
          let run = 0;
          for (let x = 0; x <= size; x += 1) {
            if (x < size && opaqueAt(x, y)) {
              run += 1;
              continue;
            }
            if (run > 0) {
              runs += 1;
              if (run === 1) thinRuns += 1;
            }
            run = 0;
          }
        }

        // Flood the transparent background in from the frame border; anything
        // transparent it cannot reach is enclosed by the decal. Tiny enclosures
        // are the "floor shows through" specks, distinct from the large pockets a
        // forking crack legitimately encircles.
        const reached = new Uint8Array(size * size);
        const stack: number[] = [];
        const push = (x: number, y: number): void => {
          const i = y * size + x;
          if (reached[i] === 1 || opaqueAt(x, y)) return;
          reached[i] = 1;
          stack.push(i);
        };
        for (let i = 0; i < size; i += 1) {
          push(i, 0);
          push(i, size - 1);
          push(0, i);
          push(size - 1, i);
        }
        while (stack.length > 0) {
          const i = stack.pop()!;
          const x = i % size;
          const y = (i - x) / size;
          if (x > 0) push(x - 1, y);
          if (x < size - 1) push(x + 1, y);
          if (y > 0) push(x, y - 1);
          if (y < size - 1) push(x, y + 1);
        }
        const counted = new Uint8Array(size * size);
        for (let y = 0; y < size; y += 1) {
          for (let x = 0; x < size; x += 1) {
            const start = y * size + x;
            if (reached[start] === 1 || counted[start] === 1 || opaqueAt(x, y)) continue;
            const comp: number[] = [start];
            counted[start] = 1;
            for (let head = 0; head < comp.length; head += 1) {
              const i = comp[head]!;
              const cx = i % size;
              const cy = (i - cx) / size;
              for (const [nx, ny] of [
                [cx - 1, cy],
                [cx + 1, cy],
                [cx, cy - 1],
                [cx, cy + 1],
              ] as const) {
                if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
                const j = ny * size + nx;
                if (counted[j] === 1 || reached[j] === 1 || opaqueAt(nx, ny)) continue;
                counted[j] = 1;
                comp.push(j);
              }
            }
            if (comp.length <= 2) specks += 1;
          }
        }
      }

      expect(specks, `${label} enclosed 1-2px transparent specks`).toBe(0);
      expect(thinRuns / runs, `${label} share of 1px-wide strokes`).toBeLessThan(0.08);
    }
  });

  it('wall accents are binary-alpha, restrained overlays inside the base silhouette', () => {
    const pathResult = validateWallAccentImagePaths(manifest, { repoRoot: repoRoot_ });
    expect(pathResult.issues).toEqual([]);
    const wallAtlas = decodePng(readCommittedAtlas(manifest));
    for (const accent of manifest.wallAccents ?? []) {
      const accentAtlas = decodePng(readFileSync(path.join(repoRoot_, 'public', accent.imagePath)));
      const metrics = artMetrics(accentAtlas);
      expect(metrics.binaryAlpha, `${accent.id} alpha`).toBe(true);
      expect(metrics.mean, `${accent.id} mean`).toBeGreaterThanOrEqual(35);
      expect(metrics.mean, `${accent.id} mean`).toBeLessThanOrEqual(60);
      expect(metrics.stdDev, `${accent.id} stddev`).toBeLessThanOrEqual(25);
      expect(metrics.maxChroma, `${accent.id} chroma`).toBeLessThanOrEqual(60);
      expect(metrics.colorCount, `${accent.id} color count`).toBeLessThanOrEqual(160);
      expect(
        validateWallAccentTopology(manifest, wallAtlas, accentAtlas, accent.id).issues,
      ).toEqual([]);
    }
  });

  it('the committed wall atlas exists on disk at the pinned 512×384 and is path-safe', () => {
    const result = validateWallAutotileImagePath(manifest, { repoRoot: repoRoot_ });
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('the SHIPPED (generated) atlas decodes at exactly 512×384 (8×6 × 64px)', () => {
    const atlas = decodePng(readCommittedAtlas(manifest));
    const result = validateAtlasDimensions(manifest, atlas);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(atlas.width).toBe(512);
    expect(atlas.height).toBe(384);
  });

  it('the SHIPPED (generated) atlas meets the 100% authored cardinal-edge-compatibility floor', () => {
    // Every N/E/S/W edge of all 47 masks must classify against the mask-0/mask-255
    // references. This is the crenellation bug's defect class (a notched top fails
    // its north edge); the silhouette test below adds a direct anti-crenellation guard.
    const atlas = decodePng(readCommittedAtlas(manifest));
    const result = validateCompatibleBoundaries(manifest, atlas, { minEdgePassRate: 1.0 });
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('cross-pack compatibility compares canonical wall silhouettes by alpha', () => {
    const atlas = decodePng(readCommittedAtlas(manifest));
    expect(validateCrossPackWallSilhouettes(manifest, atlas, manifest, atlas).issues).toEqual([]);

    const incompatible = { ...atlas, data: Buffer.from(atlas.data) };
    incompatible.data[3] = incompatible.data[3] === 0 ? 255 : 0;
    const result = validateCrossPackWallSilhouettes(manifest, atlas, manifest, incompatible);
    expect(result.issues.some((issue) => issue.code === 'cross-pack-silhouette-mismatch')).toBe(
      true,
    );
  });

  it('the SHIPPED wall silhouettes have flat, non-crenellated exposed faces', () => {
    // Direct anti-crenellation guard (complements the aggregate edge-pass rate,
    // which only samples cardinal edges): the original bug notched the exposed
    // wall top into per-quadrant battlements.
    //
    // We use mask 10 (E|W, N absent) — a straight exposed north cap spanning
    // the full cell width. With the OLD edge-band geometry, all four quadrants
    // produce separate top strips, which creates TWO separated horizontal runs
    // at the first opaque row (one left strip, one right strip with a gap
    // between them). With the fixed uniform WALL_INSET_PX geometry, the entire
    // north face is one clean horizontal run of length 1.
    //
    // Mask 0 (all absent) is NOT used here: its four `open` inner squares
    // already produce a single central horizontal run under the old geometry, so
    // `cellRowRuns(mask 0) === 1` is TRUE for both the buggy and fixed versions,
    // making it unable to distinguish them.
    //
    // An interior cell (mask 255) stays a single full-width run as a sanity
    // check.
    const atlas = decodePng(readCommittedAtlas(manifest));

    // N=1, E=2, S=4, W=8 → E|W = 10 (N absent: exposed north face)
    const ewCapFrame = frameForMask(manifest, 10);
    const topRow = firstOpaqueRow(atlas, manifest, ewCapFrame);
    expect(topRow).toBeGreaterThanOrEqual(0);
    for (let y = topRow; y < topRow + 4; y += 1) {
      expect(cellRowRuns(atlas, manifest, ewCapFrame, y), `mask 10 row ${y}`).toHaveLength(1);
    }

    const solidFrame = frameForMask(manifest, 255);
    const solidMidRow = manifest.wallAutotile.cellPx >> 1;
    expect(cellRowRuns(atlas, manifest, solidFrame, solidMidRow)).toHaveLength(1);
  });

  it('provenance truthfully records the Azure-generated, locally-composed origin', () => {
    expect(manifest.provenance.kind).toBe('authored');
    if (manifest.provenance.kind === 'authored') {
      // Guards the honest provenance note from silent reversion to a "procedural"
      // description that would misrepresent the shipped art's real origin.
      expect(manifest.provenance.author).toMatch(/gpt-image-1/i);
      expect(manifest.provenance.derivationNote).toMatch(/gpt-image-1/i);
      expect(manifest.provenance.derivationNote.length).toBeGreaterThan(20);
    }
  });

  // The derivation pipeline is two stages: `import-floor2-materials.ts` writes
  // raw material (floor-0, corridor-0, variant strips, accents) and
  // `rebuild-shared-base-pools.ts` derives the pools, restyles the wall atlas
  // and applies the lighting pass. Running only the import ships raw
  // pre-lighting material whose pool borders no longer match the new base — the
  // floor renders as speckle on a visible grid. That state once shipped
  // undetected in this session because nothing but the running game caught it.
  //
  // Asserting the committed art is a FIXED POINT of the rebuild catches the
  // import-only state, a stale derivation (pools derived from a superseded
  // base), and hand edits TO DERIVED FILES — as one byte-exact invariant with
  // no separate marker to keep in sync.
  //
  // Scope: this covers only what the rebuild re-emits (pools + wall atlas, plus
  // any accent that currently fails its chroma threshold). Source art the
  // rebuild does not regenerate — the ground-decal atlases and in-threshold
  // accents — is guarded STRUCTURALLY instead, by the decal and accent tests
  // above. The explicit coverage assertion below exists so this guard cannot
  // silently degrade to near-zero if a derivation stops emitting files.
  it('committed pack art is a fixed point of the shared-base rebuild', () => {
    const derived = [...rebuildSharedBasePools(), ...processWallAccents(), ...restyleWallAtlas()];
    const derivedPaths = new Set(derived.map((f) => path.basename(f.relPath)));

    // Every pool variant the manifest ships must be re-emitted by the rebuild —
    // except each pool's index-0 entry, which IS the shared base the others are
    // derived from and is therefore an input, not an output. Without this the
    // suite would still pass if `rebuildSharedBasePools()` regressed to
    // emitting a single file.
    const poolPaths = [...manifest.floorPool, ...manifest.corridorPool]
      .filter((v) => !/-0$/.test(v.id))
      .map((v) => path.basename(v.imagePath));
    expect(poolPaths.length).toBeGreaterThan(0);
    for (const p of poolPaths) {
      expect(derivedPaths.has(p), `${p} is re-emitted by the rebuild`).toBe(true);
    }
    expect(
      derivedPaths.has(path.basename(manifest.wallAutotile.imagePath)),
      'wall atlas is re-emitted by the rebuild',
    ).toBe(true);

    for (const file of derived) {
      const onDisk = readFileSync(path.join(repoRoot(), file.relPath));
      expect(
        onDisk.equals(file.bytes),
        `${file.relPath} differs from its rebuild output — the art pipeline was ` +
          `run partially or the file was edited by hand. Re-run ` +
          `scripts/sprites/terrain-packs/import-floor2-materials.ts.`,
      ).toBe(true);
    }
  });
});
