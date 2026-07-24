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
 * The compatible-boundary edge check at the 1.0 authored floor is also the
 * durable proof that the crenellation geometry fix (uniform inset wall
 * silhouettes — see quadrant-kit.ts) is present in the SHIPPED atlas: a
 * crenellated/mis-edged atlas cannot classify all 4×47 edges correctly.
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

  it('the SHIPPED (generated) atlas meets the 100% authored edge-compatibility floor (crenellation-fix proof)', () => {
    // A crenellated / mis-edged silhouette cannot classify all 4×47 cardinal
    // edges against the mask-0/mask-255 references, so 1.0 here is durable proof
    // the shipped generated art preserves the corrected blob47 wall geometry.
    const atlas = decodePng(readCommittedAtlas(manifest));
    const result = validateCompatibleBoundaries(manifest, atlas, { minEdgePassRate: 1.0 });
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
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
