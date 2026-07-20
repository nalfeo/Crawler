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
 *   - The manifest entry KEY, the entry's `spriteName`, the engine texture key,
 *     and the catalog `id`/`spriteId` are all the SAME variant-unique id
 *     (`<briefId>-var-<N>`). Keeping them aligned is what lets multiple approved
 *     variants of one brief render independently instead of colliding on a
 *     brief-wide texture key (the historical skull-mace render bug).
 *
 * Supersede policy
 * ----------------
 *   - **Exact-variant re-approval is BLOCKED.** Approving a `briefId-var-N` that
 *     already exists in the manifest throws `ApproveError('already-approved')`
 *     (mapped to HTTP 409 by the sidecar). The UI must confirm before approving
 *     a NEW variant and must refuse an exact duplicate. Pass
 *     `allowReapprove: true` only for deliberate programmatic overwrites.
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
import { canonicalItemBriefId, itemArtIdentitySet } from '../../src/shared/item-sprites.js';
import { toSpriteType, type SpriteType } from '../../src/shared/sprite-types.js';
import { formatJsonFilesSync } from './catalog-io.js';

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
  readonly source: 'manual' | 'derived' | 'brief';
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
    /**
     * Optional weapon-attachment anchor. Set when the editor has explicitly
     * authored a muzzle / weapon-grip point for this mob sprite. `null` means
     * the editor cleared a previously set anchor; absent (no key) means it was
     * never set. Runtime code should treat both absent and `null` as "no anchor
     * — fall back to ECS pivot."
     */
    readonly weapon?: ManifestAnchor | null;
  };
  /** Sensor scorecard summary, e.g. `"7/7"`. */
  readonly sensorScore: string;
  /** Judge `minScore` as a string, or `null` if not judged. */
  readonly judgeScore: string | null;
  /** Full deterministic sensor results retained for later calibration. */
  readonly sensorBreakdown?: ReadonlyArray<{
    readonly sensor: string;
    readonly ok: boolean;
    readonly reason?: string;
    readonly pixels?: ReadonlyArray<unknown>;
  }>;
  /** Full per-axis VLM scorecard retained for later calibration. */
  readonly judgeScorecard?: Readonly<Record<string, unknown>> | null;
  /**
   * Canonical sprite type resolved from the brief, or `null` when it couldn't
   * be resolved. Written
   * so the reference selector can favour same-type examples without re-reading
   * briefs (which are often deleted after approval).
   */
  readonly type: SpriteType | null;
  /**
   * SHA-256 (hex) of the approved processed PNG's bytes. Lets re-approval tell a
   * genuine content change (e.g. after re-post-processing) apart from a true
   * byte-for-byte duplicate. Optional: entries approved before this field
   * existed omit it, and the guard falls back to hashing the on-disk asset.
   */
  readonly contentHash?: string;
  readonly postprocessOverrideProfilePath?: string | null;
  readonly effectivePipelineSnapshotPath?: string | null;
  readonly effectivePipelineSnapshotYamlPath?: string | null;
  readonly effectiveAnchorSource?: ManifestAnchor['source'] | null;
  readonly facingDirection?: 'left' | 'right';
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
      | 'already-approved'
      | 'manifest-invalid',
    message: string,
  ) {
    super(message);
    this.name = 'ApproveError';
  }
}

