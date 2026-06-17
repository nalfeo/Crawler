/**
 * Approve a sprite-pipeline candidate (spec §F7/F8).
 *
 * This module is the ONLY operation in the pipeline that mutates checked-in
 * repo state (`public/assets/generated/` + `manifest.json`). Everything else
 * writes under the gitignored `generated/runs/` tree.
 *
 * Pure-by-construction: `approveVariant` takes every IO call as injected
 * deps so unit tests can run against an in-memory fs without ever touching
 * the real `public/assets/` tree. The CLI and the sidecar both wire in the
 * real `node:fs` functions.
 *
 * Identity model
 * --------------
 *   - `briefId` is the `brief.name` from `brief-schema.ts`, constrained to
 *     `^[a-z0-9][a-z0-9-]*$` (single safe path segment).
 *   - Approved assets are keyed by variant and written as
 *     `public/assets/generated/<briefId>-var-<N>.png`.
 *   - This preserves multiple approved variants per brief instead of
 *     overwriting a single `<briefId>.png` output.
 *
 * Supersede policy
 * ----------------
 *   - **Latest-wins per variant key.** Re-approving the same variant index
 *     replaces that `briefId-var-N` entry in place.
 *   - Different variant indices of the same brief coexist as separate
 *     manifest/catalog entries (`briefId-var-0`, `briefId-var-3`, ...).
 *
 * Anchor source resolution
 * ------------------------
 *   - If `processed/NN.anchor.json` exists (the variant has a derived
 *     anchor), use it with `source: 'derived'`.
 *   - Else, fall back to `chosen.anchor` from `summary.json` (which is
 *     either the brief's static anchor in legacy mode, or null if the
 *     brief opted into derive-mode and derivation failed everywhere).
 *   - If neither is available, the manifest entry's `anchor` is `null`.
 *     The engine treats null as "look up brief default at load time".
 *   - We deliberately stay at the 2-valued source enum (`'derived'` |
 *     `'brief'`) with `null` for "not available"; the speculative
 *     `'derived-failed'` third value isn't currently consumed.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const DEFAULT_FS = {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
};
export const MANIFEST_VERSION = 1;
export class ApproveError extends Error {
  kind;
  constructor(kind, message) {
    super(message);
    this.kind = kind;
    this.name = 'ApproveError';
  }
}
/**
 * Approve one variant of one run. Pure given (`now`, `fs`).
 *
 * Steps:
 *   1. Load and validate `summary.json` in `runDir`.
 *   2. Locate the candidate entry by `variantIndex`.
 *   3. Verify the processed PNG exists.
 *   4. Copy PNG → `publicAssetsDir/generated/<briefId>.png` (overwrite OK).
 *   5. Load + upsert + write `manifest.json` (creates it if missing).
 *   6. Return the new manifest entry.
 *
 * Throws `ApproveError` with a discriminated `kind` for callers (sidecar
 * route handler, CLI) to translate into HTTP status / exit codes.
 */
