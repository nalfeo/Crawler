/**
 * Deterministic validator for an assembled terrain pack: schema-shape checks,
 * exact-47-mask coverage, dimension pinning, and a documented
 * "compatible-boundary" edge-consistency check used in place of exact RGBA
 * seam matching (appropriate for the vendored line-art fixture; the spec
 * explicitly allows this when byte-exact seam matching is inappropriate).
 *
 * Compatible-boundary check design
 * ---------------------------------
 * A cell's 4 edges (N/E/S/W) are each expected to be either "solid" (this
 * cell connects to a same-type neighbour on that side) or "open" (it does
 * not), purely as a function of the corresponding cardinal bit of its
 * canonical mask — diagonal bits never affect straight edges. For each cell:
 *   1. Sample the mean luminance of a band along each edge (see
 *      `edge-signature.ts` for the exact band geometry — the authored and
 *      vendored packs use different, independently-tuned sampling configs)
 *      against two references: the mask=0 cell (nothing connected — "open"
 *      reference) and the mask=255 cell (fully surrounded — "solid"
 *      reference).
 *   2. Classify the edge as whichever reference it is closer to.
 *   3. Assert the classification agrees with the cardinal bit expected from
 *      the mask.
 * The pass-rate threshold is a documented, provenance-scoped constant (see
 * `AUTHORED_MIN_EDGE_PASS_RATE` / `VENDORED_MIN_EDGE_PASS_RATE` below) — 1.0
 * for the authored pack (provable by construction from the quadrant-kit
 * compositor), and a lower, still-honest floor for the vendored fixture
 * (real external line art, greedily assigned — see `build-caeles-fixture.ts`
 * for the assignment algorithm and its measured pass rate).
 */
import { z } from 'zod';
import path from 'node:path';
import { statSync, readFileSync } from 'node:fs';
import {
  BLOB47_CANONICAL_MASKS,
  edgeConnectionsFromMask,
  isCanonicalBlob47Mask,
} from '../../../src/shared/terrain-pack-mask.js';
import {
  terrainPackDefSchema,
  TERRAIN_PACK_CELL_PX,
  type TerrainPackDef,
  type TransformId,
} from '../../../src/shared/terrain-pack-types.js';
import { ATLAS_HEIGHT_PX, ATLAS_WIDTH_PX } from './atlas-grid.js';
import {
  CELL_EDGES,
  buildEdgeReferences,
  classifyCellEdges,
  AUTHORED_EDGE_SAMPLING,
  VENDORED_EDGE_SAMPLING,
} from './edge-signature.js';
import {
  CELL_CORNERS,
  buildCornerReferences,
  classifyCellCorners,
  expectedCorners,
  AUTHORED_CORNER_SAMPLING,
  VENDORED_CORNER_SAMPLING,
} from './corner-signature.js';
import { signatureDistance } from './sample-signature.js';
import { cropImage, decodePng, type RgbaImage } from './png-buffer.js';
import { validateDeclaredTransforms } from './transform-eligibility.js';
import { isWallAlpha } from './wall-opacity.js';
import { composeWallCellOutput } from './compose-wall-cell.js';
import { generateQuadrantKit } from './quadrant-kit.js';

export interface ValidationIssue {
  readonly code: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly issues: readonly ValidationIssue[];
}

function fail(issues: ValidationIssue[], code: string, message: string): void {
  issues.push({ code, message });
}

/** Validate a manifest object against the strict Zod schema. Returns parsed issues (not throw). */
export function validateManifestSchema(manifestJson: unknown): ValidationResult {
  const result = terrainPackDefSchema.safeParse(manifestJson);
  if (result.success) {
    return { ok: true, issues: [] };
  }
  const issues = result.error.issues.map((issue: z.ZodIssue) => ({
    code: 'schema',
    message: `${issue.path.join('.')}: ${issue.message}`,
  }));
  return { ok: false, issues };
}

/**
 * Validate a manifest object that was produced by the generation CLI, where
 * the pack `id` may be a not-yet-registered string (floor1-dungeon / floor1-cave
 * are generated before their IDs are added to TERRAIN_PACK_IDS and manifests
 * committed). All fields other than `id` are validated against the same strict
 * schema as `validateManifestSchema`; only the `id` check is relaxed to accept
 * any non-empty string.
 */
export function validateGenManifestSchema(manifestJson: unknown): ValidationResult {
  const relaxedSchema = terrainPackDefSchema.extend({ id: z.string().min(1) });
  const result = relaxedSchema.safeParse(manifestJson);
  if (result.success) {
    return { ok: true, issues: [] };
  }
  const issues = result.error.issues.map((issue: z.ZodIssue) => ({
    code: 'schema',
    message: `${issue.path.join('.')}: ${issue.message}`,
  }));
  return { ok: false, issues };
}