interface RunSummaryShape {
  readonly brief?: string;
  readonly briefPath?: string;
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
    readonly breakdown?: ReadonlyArray<{
      readonly sensor: string;
      readonly ok: boolean;
      readonly reason?: string;
      readonly pixels?: ReadonlyArray<unknown>;
    }>;
    readonly derivedAnchor?: { readonly x: number; readonly y: number } | null;
    readonly derivedAnchors?: {
      readonly hold?: { readonly x: number; readonly y: number } | null;
      readonly centerOfGravity?: { readonly x: number; readonly y: number } | null;
    } | null;
    readonly judgeScorecard?:
      | (Readonly<Record<string, unknown>> & { readonly minScore?: number })
      | null;
  }>;
  readonly postprocessOverrides?: {
    readonly profilePath?: string | null;
    readonly snapshotJsonPath?: string | null;
    readonly snapshotYamlPath?: string | null;
    readonly facing?: {
      readonly variantIndex?: number;
      readonly direction?: 'left' | 'right';
      readonly applyToAllVariants?: boolean;
    } | null;
  } | null;
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
  /**
   * Allow overwriting an already-approved `briefId-var-N` entry. Default false:
   * approving an exact-duplicate variant throws `ApproveError('already-approved')`.
   * Set true only for deliberate programmatic re-approval.
   */
  readonly allowReapprove?: boolean;
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
  const rawBriefId = summary.brief;
  if (!rawBriefId) {
    throw new ApproveError('summary-invalid', `summary.json has no "brief" field: ${summaryPath}`);
  }
  // Recurrence guard (ADR 0051): art for a gameplay item ships BARE. If the brief
  // is `<item>-vN` and `<item>` is a known item identity (an ItemDef.id or a
  // weaponId alias), strip the `-vN` so the manifest key / spriteName / assetPath
  // / briefId are all the bare item id and the icon resolves by item id. Genuine
  // non-item briefs (enemies, tiles, props) keep their `-vN` lineage untouched.
  const briefId = canonicalItemBriefId(rawBriefId, itemArtIdentitySet());

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
  const assetAbsPath = path.join(generatedDir, `${variantId}.png`);

  // Content hash of the exact image we're about to approve. Used both to block
  // true byte-for-byte re-approval and to stamp the manifest entry so a later
  // approval can tell "same pixels" from "re-post-processed, genuinely changed".
  const contentHash = createHash('sha256').update(fs.readFileSync(processedPng)).digest('hex');

  // Block re-approval ONLY when the identical image is already approved under
  // this variant id — a genuine content change (e.g. after re-post-processing)
  // is allowed to overwrite. `allowReapprove` forces overwrite unconditionally.
  // Checked BEFORE copying the PNG so a refused approval mutates nothing.
  if (!options.allowReapprove) {
    const existing = readManifestEntry(fs, options.manifestPath, variantId);
    if (existing) {
      // Prefer the stored hash; fall back to hashing the on-disk asset for
      // entries approved before contentHash existed. If neither is available
      // (legacy entry whose asset is gone), allow the re-approval.
      const storedHash =
        existing.contentHash && existing.contentHash.length > 0
          ? existing.contentHash
          : hashFileIfExists(fs, assetAbsPath);
      if (storedHash !== null && storedHash === contentHash) {
        throw new ApproveError(
          'already-approved',
          `Variant ${variantId} is already approved with identical content. ` +
            `Re-post-process to change the image, or pass allowReapprove to overwrite it.`,
        );
      }
    }
  }

  fs.mkdirSync(generatedDir, { recursive: true });
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

  const type = resolveBriefType(fs, options.repoRoot, summary.briefPath);

  const entry: ManifestEntry = {
    briefId,
    // Variant-unique sprite name == manifest key == engine texture key.
    spriteName: variantId,
    // Forward slashes so the engine can pass this straight to a URL/loader.
    assetPath: `generated/${variantId}.png`,
    approvedAt: now().toISOString(),
    sourceRun: toRepoRelativePosix(options.repoRoot, options.runDir),
    variantIndex: options.variantIndex,
    anchor: anchors.hold,
    anchors,
    sensorScore,
    judgeScore,
    sensorBreakdown: candidate.breakdown,
    judgeScorecard: candidate.judgeScorecard ?? null,
    type,
    contentHash,
    postprocessOverrideProfilePath: summary.postprocessOverrides?.profilePath ?? null,
    effectivePipelineSnapshotPath: summary.postprocessOverrides?.snapshotJsonPath ?? null,
    effectivePipelineSnapshotYamlPath: summary.postprocessOverrides?.snapshotYamlPath ?? null,
    effectiveAnchorSource: anchors.hold?.source ?? null,
    facingDirection: resolveFacingDirection(summary, options.variantIndex),
  };

  upsertManifest(fs, options.manifestPath, entry, variantId);
  upsertCatalog(fs, options.catalogPath, entry, variantId, entry.type);
  return entry;
}

function resolveFacingDirection(summary: RunSummaryShape, variantIndex: number): 'left' | 'right' {
  const facing = summary.postprocessOverrides?.facing;
  if (
    facing &&
    (facing.applyToAllVariants === true || facing.variantIndex === variantIndex) &&
    (facing.direction === 'left' || facing.direction === 'right')
  ) {
    return facing.direction;
  }
  return 'right';
}

/**
 * Read the brief's declared `type` (e.g. `item`, `enemy`) from the brief YAML
 * referenced by the run summary. Used to tag the catalog entry with its sprite
 * type so it is discoverable in-game. Returns `null` when the brief path is
 * missing/unreadable or has no top-level `type:` field.
 */
function resolveBriefType(fs: ApproveFs, repoRoot: string, briefPath?: string): SpriteType | null {
  if (!briefPath) return null;
  const absPath = path.isAbsolute(briefPath) ? briefPath : path.join(repoRoot, briefPath);
  if (!fs.existsSync(absPath)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
  const match = raw.match(/^type:\s*([A-Za-z][\w-]*)\s*$/m);
  return toSpriteType(match?.[1]);
}

/**
 * Read the manifest entry stored under `entryKey`, or null when the manifest is
 * missing/unparseable or has no such entry. Best-effort: a corrupt manifest
 * reads as "no entry" so approval proceeds (corruption surfaces via
 * `upsertManifest`'s own validation).
 */
function readManifestEntry(
  fs: ApproveFs,
  manifestPath: string,
  entryKey: string,
): ManifestEntry | null {
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Partial<Manifest>;
    return parsed.entries?.[entryKey] ?? null;
  } catch {
    return null;
  }
}

