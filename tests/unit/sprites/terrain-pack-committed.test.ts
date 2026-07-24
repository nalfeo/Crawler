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
} from '../../../scripts/sprites/terrain-packs/validate.js';
import { decodePng } from '../../../scripts/sprites/terrain-packs/png-buffer.js';
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
});