/** Validate the atlas PNG's dimensions match the manifest's declared grid + cell size. */
export function validateAtlasDimensions(
  manifest: TerrainPackDef,
  atlas: RgbaImage,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const expectedWidth = manifest.wallAutotile.gridCols * manifest.wallAutotile.cellPx;
  const expectedHeight = manifest.wallAutotile.gridRows * manifest.wallAutotile.cellPx;
  if (atlas.width !== expectedWidth || atlas.height !== expectedHeight) {
    fail(
      issues,
      'atlas-dimensions',
      `Atlas is ${atlas.width}x${atlas.height}, expected ${expectedWidth}x${expectedHeight}`,
    );
  }
  if (manifest.wallAutotile.cellPx !== TERRAIN_PACK_CELL_PX) {
    fail(
      issues,
      'cell-size',
      `cellPx must be ${TERRAIN_PACK_CELL_PX}, got ${manifest.wallAutotile.cellPx}`,
    );
  }
  if (atlas.width !== ATLAS_WIDTH_PX || atlas.height !== ATLAS_HEIGHT_PX) {
    fail(
      issues,
      'atlas-fixed-size',
      `Atlas must be the canonical ${ATLAS_WIDTH_PX}x${ATLAS_HEIGHT_PX} (8x6 grid x 64px), got ${atlas.width}x${atlas.height}`,
    );
  }
  return { ok: issues.length === 0, issues };
}

/** Validate the manifest's 47 mask entries are exactly the canonical set, no duplicates/missing. */
export function validateMaskCoverage(manifest: TerrainPackDef): ValidationResult {
  const issues: ValidationIssue[] = [];
  const maskIds = manifest.wallAutotile.masks.map((m) => m.maskId);
  const uniqueMaskIds = new Set(maskIds);
  if (uniqueMaskIds.size !== 47) {
    fail(issues, 'mask-count', `Expected exactly 47 unique maskIds, got ${uniqueMaskIds.size}`);
  }
  if (maskIds.length !== uniqueMaskIds.size) {
    fail(
      issues,
      'mask-duplicate',
      `Duplicate maskId entries present (${maskIds.length} entries, ${uniqueMaskIds.size} unique)`,
    );
  }
  for (const maskId of maskIds) {
    if (!isCanonicalBlob47Mask(maskId)) {
      fail(
        issues,
        'mask-not-canonical',
        `maskId ${maskId} is not one of the 47 canonical blob47 masks`,
      );
    }
  }
  for (const canonical of BLOB47_CANONICAL_MASKS) {
    if (!uniqueMaskIds.has(canonical)) {
      fail(issues, 'mask-missing', `Canonical mask ${canonical} missing from manifest`);
    }
  }
  const frameIndices = manifest.wallAutotile.masks.map((m) => m.frameIndex);
  if (new Set(frameIndices).size !== frameIndices.length) {
    fail(issues, 'frame-duplicate', 'Duplicate frameIndex entries present');
  }
  return { ok: issues.length === 0, issues };
}

export interface CompatibleBoundaryOptions {
  /** Minimum fraction of the 4*47 edge samples that must classify correctly. Documented, not silently relaxed. */
  readonly minEdgePassRate: number;
}

/**
 * Compatible-boundary validator (see module doc). Requires the atlas image
 * plus the manifest's mask->frame table so each cell can be located and its
 * canonical mask known.
 */
export function validateCompatibleBoundaries(
  manifest: TerrainPackDef,
  atlas: RgbaImage,
  options: CompatibleBoundaryOptions = { minEdgePassRate: 1.0 },
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const { cellPx, gridCols } = manifest.wallAutotile;

  const cellFor = (frameIndex: number): RgbaImage => {
    const col = frameIndex % gridCols;
    const row = Math.floor(frameIndex / gridCols);
    return cropImage(atlas, col * cellPx, row * cellPx, cellPx, cellPx);
  };

  const maskToFrame = new Map(manifest.wallAutotile.masks.map((m) => [m.maskId, m.frameIndex]));
  const openFrame = maskToFrame.get(0);
  const solidFrame = maskToFrame.get(255);
  if (openFrame === undefined || solidFrame === undefined) {
    fail(
      issues,
      'boundary-reference-missing',
      'Compatible-boundary check requires mask 0 (open) and mask 255 (solid) reference cells',
    );
    return { ok: false, issues };
  }
  const samplingConfig =
    manifest.provenance.kind === 'authored' ? AUTHORED_EDGE_SAMPLING : VENDORED_EDGE_SAMPLING;
  const refs = buildEdgeReferences(cellFor(openFrame), cellFor(solidFrame), samplingConfig);

  let total = 0;
  let passed = 0;
  for (const { maskId, frameIndex } of manifest.wallAutotile.masks) {
    const cell = cellFor(frameIndex);
    const connections = edgeConnectionsFromMask(maskId);
    const classified = classifyCellEdges(cell, refs, samplingConfig);
    for (const edge of CELL_EDGES) {
      total += 1;
      if (classified[edge] === connections[edge]) {
        passed += 1;
      }
    }
  }
  const passRate = total === 0 ? 1 : passed / total;
  if (passRate < options.minEdgePassRate) {
    fail(
      issues,
      'boundary-mismatch',
      `Compatible-boundary edge pass rate ${passRate.toFixed(3)} below required ${options.minEdgePassRate} (${passed}/${total})`,
    );
  }
  return { ok: issues.length === 0, issues };
}

