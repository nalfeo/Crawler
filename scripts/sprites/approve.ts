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

/** Subset of `node:fs` calls approveVariant needs. Exposed for tests. */
export interface ApproveFs {
  readonly existsSync: typeof existsSync;
  readonly readFileSync: typeof readFileSync;
  readonly writeFileSync: typeof writeFileSync;
  readonly copyFileSync: typeof copyFileSync;
  readonly mkdirSync: typeof mkdirSync;
}

const DEFAULT_FS: ApproveFs = {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
};

/**
 * Anchor as written into the manifest. Mirrors `ChosenAnchor` from
 * `run-artifacts.ts` but is redeclared here so consumers can depend on
 * the manifest schema without pulling in run-time pipeline types.
 */
export interface ManifestAnchor {
  readonly x: number;
  readonly y: number;
  readonly source: 'derived' | 'brief';
}

/** Shape of one entry in `manifest.json`. */
export interface ManifestEntry {
  readonly briefId: string;
  readonly spriteName: string;
  /** Repo-relative-to-`public/assets/` path, forward-slashed for web use. */
  readonly assetPath: string;
  /** ISO-8601 UTC timestamp of approval. */
  readonly approvedAt: string;
  /** Repo-relative source run dir (e.g. `runs/iron-sword/2026-...`), forward-slashed. */
  readonly sourceRun: string;
  readonly variantIndex: number;
  readonly anchor: ManifestAnchor | null;
  readonly anchors: {
    readonly hold: ManifestAnchor | null;
    readonly centerOfGravity: ManifestAnchor | null;
  };
  /** Sensor scorecard summary, e.g. `"7/7"`. */
  readonly sensorScore: string;
  /** Judge `minScore` as a string, or `null` if not judged. */
  readonly judgeScore: string | null;
}

export interface Manifest {
  readonly version: 1;
  readonly entries: Readonly<Record<string, ManifestEntry>>;
}

export const MANIFEST_VERSION = 1 as const;

export class ApproveError extends Error {
  constructor(
    public readonly kind:
      | 'run-not-found'
      | 'summary-invalid'
      | 'variant-not-found'
      | 'processed-missing'
      | 'manifest-invalid',
    message: string,
  ) {
    super(message);
    this.name = 'ApproveError';
  }
}

interface RunSummaryShape {
  readonly brief?: string;
  readonly runId?: string;
  readonly chosen?: {
    readonly index?: number;
    readonly anchor?: { readonly x: number; readonly y: number; readonly source: string } | null;
    readonly anchors?: {
      readonly hold?: { readonly x: number; readonly y: number; readonly source: string } | null;
      readonly centerOfGravity?: {
        readonly x: number;
        readonly y: number;
        readonly source: string;
      } | null;
    } | null;
  } | null;
  readonly candidates?: ReadonlyArray<{
    readonly index?: number;
    readonly score?: number;
    readonly outOf?: number;
    readonly derivedAnchor?: { readonly x: number; readonly y: number } | null;
    readonly derivedAnchors?: {
      readonly hold?: { readonly x: number; readonly y: number } | null;
      readonly centerOfGravity?: { readonly x: number; readonly y: number } | null;
    } | null;
    readonly judgeScorecard?: { readonly minScore?: number } | null;
  }>;
}

interface VariantAnchorSidecar {
  readonly x: number;
  readonly y: number;
  readonly source?: string;
}

export interface ApproveVariantOptions {
  /** Absolute path to the run directory (`generated/runs/<brief>/<runId>`). */
  readonly runDir: string;
  /** Variant index, as it appears in `summary.json.candidates[i].index`. */
  readonly variantIndex: number;
  /** Absolute path to `public/assets/generated/manifest.json`. Created if missing. */
  readonly manifestPath: string;
  /** Absolute path to `src/shared/data/sprite-catalog.json`. Updated with approved sprite. */
  readonly catalogPath: string;
  /** Absolute path to `public/assets/` (parent of `generated/`). */
  readonly publicAssetsDir: string;
  /** Absolute path to the repo root, used to compute `sourceRun` relative path. */
  readonly repoRoot: string;
  /** Clock injection for deterministic tests. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /** Injected fs for tests. Defaults to `node:fs`. */
  readonly fs?: ApproveFs;
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
export function approveVariant(options: ApproveVariantOptions): ManifestEntry {
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

  const entry: ManifestEntry = {
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
function upsertManifest(
  fs: ApproveFs,
  manifestPath: string,
  entry: ManifestEntry,
  entryKey: string,
): void {
  let current: Manifest;
  if (fs.existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Partial<Manifest>;
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
  const nextEntries: Record<string, ManifestEntry> = { ...current.entries, [entryKey]: entry };
  const sortedKeys = Object.keys(nextEntries).sort();
  const sorted: Record<string, ManifestEntry> = {};
  for (const key of sortedKeys) {
    sorted[key] = nextEntries[key]!;
  }

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const next: Manifest = { version: MANIFEST_VERSION, entries: sorted };
  fs.writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
}

/**
 * Convert manifest entry to catalog entry and upsert into catalog.json.
 * Catalog entries need additional fields for the game, so we construct the full entry here.
 */
function upsertCatalog(
  fs: ApproveFs,
  catalogPath: string,
  manifestEntry: ManifestEntry,
  catalogId: string,
): void {
  let catalog: Array<Record<string, unknown>>;

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
  const catalogEntry: Record<string, unknown> = {
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

function parseSummary(raw: string, summaryPath: string): RunSummaryShape {
  try {
    return JSON.parse(raw) as RunSummaryShape;
  } catch (err) {
    throw new ApproveError(
      'summary-invalid',
      `summary.json is not parseable (${summaryPath}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function resolveAnchors(
  fs: ApproveFs,
  processedDir: string,
  paddedIndex: string,
  candidateHoldAnchor: { readonly x: number; readonly y: number } | null,
  candidateCenterOfGravityAnchor: { readonly x: number; readonly y: number } | null,
  chosenAnchor: { readonly x: number; readonly y: number; readonly source: string } | null,
  chosenCenterOfGravityAnchor: {
    readonly x: number;
    readonly y: number;
    readonly source: string;
  } | null,
): { hold: ManifestAnchor | null; centerOfGravity: ManifestAnchor | null } {
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

function resolveSingleAnchor(
  fs: ApproveFs,
  sidecarPath: string,
  candidateDerivedAnchor: { readonly x: number; readonly y: number } | null,
  chosenAnchor: { readonly x: number; readonly y: number; readonly source: string } | null,
): ManifestAnchor | null {
  if (fs.existsSync(sidecarPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as VariantAnchorSidecar;
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

function padIndex(index: number): string {
  return String(index).padStart(2, '0');
}

function toRepoRelativePosix(repoRoot: string, abs: string): string {
  const rel = path.relative(repoRoot, abs);
  return rel.split(path.sep).join('/');
}

/**
 * Compute a stable short hash for a manifest entry. Currently only used by
 * test snapshots / future cache-busting; export so consumers don't have to
 * recompute the hashing convention.
 */
export function entryHash(entry: ManifestEntry): string {
  return createHash('sha256')
    .update(`${entry.briefId}|${entry.sourceRun}|${entry.variantIndex}`)
    .digest('hex')
    .slice(0, 12);
}