export function approveVariant(options) {
  const fs = options.fs ?? DEFAULT_FS;
  const now = options.now ?? (() => new Date());
  const summaryPath = path.join(options.runDir, 'summary.json');
  if (!fs.existsSync(summaryPath)) {
    throw new ApproveError('run-not-found', `Run directory has no summary.json: ${options.runDir}`);
  }
  const summary = parseSummary(fs.readFileSync(summaryPath, 'utf8'), summaryPath);
  const briefId = summary.brief;
  if (!briefId) {
    throw new ApproveError('summary-invalid', `summary.json has no "brief" field: ${summaryPath}`);
  }
  const candidate = (summary.candidates ?? []).find((c) => c.index === options.variantIndex);
  if (!candidate) {
    throw new ApproveError(
      'variant-not-found',
      `Variant ${options.variantIndex} not in summary.json candidates ` +
        `(have: ${(summary.candidates ?? []).map((c) => c.index).join(', ') || 'none'})`,
    );
  }
  const padded = padIndex(options.variantIndex);
  const processedDir = path.join(options.runDir, 'processed');
  const processedPng = path.join(processedDir, `${padded}.png`);
  if (!fs.existsSync(processedPng)) {
    throw new ApproveError(
      'processed-missing',
      `Processed PNG not found for variant ${options.variantIndex}: ${processedPng}`,
    );
  }
  // Asset destination. Flat layout under public/assets/generated/.
  // Use variant-specific ID so multiple variants per brief coexist.
  const variantId = `${briefId}-var-${options.variantIndex}`;
  const generatedDir = path.join(options.publicAssetsDir, 'generated');
  fs.mkdirSync(generatedDir, { recursive: true });
  const assetAbsPath = path.join(generatedDir, `${variantId}.png`);
  fs.copyFileSync(processedPng, assetAbsPath);
  // Anchor: prefer the per-variant derived sidecar, fall back to chosen.anchor.
  const anchors = resolveAnchors(
    fs,
    processedDir,
    padded,
    candidate.derivedAnchors?.hold ?? candidate.derivedAnchor ?? null,
    candidate.derivedAnchors?.centerOfGravity ?? null,
    summary.chosen?.anchor ?? null,
    summary.chosen?.anchors?.centerOfGravity ?? null,
  );
  const sensorScore =
    typeof candidate.score === 'number' && typeof candidate.outOf === 'number'
      ? `${candidate.score}/${candidate.outOf}`
      : 'unknown';
  const judgeScore =
    typeof candidate.judgeScorecard?.minScore === 'number'
      ? String(candidate.judgeScorecard.minScore)
      : null;
  const entry = {
    briefId,
    spriteName: briefId,
    // Forward slashes so the engine can pass this straight to a URL/loader.
    assetPath: `generated/${variantId}.png`,
    approvedAt: now().toISOString(),
    sourceRun: toRepoRelativePosix(options.repoRoot, options.runDir),
    variantIndex: options.variantIndex,
    anchor: anchors.hold,
    anchors,
    sensorScore,
    judgeScore,
  };
  upsertManifest(fs, options.manifestPath, entry, variantId);
  upsertCatalog(fs, options.catalogPath, entry, variantId);
  return entry;
}
/**
 * Read + upsert + write the manifest atomically (best-effort). The manifest
 * file is small and tracked in git; pretty-printing with stable key order
 * keeps diffs reviewable.
 */