export interface CompatibleCornerOptions {
  /** Minimum fraction of the 4*47 corner samples that must classify correctly. */
  readonly minCornerPassRate: number;
}

/**
 * Corner-coverage validator — the diagonal-side counterpart to
 * `validateCompatibleBoundaries`.
 *
 * The cardinal edge check above cannot see diagonal information at all: every
 * cell sharing the same four cardinal bits has identical edge bands, so a
 * 16-tile cardinal-only sheet replicated across the 47 blob47 slots passes it
 * at 1.000. Two real defects shipped through exactly that blind spot:
 *   - the generated industrial-cave atlas collapsed to 16 distinct silhouettes
 *     across 47 slots (16 fully-solid cells instead of 1: every inner corner
 *     rendered as flat wall);
 *   - the caeles fixture's greedy cell→mask assignment put full coverage on
 *     masks 223/239 while mask 255 — the one cell that MUST be solid — came out
 *     roughly half floor.
 *
 * This check asserts the thing that actually distinguishes the 47 masks: for
 * each cell, each of the four extreme corners must be wall iff that corner's
 * quadrant state is `full` (both adjacent cardinals AND the diagonal set). See
 * `cornerIsWallFromMask` for the shared semantics.
 */
export function validateCompatibleCorners(
  manifest: TerrainPackDef,
  atlas: RgbaImage,
  options: CompatibleCornerOptions = { minCornerPassRate: 1.0 },
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const { cellPx, gridCols } = manifest.wallAutotile;

  const cellFor = (frameIndex: number): RgbaImage => {
    const col = frameIndex % gridCols;
    const row = Math.floor(frameIndex / gridCols);
    return cropImage(atlas, col * cellPx, row * cellPx, cellPx, cellPx);
  };

  const maskToFrame = new Map(manifest.wallAutotile.masks.map((m) => [m.maskId, m.frameIndex]));
  const openFrame = maskToFrame.get(0);
  const solidFrame = maskToFrame.get(255);
  if (openFrame === undefined || solidFrame === undefined) {
    fail(
      issues,
      'corner-reference-missing',
      'Corner-coverage check requires mask 0 (open) and mask 255 (solid) reference cells',
    );
    return { ok: false, issues };
  }
  const samplingConfig =
    manifest.provenance.kind === 'authored' ? AUTHORED_CORNER_SAMPLING : VENDORED_CORNER_SAMPLING;
  const refs = buildCornerReferences(cellFor(openFrame), cellFor(solidFrame), samplingConfig);

  // Reference sanity. If mask 255's cell is not meaningfully more wall-like at its
  // corners than mask 0's, the nearest-reference classifier is degenerate and every
  // downstream comparison is noise. Report that root cause instead of emitting 47
  // misleading per-cell mismatches (this is exactly how the caeles fixture failed:
  // its greedy assignment put a half-floor cell on mask 255).
  const degenerateCorners = CELL_CORNERS.filter(
    (corner) =>
      signatureDistance(refs.wall[corner], refs.floor[corner]) < MIN_CORNER_REFERENCE_SEPARATION,
  );
  if (degenerateCorners.length > 0) {
    fail(
      issues,
      'corner-reference-degenerate',
      `Corner references are not separable at ${degenerateCorners.join('/')}: the mask-255 (solid) ` +
        `cell must be wall at every corner and the mask-0 (open) cell floor at every corner. ` +
        degenerateCorners
          .map(
            (c) =>
              `${c}: signature distance ${signatureDistance(refs.wall[c], refs.floor[c]).toFixed(1)} ` +
              `(solid-ref opacity ${refs.wall[c].opacity.toFixed(1)}/lum ${refs.wall[c].luminance.toFixed(1)} vs ` +
              `open-ref opacity ${refs.floor[c].opacity.toFixed(1)}/lum ${refs.floor[c].luminance.toFixed(1)})`,
          )
          .join('; '),
    );
    return { ok: false, issues };
  }

  let total = 0;
  let passed = 0;
  const mismatchExamples: string[] = [];
  for (const { maskId, frameIndex } of manifest.wallAutotile.masks) {
    const expected = expectedCorners(maskId);
    const classified = classifyCellCorners(cellFor(frameIndex), refs, samplingConfig);
    for (const corner of CELL_CORNERS) {
      total += 1;
      if (classified[corner] === expected[corner]) {
        passed += 1;
      } else if (mismatchExamples.length < 8) {
        mismatchExamples.push(
          `mask ${maskId} (frame ${frameIndex}) corner ${corner}: expected ` +
            `${expected[corner] ? 'wall' : 'floor'}, atlas shows ${classified[corner] ? 'wall' : 'floor'}`,
        );
      }
    }
  }
  const passRate = total === 0 ? 1 : passed / total;
  if (passRate < options.minCornerPassRate) {
    fail(
      issues,
      'corner-mismatch',
      `Corner-coverage pass rate ${passRate.toFixed(3)} below required ${options.minCornerPassRate} ` +
        `(${passed}/${total}). Examples: ${mismatchExamples.join('; ')}`,
    );
  }
  return { ok: issues.length === 0, issues };
}