/** SHA-256 (hex) of a file's bytes, or null when the file is missing/unreadable. */
function hashFileIfExists(fs: ApproveFs, absPath: string): string | null {
  if (!fs.existsSync(absPath)) {
    return null;
  }
  try {
    return createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
  } catch {
    return null;
  }
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
  briefType: SpriteType | null,
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

  // Create catalog entry from manifest entry. The sprite type (from the brief)
  // is included as the first tag so generated sprites are discoverable by type.
  const tags = briefType
    ? [briefType, 'generated', 'pipeline-approved']
    : ['generated', 'pipeline-approved'];

  // Preserve any existing hand-authored description so approve does not clobber
  // richer catalog copy that was written after initial generation.
  const existingEntry = catalog.find((e) => e.id === `generated:${catalogId}`);
  const existingDescription =
    typeof existingEntry?.description === 'string' &&
    existingEntry.description !== `Generated sprite from brief: ${manifestEntry.briefId}.`
      ? existingEntry.description
      : null;

  const catalogEntry: Record<string, unknown> = {
    id: `generated:${catalogId}`,
    kind: 'sprite',
    label: manifestEntry.spriteName,
    description: existingDescription ?? `Generated sprite from brief: ${manifestEntry.briefId}.`,
    tags,
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
  // Apply Prettier so the on-disk format matches the committed style enforced
  // by `format:check`. All catalog write paths must go through formatJsonFilesSync
  // to ensure deterministic formatting regardless of which tool last wrote the
  // file. See scripts/sprites/catalog-io.ts.
  formatJsonFilesSync([catalogPath]);
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
): {
  hold: ManifestAnchor | null;
  centerOfGravity: ManifestAnchor | null;
  weapon?: ManifestAnchor | null;
} {
  const sidecarPath = path.join(processedDir, `${paddedIndex}.anchor.json`);
  const centerOfGravitySidecarPath = path.join(processedDir, `${paddedIndex}.anchor.cog.json`);
  const weaponSidecarPath = path.join(processedDir, `${paddedIndex}.anchor.weapon.json`);
  const hold = resolveSingleAnchor(fs, sidecarPath, candidateHoldAnchor, chosenAnchor);
  const centerOfGravity = resolveSingleAnchor(
    fs,
    centerOfGravitySidecarPath,
    candidateCenterOfGravityAnchor,
    chosenCenterOfGravityAnchor,
  );
  const weapon = resolveWeaponAnchorSidecar(fs, weaponSidecarPath);
  return { hold, centerOfGravity, ...(weapon !== undefined ? { weapon } : {}) };
}

function resolveSingleAnchor(
  fs: ApproveFs,
  sidecarPath: string,
  candidateDerivedAnchor: { readonly x: number; readonly y: number } | null,
  chosenAnchor: { readonly x: number; readonly y: number; readonly source: string } | null,
): ManifestAnchor | null {
  if (sidecarPath.endsWith('.anchor.json')) {
    const manualPath = sidecarPath.replace(/\.anchor\.json$/, '.manual-anchor.json');
    if (fs.existsSync(manualPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(manualPath, 'utf8')) as {
          x?: unknown;
          y?: unknown;
          source?: unknown;
        };
        if (typeof raw.x === 'number' && typeof raw.y === 'number' && raw.source === 'manual') {
          return { x: raw.x, y: raw.y, source: 'manual' };
        }
      } catch {
        // Fall through; corrupt manual sidecar must not block approval.
      }
    }
  }
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

/**
 * Read the weapon-anchor sidecar (`NN.anchor.weapon.json`) written by the
 * editor's weapon-anchor flow. Returns the anchor when the file is present and
 * valid, `null` when the file explicitly records a cleared anchor, and
 * `undefined` when the file is absent (= anchor was never authored).
 *
 * @returns `ManifestAnchor` when an explicit anchor is present and valid;
 *   `null` when the file contains `{ cleared: true }` (intentional removal);
 *   `undefined` when the file is absent (anchor was never set).
 */
function resolveWeaponAnchorSidecar(
  fs: ApproveFs,
  sidecarPath: string,
): ManifestAnchor | null | undefined {
  if (!fs.existsSync(sidecarPath)) {
    return undefined;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as {
      x?: unknown;
      y?: unknown;
      source?: unknown;
      cleared?: unknown;
    };
    // An explicit `{ cleared: true }` marker means the editor cleared a
    // previously authored anchor — preserve null in the manifest so callers
    // know it was intentionally removed.
    if (raw.cleared === true) {
      return null;
    }
    if (typeof raw.x === 'number' && typeof raw.y === 'number') {
      const source =
        raw.source === 'manual' || raw.source === 'derived' || raw.source === 'brief'
          ? raw.source
          : 'manual';
      return { x: raw.x, y: raw.y, source };
    }
  } catch {
    // Corrupt sidecar must not block approval.
  }
  return undefined;
}

function padIndex(index: number): string {
  return String(index).padStart(2, '0');
}

function toRepoRelativePosix(repoRoot: string, abs: string): string {
  const rel = path.relative(repoRoot, abs);
  return rel.split(path.sep).join('/');
}