function upsertManifest(fs, manifestPath, entry, entryKey) {
  let current;
  if (fs.existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (parsed.version !== MANIFEST_VERSION) {
        throw new ApproveError(
          'manifest-invalid',
          `Unsupported manifest version: ${String(parsed.version)} (expected ${MANIFEST_VERSION})`,
        );
      }
      current = {
        version: MANIFEST_VERSION,
        entries: { ...(parsed.entries ?? {}) },
      };
    } catch (err) {
      if (err instanceof ApproveError) throw err;
      throw new ApproveError(
        'manifest-invalid',
        `manifest.json is not parseable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    current = { version: MANIFEST_VERSION, entries: {} };
  }
  // Stable key order: sort keys so multiple approvals don't shuffle the file.
  const nextEntries = { ...current.entries, [entryKey]: entry };
  const sortedKeys = Object.keys(nextEntries).sort();
  const sorted = {};
  for (const key of sortedKeys) {
    sorted[key] = nextEntries[key];
  }
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const next = { version: MANIFEST_VERSION, entries: sorted };
  fs.writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
}
/**
 * Convert manifest entry to catalog entry and upsert into catalog.json.
 * Catalog entries need additional fields for the game, so we construct the full entry here.
 */
function upsertCatalog(fs, catalogPath, manifestEntry, catalogId) {
  let catalog;
  if (fs.existsSync(catalogPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
      catalog = Array.isArray(raw) ? raw : [];
    } catch (_err) {
      console.warn(`Could not parse catalog (${catalogPath}), starting fresh`);
      catalog = [];
    }
  } else {
    catalog = [];
  }
  // Create catalog entry from manifest entry
  const catalogEntry = {
    id: `generated:${catalogId}`,
    kind: 'sprite',
    label: manifestEntry.spriteName,
    description: `Generated sprite from brief: ${manifestEntry.briefId}.`,
    tags: ['generated', 'pipeline-approved'],
    spriteId: manifestEntry.spriteName,
    sheetKey: 'generated-manifest',
    assetPath: manifestEntry.assetPath,
    frame: 0,
    col: 0,
    row: 0,
  };
  // Remove existing entry with same ID if present, then add new one
  const filtered = catalog.filter((e) => e.id !== catalogEntry.id);
  filtered.push(catalogEntry);
  filtered.sort((a, b) => {
    const aKind = a.kind === 'sheet' ? 0 : 1;
    const bKind = b.kind === 'sheet' ? 0 : 1;
    if (aKind !== bKind) return aKind - bKind;
    const aId = typeof a.id === 'string' ? a.id : '';
    const bId = typeof b.id === 'string' ? b.id : '';
    return aId.localeCompare(bId);
  });
  // Write updated catalog
  fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
  fs.writeFileSync(catalogPath, `${JSON.stringify(filtered, null, 2)}\n`);
}
function parseSummary(raw, summaryPath) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ApproveError(
      'summary-invalid',
      `summary.json is not parseable (${summaryPath}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
function resolveAnchors(
  fs,
  processedDir,
  paddedIndex,
  candidateHoldAnchor,
  candidateCenterOfGravityAnchor,
  chosenAnchor,
  chosenCenterOfGravityAnchor,
) {
  const sidecarPath = path.join(processedDir, `${paddedIndex}.anchor.json`);
  const centerOfGravitySidecarPath = path.join(processedDir, `${paddedIndex}.anchor.cog.json`);
  const hold = resolveSingleAnchor(fs, sidecarPath, candidateHoldAnchor, chosenAnchor);
  const centerOfGravity = resolveSingleAnchor(
    fs,
    centerOfGravitySidecarPath,
    candidateCenterOfGravityAnchor,
    chosenCenterOfGravityAnchor,
  );
  return { hold, centerOfGravity };
}
function resolveSingleAnchor(fs, sidecarPath, candidateDerivedAnchor, chosenAnchor) {
  if (fs.existsSync(sidecarPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
      if (typeof raw.x === 'number' && typeof raw.y === 'number') {
        return { x: raw.x, y: raw.y, source: 'derived' };
      }
    } catch {
      // Fall through to other sources; a corrupt sidecar shouldn't block approval.
    }
  }
  // Sensor scorecard's derivedAnchor (mirrored in summary.json) is the
  // same source-of-truth as the sidecar file. Use it if the sidecar JSON
  // is missing or unreadable.
  if (candidateDerivedAnchor) {
    return { x: candidateDerivedAnchor.x, y: candidateDerivedAnchor.y, source: 'derived' };
  }
  // Legacy mode: brief.anchor applies to every variant uniformly.
  if (chosenAnchor && chosenAnchor.source === 'brief') {
    return { x: chosenAnchor.x, y: chosenAnchor.y, source: 'brief' };
  }
  // Derive-mode + derivation failed for this variant. The engine should
  // fall back to brief default at load time; nothing useful to record here.
  return null;
}
function padIndex(index) {
  return String(index).padStart(2, '0');
}
function toRepoRelativePosix(repoRoot, abs) {
  const rel = path.relative(repoRoot, abs);
  return rel.split(path.sep).join('/');
}
/**
 * Compute a stable short hash for a manifest entry. Currently only used by
 * test snapshots / future cache-busting; export so consumers don't have to
 * recompute the hashing convention.
 */
export function entryHash(entry) {
  return createHash('sha256')
    .update(`${entry.briefId}|${entry.sourceRun}|${entry.variantIndex}`)
    .digest('hex')
    .slice(0, 12);
}
//# sourceMappingURL=approve.js.map