/**
 * Exact-silhouette validator — authored packs only.
 *
 * Both sampling gates above are PERIMETER gates. `validateCompatibleBoundaries`
 * reads four cardinal edge bands, `validateCompatibleCorners` reads four corner
 * squares; between them they touch eight small windows around a cell's rim and
 * nothing else. A defect confined to a cell's interior — a donut hole, a stray
 * block of erased pixels, a hand edit in the middle of the tile — scores a
 * perfect 1.000 on both. That is not hypothetical: the procedural generator
 * once carved the `concave` notch at the CELL CENTRE instead of the outer
 * corner, rendering mask 15 as a donut, and every sampling gate passed it.
 *
 * For an authored pack the silhouette is not a judgement call — it is a pure
 * function of the mask set, `composeWallCellOutput(maskId, kit)`. So compare it
 * exactly: thresholded alpha, every pixel, no tolerance. This subsumes both
 * perimeter gates for authored packs and closes the interior blind spot.
 *
 * Vendored packs are deliberately exempt: their art is external and only
 * approximately mask-compatible, which is what the classifier gates exist to
 * measure.
 */
export function validateAuthoredSilhouetteExact(
  manifest: TerrainPackDef,
  atlas: RgbaImage,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (manifest.provenance.kind !== 'authored') return { ok: true, issues };

  const { cellPx, gridCols } = manifest.wallAutotile;
  const kit = generateQuadrantKit();

  for (const { maskId, frameIndex } of manifest.wallAutotile.masks) {
    const expected = composeWallCellOutput(maskId, kit);
    if (expected.width !== cellPx || expected.height !== cellPx) {
      fail(
        issues,
        'authored-silhouette-size',
        `Canonical cell for mask ${maskId} is ${expected.width}x${expected.height} but the ` +
          `manifest declares cellPx ${cellPx}`,
      );
      return { ok: false, issues };
    }
    const col = frameIndex % gridCols;
    const row = Math.floor(frameIndex / gridCols);
    const actual = cropImage(atlas, col * cellPx, row * cellPx, cellPx, cellPx);

    let mismatches = 0;
    let firstX = -1;
    let firstY = -1;
    for (let i = 3; i < expected.data.length; i += 4) {
      if (isWallAlpha(actual.data[i] ?? 0) === isWallAlpha(expected.data[i]!)) continue;
      mismatches += 1;
      if (firstX < 0) {
        const pixel = (i - 3) / 4;
        firstX = pixel % cellPx;
        firstY = Math.floor(pixel / cellPx);
      }
    }
    if (mismatches > 0) {
      fail(
        issues,
        'authored-silhouette-mismatch',
        `Mask ${maskId} (frame ${frameIndex}) differs from its canonical silhouette in ` +
          `${mismatches} pixel(s), first at (${firstX}, ${firstY}). An authored wall silhouette ` +
          `must equal composeWallCellOutput(maskId) exactly — re-run the pack's rebuild script ` +
          `rather than hand-editing wall-atlas.png.`,
      );
    }
  }
  return { ok: issues.length === 0, issues };
}

/**
 * Documented compatible-boundary pass-rate floors, per provenance kind.
 *
 * `authored` packs are provably edge-compatible by construction (the
 * quadrant-kit compositor guarantees a cardinal edge's wall/no-wall coverage
 * depends only on that cardinal bit — see `quadrant-kit.ts`), so 100% is
 * required and any regression there is a real bug.
 *
 * `vendored` packs are assembled from real external line art we do not
 * control, so they cannot be expected to hit 100%. The caeles fixture measures
 * **0.957 (180/188)**, and the 8 residual misses are a single, well-understood
 * class rather than noise: every one is a `wall -> floor` misread, exactly two
 * per compass direction, confined to masks {1, 2, 4, 5, 8, 10} — the four
 * single-arm stubs plus the two straight corridors. Hand-drawn line art draws a
 * wall reached by one narrow arm thin, so that edge band is mostly floor with a
 * thin stroke through it and this mean-based classifier reads floor. Every
 * corner (3/6/9/12), T (7/11/13/14) and 15 pass. That fuzziness is inherent to
 * the artwork, not a mapping defect, which is exactly what this relaxed floor
 * exists to tolerate.
 *
 * 0.90 leaves 10 samples of headroom below the measured rate — enough that a
 * future re-import which thins a few more arms won't false-trip, while still
 * failing loudly on a regressed cell->mask assignment (a blind/positional
 * assignment measures ~0.55-0.65 on the same fixture).
 *
 * Note this check is no longer the primary defence against a scrambled
 * assignment: `validateCompatibleCorners` requires 1.0 for BOTH provenance
 * kinds and is discrete rather than fuzzy, so it catches a bad mapping harder
 * and sooner. This floor is a secondary signal.
 *
 * (Was 0.85, calibrated when the caeles cell->mask table came from a greedy
 * search. That search is gone — the table is now derived from the artwork
 * itself and cross-checked against the published cr31 layout — which lifted the
 * measured rate and left the old floor with 20 samples of unnecessary slack.)
 */
const AUTHORED_MIN_EDGE_PASS_RATE = 1.0;
const VENDORED_MIN_EDGE_PASS_RATE = 0.9;

/**
 * Minimum corner-signature separation (Euclidean over mean-alpha and
 * mean-luminance, both on the 0-255 scale) required between the mask-0 and
 * mask-255 corner references before the nearest-reference classifier is
 * trusted. Well below the real separation of a correct pack (an alpha-clean
 * pack separates by ~255 on opacity alone), but high enough to catch a
 * degenerate reference cell rather than silently producing noise.
 */
const MIN_CORNER_REFERENCE_SEPARATION = 20;

/**
 * Corner-coverage pass-rate floor.
 *
 * 1.0 for BOTH provenance kinds, unlike the edge check's relaxed vendored
 * floor. Corner semantics are discrete and unambiguous — a corner is wall iff
 * its quadrant state is `full` — and any pack whose cells are mapped to the
 * right masks satisfies this exactly. A vendored pack that cannot reach 1.0
 * here has a wrong cell→mask mapping, which is a real defect, not line-art
 * fuzziness.
 */
const MIN_CORNER_PASS_RATE = 1.0;

function defaultMinEdgePassRateFor(manifest: TerrainPackDef): number {
  return manifest.provenance.kind === 'authored'
    ? AUTHORED_MIN_EDGE_PASS_RATE
    : VENDORED_MIN_EDGE_PASS_RATE;
}

/** Run all validations for an assembled pack (manifest JSON + decoded atlas PNG). */
export function validateTerrainPack(
  manifestJson: unknown,
  atlasPngBytes: Buffer,
  options?: CompatibleBoundaryOptions,
  cornerOptions?: CompatibleCornerOptions,
): ValidationResult {
  const schemaResult = validateManifestSchema(manifestJson);
  if (!schemaResult.ok) {
    return schemaResult;
  }
  const manifest = manifestJson as TerrainPackDef;
  let atlas: RgbaImage;
  try {
    atlas = decodePng(atlasPngBytes);
  } catch (err) {
    return {
      ok: false,
      issues: [{ code: 'atlas-decode-error', message: `Atlas PNG decode failed: ${String(err)}` }],
    };
  }
  const boundaryOptions = options ?? { minEdgePassRate: defaultMinEdgePassRateFor(manifest) };
  const cornerOpts = cornerOptions ?? { minCornerPassRate: MIN_CORNER_PASS_RATE };
  const issues: ValidationIssue[] = [];
  for (const result of [
    validateAtlasDimensions(manifest, atlas),
    validateMaskCoverage(manifest),
    validateCompatibleBoundaries(manifest, atlas, boundaryOptions),
    validateCompatibleCorners(manifest, atlas, cornerOpts),
    validateAuthoredSilhouetteExact(manifest, atlas),
  ]) {
    issues.push(...result.issues);
  }
  return { ok: issues.length === 0, issues };
}

/** Allowed imagePath prefixes (relative to `public/`) for wall atlas, pool, and door images. */
const ALLOWED_IMAGEPATH_PREFIX = 'assets/terrain-packs/';

export interface PoolImageValidationOptions {
  /** Absolute path to the repository root; imagePaths are resolved under `{repoRoot}/public/`. */
  readonly repoRoot: string;
}

/**
 * Validate the wallAutotile.imagePath of a pack manifest: the path must be
 * within `assets/terrain-packs/`, exist on disk, decode as PNG, and have
 * exact dimensions gridCols*cellPx × gridRows*cellPx (512×384 for the
 * canonical 8×6 grid). Path traversal (`..`) is rejected explicitly.
 */
export function validateWallAutotileImagePath(
  manifest: TerrainPackDef,
  options: PoolImageValidationOptions,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const { imagePath, gridCols, gridRows, cellPx } = manifest.wallAutotile;
  const context = 'wallAutotile';
  const normalized = imagePath.replace(/\\/g, '/');

  if (normalized.includes('..')) {
    fail(
      issues,
      'path-traversal',
      `${context}: imagePath contains '..' (path traversal prevented): ${imagePath}`,
    );
    return { ok: false, issues };
  }

  if (!normalized.startsWith(ALLOWED_IMAGEPATH_PREFIX)) {
    fail(
      issues,
      'path-not-in-allowed-root',
      `${context}: imagePath '${imagePath}' must start with '${ALLOWED_IMAGEPATH_PREFIX}'`,
    );
    return { ok: false, issues };
  }

  const absPath = path.join(options.repoRoot, 'public', normalized);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(absPath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      fail(issues, 'image-missing', `${context}: imagePath '${imagePath}' not found at ${absPath}`);
    } else {
      fail(
        issues,
        'image-read-error',
        `${context}: imagePath '${imagePath}' could not be accessed: ${String(err)}`,
      );
    }
    return { ok: false, issues };
  }
  if (!stat.isFile()) {
    fail(
      issues,
      'image-not-file',
      `${context}: imagePath '${imagePath}' exists but is not a regular file at ${absPath}`,
    );
    return { ok: false, issues };
  }

  let pngBytes: Buffer;
  try {
    pngBytes = readFileSync(absPath);
  } catch (err) {
    fail(
      issues,
      'image-read-error',
      `${context}: imagePath '${imagePath}' could not be read: ${String(err)}`,
    );
    return { ok: false, issues };
  }
  let img: RgbaImage;
  try {
    img = decodePng(pngBytes);
  } catch (err) {
    fail(
      issues,
      'image-not-png',
      `${context}: '${imagePath}' could not be decoded as PNG: ${String(err)}`,
    );
    return { ok: false, issues };
  }

  const expectedWidth = gridCols * cellPx;
  const expectedHeight = gridRows * cellPx;
  if (img.width !== expectedWidth || img.height !== expectedHeight) {
    fail(
      issues,
      'image-wrong-size',
      `${context}: '${imagePath}' must be ${expectedWidth}×${expectedHeight} (${gridCols}*${cellPx} by ${gridRows}*${cellPx}), got ${img.width}×${img.height}`,
    );
  }

  return { ok: issues.length === 0, issues };
}

/**
 * Validate every floorPool, corridorPool, and doorSet imagePath in a pack
 * manifest: the path must be within `assets/terrain-packs/`, exist on disk,
 * decode as PNG, and be exactly 64×64 pixels. Path traversal (`..`) is
 * rejected explicitly; no broad catch / silent skip.
 */
export function validatePoolAndDoorImages(
  manifest: TerrainPackDef,
  options: PoolImageValidationOptions,
): ValidationResult {
  const issues: ValidationIssue[] = [];

  type ImageEntry = { imagePath: string; context: string };
  const entries: ImageEntry[] = [
    ...manifest.floorPool.map((v) => ({ imagePath: v.imagePath, context: `floorPool[${v.id}]` })),
    ...manifest.corridorPool.map((v) => ({
      imagePath: v.imagePath,
      context: `corridorPool[${v.id}]`,
    })),
    ...Object.entries(manifest.doorSet).map(([key, v]) => ({
      imagePath: v.imagePath,
      context: `doorSet.${key}`,
    })),
    ...Object.entries(manifest.specialFloorPools ?? {}).flatMap(([key, pool]) =>
      pool.map((v) => ({
        imagePath: v.imagePath,
        context: `specialFloorPools.${key}[${v.id}]`,
      })),
    ),
  ];

  for (const { imagePath, context } of entries) {
    const normalized = imagePath.replace(/\\/g, '/');

    if (normalized.includes('..')) {
      fail(
        issues,
        'path-traversal',
        `${context}: imagePath contains '..' (path traversal prevented): ${imagePath}`,
      );
      continue;
    }

    if (!normalized.startsWith(ALLOWED_IMAGEPATH_PREFIX)) {
      fail(
        issues,
        'path-not-in-allowed-root',
        `${context}: imagePath '${imagePath}' must start with '${ALLOWED_IMAGEPATH_PREFIX}'`,
      );
      continue;
    }

    const absPath = path.join(options.repoRoot, 'public', normalized);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(absPath);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        fail(
          issues,
          'image-missing',
          `${context}: imagePath '${imagePath}' not found at ${absPath}`,
        );
      } else {
        fail(
          issues,
          'image-read-error',
          `${context}: imagePath '${imagePath}' could not be accessed: ${String(err)}`,
        );
      }
      continue;
    }
    if (!stat.isFile()) {
      fail(
        issues,
        'image-not-file',
        `${context}: imagePath '${imagePath}' exists but is not a regular file at ${absPath}`,
      );
      continue;
    }

    let pngBytes: Buffer;
    try {
      pngBytes = readFileSync(absPath);
    } catch (err) {
      fail(
        issues,
        'image-read-error',
        `${context}: imagePath '${imagePath}' could not be read: ${String(err)}`,
      );
      continue;
    }
    let img: RgbaImage;
    try {
      img = decodePng(pngBytes);
    } catch (err) {
      fail(
        issues,
        'image-not-png',
        `${context}: '${imagePath}' could not be decoded as PNG: ${String(err)}`,
      );
      continue;
    }

    if (img.width !== TERRAIN_PACK_CELL_PX || img.height !== TERRAIN_PACK_CELL_PX) {
      fail(
        issues,
        'image-wrong-size',
        `${context}: '${imagePath}' must be ${TERRAIN_PACK_CELL_PX}×${TERRAIN_PACK_CELL_PX}, got ${img.width}×${img.height}`,
      );
    }
  }

  return { ok: issues.length === 0, issues };
}

/**
 * Validate every `groundDecals[]` entry's imagePath: path must be within the
 * allowed asset root, exist on disk, decode as PNG, and have dimensions
 * exactly `cellPx * frames` wide by `cellPx` tall (horizontal sprite atlas).
 * Path traversal (`..`) is rejected explicitly.
 */
export function validateGroundDecalImages(
  manifest: TerrainPackDef,
  options: PoolImageValidationOptions,
): ValidationResult {
  const issues: ValidationIssue[] = [];

  for (const decalSet of manifest.groundDecals ?? []) {
    const context = `groundDecals[${decalSet.textureKey}]`;
    const normalized = decalSet.imagePath.replace(/\\/g, '/');

    if (normalized.includes('..')) {
      fail(
        issues,
        'path-traversal',
        `${context}: imagePath contains '..' (path traversal prevented): ${decalSet.imagePath}`,
      );
      continue;
    }

    if (!normalized.startsWith(ALLOWED_IMAGEPATH_PREFIX)) {
      fail(
        issues,
        'path-not-in-allowed-root',
        `${context}: imagePath '${decalSet.imagePath}' must start with '${ALLOWED_IMAGEPATH_PREFIX}'`,
      );
      continue;
    }

    const absPath = path.join(options.repoRoot, 'public', normalized);
    let pngBytes: Buffer;
    try {
      pngBytes = readFileSync(absPath);
    } catch (err) {
      fail(
        issues,
        'image-missing',
        `${context}: imagePath '${decalSet.imagePath}' could not be read at ${absPath}: ${String(err)}`,
      );
      continue;
    }
    let img: RgbaImage;
    try {
      img = decodePng(pngBytes);
    } catch (err) {
      fail(
        issues,
        'image-not-png',
        `${context}: '${decalSet.imagePath}' could not be decoded as PNG: ${String(err)}`,
      );
      continue;
    }

    const expectedWidth = decalSet.cellPx * decalSet.frames;
    const expectedHeight = decalSet.cellPx;
    if (img.width !== expectedWidth || img.height !== expectedHeight) {
      fail(
        issues,
        'image-wrong-size',
        `${context}: '${decalSet.imagePath}' must be ${expectedWidth}×${expectedHeight} ` +
          `(${decalSet.frames} frames × ${decalSet.cellPx}px), got ${img.width}×${img.height}`,
      );
    }
  }

  return { ok: issues.length === 0, issues };
}

export function validateWallAccentImagePaths(
  manifest: TerrainPackDef,
  options: PoolImageValidationOptions,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const expectedWidth = manifest.wallAutotile.gridCols * manifest.wallAutotile.cellPx;
  const expectedHeight = manifest.wallAutotile.gridRows * manifest.wallAutotile.cellPx;

  for (const accent of manifest.wallAccents ?? []) {
    const context = `wallAccents[${accent.id}]`;
    const normalized = accent.imagePath.replace(/\\/g, '/');

    if (normalized.includes('..')) {
      fail(
        issues,
        'path-traversal',
        `${context}: imagePath contains '..' (path traversal prevented): ${accent.imagePath}`,
      );
      continue;
    }
    if (!normalized.startsWith(ALLOWED_IMAGEPATH_PREFIX)) {
      fail(
        issues,
        'path-not-in-allowed-root',
        `${context}: imagePath '${accent.imagePath}' must start with '${ALLOWED_IMAGEPATH_PREFIX}'`,
      );
      continue;
    }

    const absPath = path.join(options.repoRoot, 'public', normalized);
    let pngBytes: Buffer;
    try {
      pngBytes = readFileSync(absPath);
    } catch (err) {
      fail(
        issues,
        'image-missing',
        `${context}: imagePath '${accent.imagePath}' could not be read at ${absPath}: ${String(err)}`,
      );
      continue;
    }
    let img: RgbaImage;
    try {
      img = decodePng(pngBytes);
    } catch (err) {
      fail(
        issues,
        'image-not-png',
        `${context}: '${accent.imagePath}' could not be decoded as PNG: ${String(err)}`,
      );
      continue;
    }
    if (img.width !== expectedWidth || img.height !== expectedHeight) {
      fail(
        issues,
        'image-wrong-size',
        `${context}: '${accent.imagePath}' must match the wall atlas grid ${expectedWidth}×${expectedHeight}, got ${img.width}×${img.height}`,
      );
    }
  }

  return { ok: issues.length === 0, issues };
}

/**
 * Direct pixel-level "no spill" proof (2026-07-25 refinement #3): for every
 * canonical mask, the accent atlas's cell at that mask's frameIndex must be
 * fully transparent everywhere the WALL atlas's cell at that same frameIndex
 * is transparent. This is what makes "no accent may spill outside valid wall
 * topology" a provable build/validate-time guarantee instead of a
 * convention.
 */
export function validateWallAccentTopology(
  manifest: TerrainPackDef,
  wallAtlas: RgbaImage,
  accentAtlas: RgbaImage,
  accentId: string,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const { cellPx, gridCols } = manifest.wallAutotile;
  const cellFor = (atlas: RgbaImage, frameIndex: number): RgbaImage => {
    const col = frameIndex % gridCols;
    const row = Math.floor(frameIndex / gridCols);
    return cropImage(atlas, col * cellPx, row * cellPx, cellPx, cellPx);
  };

  for (const { maskId, frameIndex } of manifest.wallAutotile.masks) {
    const wallCell = cellFor(wallAtlas, frameIndex);
    const accentCell = cellFor(accentAtlas, frameIndex);
    for (let i = 3; i < wallCell.data.length; i += 4) {
      const wallAlpha = wallCell.data[i] ?? 0;
      const accentAlpha = accentCell.data[i] ?? 0;
      if (wallAlpha === 0 && accentAlpha !== 0) {
        const pixelIndex = (i - 3) / 4;
        fail(
          issues,
          'accent-spill',
          `wallAccents[${accentId}] mask ${maskId} (frame ${frameIndex}): accent pixel ${pixelIndex} is opaque (alpha=${accentAlpha}) where the wall cell is transparent — accent spills outside wall topology`,
        );
        break; // one reported spill per mask is enough signal; don't flood.
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

/**
 * Prove that two packs can share one wall-neighbor topology. Frame indices may
 * differ, but each canonical mask must expose the same opaque silhouette in
 * both atlases so a material boundary cannot create a notch.
 */
export function validateCrossPackWallSilhouettes(
  leftManifest: TerrainPackDef,
  leftAtlas: RgbaImage,
  rightManifest: TerrainPackDef,
  rightAtlas: RgbaImage,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const cellPx = leftManifest.wallAutotile.cellPx;
  if (cellPx !== rightManifest.wallAutotile.cellPx) {
    fail(
      issues,
      'cross-pack-cell-size',
      `${leftManifest.id} and ${rightManifest.id} use different wall cell sizes (${cellPx}px vs ${rightManifest.wallAutotile.cellPx}px)`,
    );
    return { ok: false, issues };
  }

  const leftFrames = new Map(
    leftManifest.wallAutotile.masks.map(({ maskId, frameIndex }) => [maskId, frameIndex]),
  );
  const rightFrames = new Map(
    rightManifest.wallAutotile.masks.map(({ maskId, frameIndex }) => [maskId, frameIndex]),
  );
  const cellFor = (atlas: RgbaImage, manifest: TerrainPackDef, frameIndex: number): RgbaImage => {
    const col = frameIndex % manifest.wallAutotile.gridCols;
    const row = Math.floor(frameIndex / manifest.wallAutotile.gridCols);
    return cropImage(atlas, col * cellPx, row * cellPx, cellPx, cellPx);
  };

  for (const maskId of BLOB47_CANONICAL_MASKS) {
    const leftFrame = leftFrames.get(maskId);
    const rightFrame = rightFrames.get(maskId);
    if (leftFrame === undefined || rightFrame === undefined) continue;
    const leftCell = cellFor(leftAtlas, leftManifest, leftFrame);
    const rightCell = cellFor(rightAtlas, rightManifest, rightFrame);
    for (let alphaIndex = 3; alphaIndex < leftCell.data.length; alphaIndex += 4) {
      const leftOpaque = isWallAlpha(leftCell.data[alphaIndex] ?? 0);
      const rightOpaque = isWallAlpha(rightCell.data[alphaIndex] ?? 0);
      if (leftOpaque !== rightOpaque) {
        const pixelIndex = (alphaIndex - 3) / 4;
        fail(
          issues,
          'cross-pack-silhouette-mismatch',
          `${leftManifest.id} and ${rightManifest.id} disagree on wall mask ${maskId} at pixel ${pixelIndex}`,
        );
        break;
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

/**
 * Validate declared transforms for a single decoded pool image — the actual
 * work; `cli.ts` loops every floorPool/corridorPool variant, decodes its PNG
 * once, and calls this so the pure `transform-eligibility.ts` check runs
 * against real shipped pixels.
 */
export function validateVariantTransformEligibility(
  image: RgbaImage,
  variant: {
    readonly id: string;
    readonly allowedTransforms?: readonly TransformId[];
  },
  poolLabel: string,
): ValidationResult {
  const issues = validateDeclaredTransforms(
    image,
    variant.allowedTransforms ?? ['none'],
    `${poolLabel}[${variant.id}]`,
  ).map((i) => ({ code: i.code, message: i.message }));
  return { ok: issues.length === 0, issues };
}
