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
import { PNG } from 'pngjs';
import { deriveOpaqueBounds, type DerivedBounds } from './derive-opaque-bounds.js';
import { packFrameStrip } from './pack-frame-strip.js';
import { checkFrameCoherence, type FrameCoherenceOptions } from './sensors/frame-coherence.js';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { bareConcept } from './sprite-name-taxonomy.js';
import { toSpriteType, type SpriteType } from '../../src/shared/sprite-types.js';
import { formatJsonFilesSync } from './catalog-io.js';
import { shardPathForKey } from './generated-shards.js';

/** Subset of `node:fs` calls approveVariant needs. Exposed for tests. */
export interface ApproveFs {
  readonly existsSync: typeof existsSync;
  readonly readFileSync: typeof readFileSync;
  readonly writeFileSync: typeof writeFileSync;
  readonly copyFileSync: typeof copyFileSync;
  readonly mkdirSync: typeof mkdirSync;
}

/** Extended fs subset that also supports file deletion, used by unapproveVariant. */
export interface UnapproveFs extends ApproveFs {
  readonly unlinkSync: typeof unlinkSync;
}

const DEFAULT_FS: ApproveFs = {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
};

const DEFAULT_UNAPPROVE_FS: UnapproveFs = {
  ...DEFAULT_FS,
  unlinkSync,
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
  readonly judgeScorecard?:
    | (Readonly<Record<string, unknown>> & {
        /**
         * When true, the judge issued a hard-block veto.  `approve.ts` rejects
         * these unless `allowHardBlocked: true` is passed, in which case this
         * field is cleared to `false` and `humanHardBlockOverride` is set.
         */
        readonly hardBlocked?: boolean;
        /**
         * Set to `true` when a human consciously approved a hard-blocked variant
         * via `allowHardBlocked: true`.  The CI invariant only blocks
         * `hardBlocked === true`, so this survives the check.
         */
        readonly humanHardBlockOverride?: boolean;
      })
    | null;
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
  /**
   * Bounding box of the sprite's non-transparent pixels, plus the canvas it was
   * measured against. Lets consumers anchor and scale by the art the player can
   * actually see instead of the pipeline's transparent safety margin. Optional:
   * entries approved before this field existed omit it and consumers fall back
   * to whole-canvas behaviour. Backfilled by `sprites:derive-opaque-bounds`.
   */
  readonly opaqueBounds?: DerivedBounds;
  readonly postprocessOverrideProfilePath?: string | null;
  readonly effectivePipelineSnapshotPath?: string | null;
  readonly effectivePipelineSnapshotYamlPath?: string | null;
  readonly effectiveAnchorSource?: ManifestAnchor['source'] | null;
  readonly facingDirection?: 'left' | 'right';
  /**
   * Present only on entries approved via `approveFrameSequence` (Slice B
   * walk-cycle animation sheets). Mirrors the shared descriptor Slice A's
   * `src/shared/generated-assets.ts` declares — kept structurally identical
   * here so this file does not need to import across the ownership boundary.
   * `assetPath` for an animated entry is a single strip PNG containing
   * `frameCount` consecutive `frameWidth × frameHeight` cells with no
   * margin/spacing, ready for `Phaser.Loader.LoaderPlugin#spritesheet`.
   */
  readonly animation?: {
    readonly frameWidth: number;
    readonly frameHeight: number;
    readonly frameCount: number;
    readonly frameRate: number;
    readonly loop: boolean;
  };
  /**
   * True when this entry is a placeholder stand-in (not real generated art).
   * Placeholder entries are excluded from the derived sprite-catalog rows. See
   * `src/shared/generated-catalog.ts#isPlaceholderManifestEntry`.
   */
  readonly placeholder?: boolean;
  /**
   * Optional per-asset catalog overrides. The `generated:` sprite-catalog rows
   * are DERIVED from this manifest; this field is the single home for the small
   * set of hand-authored deviations (rich descriptions, deliberate tag
   * overrides) that derivation cannot reconstruct. The override shards with its
   * asset, so it never reintroduces a shared mega-file.
   */
  readonly catalog?: {
    readonly description?: string;
    readonly tags?: readonly string[];
  };
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
      | 'manifest-invalid'
      | 'hard-blocked'
      // Frame-sequence-only kinds (approveFrameSequence):
      | 'not-frame-sequence'
      | 'frame-missing'
      | 'frame-incoherent'
      | 'icon-batch-count-mismatch',
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
    readonly processedPath?: string;
    readonly derivedAnchor?: { readonly x: number; readonly y: number } | null;
    readonly derivedAnchors?: {
      readonly hold?: { readonly x: number; readonly y: number } | null;
      readonly centerOfGravity?: { readonly x: number; readonly y: number } | null;
    } | null;
    readonly judgeScorecard?:
      | (Readonly<Record<string, unknown>> & {
          readonly minScore?: number;
          readonly hardBlocked?: boolean;
          readonly passed?: boolean;
          readonly hardBlockInstruction?: string | null;
        })
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
  /**
   * Present only when `brief.frameSequence.enabled` (see `run-artifacts.ts`).
   * Carries the ordered animation-cycle intent through to
   * `approveFrameSequence`, which stamps the shared `animation` descriptor
   * (frameWidth/frameHeight are measured from the packed strip, not stored
   * here) onto the manifest entry.
   */
  readonly frameSequence?: {
    readonly frameCount?: number;
    readonly frameRate?: number;
    readonly loop?: boolean;
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
  /**
   * Absolute path to `public/assets/generated/manifest.json`. The aggregate
   * itself is a gitignored build artifact; approve derives the generated
   * directory from this path and writes the per-asset shard under
   * `entries/<key>.json`. Kept as the anchor path so callers don't need to know
   * the shard layout.
   */
  readonly manifestPath: string;
  /**
   * @deprecated The `generated:` catalog rows are now DERIVED from the manifest
   * shards (see `src/shared/generated-catalog.ts`); approve no longer writes the
   * catalog. Accepted for backward compatibility and ignored.
   */
  readonly catalogPath?: string;
  /** Absolute path to `public/assets/` (parent of `generated/`). */
  readonly publicAssetsDir: string;
  /** Absolute path to the repo root, used to compute `sourceRun` relative path. */
  readonly repoRoot: string;
  /**
   * Stable repo-relative source identity for rematerialized runs. When omitted,
   * derives the path from `runDir` exactly as before.
   */
  readonly sourceRunOverride?: string;
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
  /**
   * Allow approving a variant whose judge scorecard has `hardBlocked === true`.
   * Default false: hard-blocked variants throw `ApproveError('hard-blocked')`.
   * Set true only when a human consciously overrules the judge's veto.
   */
  readonly allowHardBlocked?: boolean;
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
  const sourceRun = options.sourceRunOverride
    ? normalizeSourceRunOverride(options.sourceRunOverride)
    : toRepoRelativePosix(options.repoRoot, options.runDir);
  const rawBriefId = summary.brief;
  if (!rawBriefId) {
    throw new ApproveError('summary-invalid', `summary.json has no "brief" field: ${summaryPath}`);
  }
  // Recurrence guard: ALL generated art ships BARE. If the brief carries a
  // generation-time `-vN` lineage tag, strip it so the manifest key /
  // spriteName / assetPath / briefId are all the bare concept. This is what
  // keeps `loadGeneratedManifest` grouping every variant of a concept into ONE
  // bucket — a versioned brief creates a second bucket that
  // `pickGeneratedVariant` can never draw from, stranding approved art.
  // Design names that merely look versioned (`angry-roomba-v2`) are remapped,
  // not stripped, by `DESIGN_NAME_REMAP`.
  const briefId = bareConcept(rawBriefId);

  const candidate = (summary.candidates ?? []).find((c) => c.index === options.variantIndex);
  if (!candidate) {
    throw new ApproveError(
      'variant-not-found',
      `Variant ${options.variantIndex} not in summary.json candidates ` +
        `(have: ${(summary.candidates ?? []).map((c) => c.index).join(', ') || 'none'})`,
    );
  }

  // Hard-block gate: a judge-issued hard-block is a veto, not a score to be
  // weighed. Refuse the approval unless the caller explicitly opts out with
  // `allowHardBlocked: true` (reserved for conscious human overrides only).
  if (candidate.judgeScorecard?.hardBlocked === true && !options.allowHardBlocked) {
    const instruction = candidate.judgeScorecard.hardBlockInstruction;
    throw new ApproveError(
      'hard-blocked',
      `Variant ${options.variantIndex} was hard-blocked by the judge and cannot be approved. ` +
        (instruction ? `Judge instruction: "${instruction}". ` : '') +
        `Pass allowHardBlocked: true (or --allow-hard-blocked on the CLI) to override deliberately.`,
    );
  }

  // Soft warning: judge scored `passed: false` but did not hard-block. The art
  // may still be approvable, but the operator should be aware.
  if (
    candidate.judgeScorecard !== null &&
    candidate.judgeScorecard !== undefined &&
    candidate.judgeScorecard.passed === false &&
    candidate.judgeScorecard.hardBlocked !== true
  ) {
    process.stderr.write(
      `⚠ Warning: approving variant ${options.variantIndex} whose judge scorecard has passed=false. ` +
        `The judge flagged this art as below threshold — proceed only if you have reviewed it.\n`,
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
  const processedBytes = fs.readFileSync(processedPng);
  const contentHash = createHash('sha256').update(processedBytes).digest('hex');

  // Visible-pixel box of the exact art being approved, so new sprites ship with
  // bounds and the backfill script only has to cover historical entries.
  // Deliberately non-fatal: approval has never required decodable PNG bytes and
  // must not start to. A skip is not silent — `sprites:derive-opaque-bounds
  // --check` reports any entry missing bounds, so the gate stays authoritative
  // rather than this catch swallowing the gap forever.
  let opaqueBounds: DerivedBounds | undefined;
  try {
    opaqueBounds = deriveOpaqueBounds(PNG.sync.read(processedBytes));
  } catch {
    opaqueBounds = undefined;
  }

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

  // Preserve any hand-authored catalog override (rich description / deliberate
  // tag override) from a prior approval of this variant. Overrides live on the
  // shard so re-approving real art must not silently drop them.
  const existingEntry = readManifestEntry(fs, options.manifestPath, variantId);
  const preservedCatalog = existingEntry?.catalog;

  const entry: ManifestEntry = {
    briefId,
    // Variant-unique sprite name == manifest key == engine texture key.
    spriteName: variantId,
    // Forward slashes so the engine can pass this straight to a URL/loader.
    assetPath: `generated/${variantId}.png`,
    approvedAt: now().toISOString(),
    sourceRun,
    variantIndex: options.variantIndex,
    anchor: anchors.hold,
    anchors,
    sensorScore,
    judgeScore,
    sensorBreakdown: candidate.breakdown,
    judgeScorecard: (() => {
      const sc = candidate.judgeScorecard ?? null;
      // When a human consciously overrides a hard-block, clear the hardBlocked
      // flag so the CI invariant (check-manifest-hard-blocked) doesn't reject
      // the entry. Persist humanHardBlockOverride as durable evidence of the
      // conscious override decision.
      if (sc && options.allowHardBlocked && sc.hardBlocked === true) {
        return { ...sc, hardBlocked: false, humanHardBlockOverride: true };
      }
      return sc;
    })(),
    type,
    contentHash,
    ...(opaqueBounds !== undefined ? { opaqueBounds } : {}),
    postprocessOverrideProfilePath: summary.postprocessOverrides?.profilePath ?? null,
    effectivePipelineSnapshotPath: summary.postprocessOverrides?.snapshotJsonPath ?? null,
    effectivePipelineSnapshotYamlPath: summary.postprocessOverrides?.snapshotYamlPath ?? null,
    effectiveAnchorSource: anchors.hold?.source ?? null,
    facingDirection: resolveFacingDirection(summary, options.variantIndex),
    ...(preservedCatalog ? { catalog: preservedCatalog } : {}),
  };

  upsertManifest(fs, options.manifestPath, entry, variantId);
  return entry;
}

export interface ApproveFrameSequenceOptions {
  /** Absolute path to the run directory (`generated/runs/<brief>/<runId>`). */
  readonly runDir: string;
  /**
   * Absolute path to `public/assets/generated/manifest.json`. The aggregate
   * itself is a gitignored build artifact; approve derives the generated
   * directory from this path and writes the per-asset shard under
   * `entries/<key>.json`. Kept as the anchor path so callers don't need to know
   * the shard layout.
   */
  readonly manifestPath: string;
  /**
   * @deprecated The `generated:` catalog rows are now DERIVED from the manifest
   * shards (see `src/shared/generated-catalog.ts`); approve no longer writes the
   * catalog. Accepted for backward compatibility and ignored.
   */
  readonly catalogPath?: string;
  /** Absolute path to `public/assets/` (parent of `generated/`). */
  readonly publicAssetsDir: string;
  /** Absolute path to the repo root, used to compute `sourceRun` relative path. */
  readonly repoRoot: string;
  /**
   * Stable repo-relative source identity for rematerialized runs. When omitted,
   * derives the path from `runDir` exactly as before.
   */
  readonly sourceRunOverride?: string;
  /** Clock injection for deterministic tests. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /** Injected fs for tests. Defaults to `node:fs`. */
  readonly fs?: ApproveFs;
  /**
   * Allow overwriting an already-approved entry with identical content.
   * Default false: approving an exact-duplicate strip throws
   * `ApproveError('already-approved')`.
   */
  readonly allowReapprove?: boolean;
  /**
   * Override the coherence-gate thresholds. Defaults to
   * `frame-coherence.ts`'s own defaults. Present for tests only — do NOT
   * loosen these in production callers just to force a failing generation
   * to pass; regenerate instead.
   */
  readonly coherence?: FrameCoherenceOptions;
}

/**
 * Approve an ENTIRE frame-sequence run (a walk-cycle animation sheet, Slice
 * B) as a single unit — unlike `approveVariant`, which approves exactly one
 * design-alternative cell, this reads every ordered frame the run produced,
 * runs the deterministic cross-frame coherence gate (`frame-coherence.ts`),
 * packs the frames into one horizontal strip PNG, and writes a manifest
 * entry carrying the shared `animation` descriptor. Refuses to approve
 * (and writes nothing) when the run isn't a frame-sequence run, is missing
 * a frame, or fails the coherence gate — this hard gate must never be
 * bypassed by a caller relaxing `coherence` outside of tests.
 *
 * Steps:
 *   1. Load and validate `summary.json`, requiring `frameSequence` present.
 *   2. Locate all `frameCount` candidates by index (0..frameCount-1, in
 *      that ORDER — cycle order, not sensor-score rank).
 *   3. Verify every frame's processed PNG exists.
 *   4. Run `checkFrameCoherence` across the ordered frames; throw
 *      `ApproveError('frame-incoherent')` on failure.
 *   5. Pack the frames into one strip PNG → `publicAssetsDir/generated/<briefId>.png`.
 *   6. Load + upsert + write `manifest.json` with the `animation` descriptor.
 *   7. Return the new manifest entry.
 */
export function approveFrameSequence(options: ApproveFrameSequenceOptions): ManifestEntry {
  const fs = options.fs ?? DEFAULT_FS;
  const now = options.now ?? (() => new Date());

  const summaryPath = path.join(options.runDir, 'summary.json');
  if (!fs.existsSync(summaryPath)) {
    throw new ApproveError('run-not-found', `Run directory has no summary.json: ${options.runDir}`);
  }

  const summary = parseSummary(fs.readFileSync(summaryPath, 'utf8'), summaryPath);
  const sourceRun = options.sourceRunOverride
    ? normalizeSourceRunOverride(options.sourceRunOverride)
    : toRepoRelativePosix(options.repoRoot, options.runDir);
  const rawBriefId = summary.brief;
  if (!rawBriefId) {
    throw new ApproveError('summary-invalid', `summary.json has no "brief" field: ${summaryPath}`);
  }
  const briefId = bareConcept(rawBriefId);

  const frameSequence = summary.frameSequence;
  const frameCount = frameSequence?.frameCount;
  if (!frameSequence || typeof frameCount !== 'number' || frameCount < 2) {
    throw new ApproveError(
      'not-frame-sequence',
      `summary.json has no valid "frameSequence" field (brief must opt into ` +
        `frameSequence.enabled): ${summaryPath}`,
    );
  }
  const frameRate = frameSequence.frameRate;
  const loop = frameSequence.loop;
  if (typeof frameRate !== 'number' || typeof loop !== 'boolean') {
    throw new ApproveError(
      'not-frame-sequence',
      `summary.json's "frameSequence" field is missing frameRate/loop: ${summaryPath}`,
    );
  }

  // Ordered frames 0..frameCount-1 — cycle order, NOT sensor-score rank.
  const candidatesByIndex = new Map((summary.candidates ?? []).map((c) => [c.index, c]));
  const processedDir = path.join(options.runDir, 'processed');
  const frameBuffers: Buffer[] = [];
  const frameBreakdowns: Array<NonNullable<RunSummaryShape['candidates']>[number]['breakdown']> =
    [];
  for (let i = 0; i < frameCount; i++) {
    const candidate = candidatesByIndex.get(i);
    if (!candidate) {
      throw new ApproveError(
        'frame-missing',
        `Frame ${i} not in summary.json candidates (need indices 0..${frameCount - 1})`,
      );
    }
    const padded = padIndex(i);
    const runLocalPng = path.join(processedDir, `${padded}.png`);
    const declaredPng = candidate.processedPath
      ? path.isAbsolute(candidate.processedPath)
        ? candidate.processedPath
        : path.join(options.repoRoot, candidate.processedPath)
      : runLocalPng;
    // `approveVariant` always resolves the run-local `processed/NN.png` path
    // first and only falls back to the declared processedPath when the local
    // file is absent. Do the same here: a rematerialized or reprocessed run
    // will have written fresh bytes to the run-local path — preferring the
    // declared absolute path from the original machine would silently pack
    // stale bytes from before the reprocess (reviewer finding, PR #2302).
    const processedPng = fs.existsSync(runLocalPng)
      ? runLocalPng
      : fs.existsSync(declaredPng)
        ? declaredPng
        : runLocalPng;
    if (!fs.existsSync(processedPng)) {
      throw new ApproveError(
        'frame-missing',
        `Processed PNG not found for frame ${i}: ${processedPng}`,
      );
    }
    frameBuffers.push(fs.readFileSync(processedPng));
    frameBreakdowns.push(candidate.breakdown);
  }

  // HARD GATE: cross-frame coherence. Never weaken these thresholds to force
  // a lucky generation through — regenerate instead. See frame-coherence.ts.
  // Pass `loop` so the wrap-around seam (final→first) is checked when the
  // animation loops — a drifted loop seam plays on every cycle iteration.
  const coherence = checkFrameCoherence(frameBuffers, { ...options.coherence, loop });
  if (!coherence.ok) {
    throw new ApproveError(
      'frame-incoherent',
      `Frame sequence for brief "${briefId}" failed the cross-frame coherence gate: ${coherence.reason ?? 'unknown reason'}`,
    );
  }

  const strip = packFrameStrip(frameBuffers);

  const generatedDir = path.join(options.publicAssetsDir, 'generated');
  const assetAbsPath = path.join(generatedDir, `${briefId}.png`);
  const contentHash = createHash('sha256').update(strip.buffer).digest('hex');

  if (!options.allowReapprove) {
    const existing = readManifestEntry(fs, options.manifestPath, briefId);
    if (existing) {
      const storedHash =
        existing.contentHash && existing.contentHash.length > 0
          ? existing.contentHash
          : hashFileIfExists(fs, assetAbsPath);
      if (storedHash !== null && storedHash === contentHash) {
        throw new ApproveError(
          'already-approved',
          `Frame sequence ${briefId} is already approved with identical content. ` +
            `Re-generate to change the cycle, or pass allowReapprove to overwrite it.`,
        );
      }
    }
  }

  fs.mkdirSync(generatedDir, { recursive: true });
  fs.writeFileSync(assetAbsPath, strip.buffer);

  const type = resolveBriefType(fs, options.repoRoot, summary.briefPath);

  // Ambiguous across multiple poses — leave unset rather than picking one
  // frame's anchor arbitrarily. Consumers of animated entries derive
  // gameplay anchoring differently (Slice A's concern), not from this field.
  const entry: ManifestEntry = {
    briefId,
    spriteName: briefId,
    assetPath: `generated/${briefId}.png`,
    approvedAt: now().toISOString(),
    sourceRun,
    variantIndex: 0,
    anchor: null,
    anchors: { hold: null, centerOfGravity: null },
    // Sensor score reported for frame 0 only — frame-sequence entries are
    // approved as one unit via the coherence gate above, not per-variant
    // sensor scoring.
    sensorScore: 'frame-sequence',
    judgeScore: null,
    sensorBreakdown: frameBreakdowns[0],
    judgeScorecard: null,
    type,
    contentHash,
    animation: {
      frameWidth: strip.frameWidth,
      frameHeight: strip.frameHeight,
      frameCount: strip.frameCount,
      frameRate,
      loop,
    },
  };

  upsertManifest(fs, options.manifestPath, entry, briefId);
  return entry;
}

/** Deterministic identity + content hash for one run variant, resolved WITHOUT mutating anything. */
export interface VariantIdentity {
  /** Canonical brief id (item-alias `-vN` stripped when applicable). */
  readonly briefId: string;
  /** `${briefId}-var-${variantIndex}` — the manifest/catalog key. */
  readonly variantId: string;
  /** `generated/${variantId}.png` — repo-relative-to-`public/assets/` path. */
  readonly assetPath: string;
  /** SHA-256 (hex) of the candidate's processed PNG bytes. */
  readonly contentHash: string;
}

/**
 * Resolve the canonical identity (briefId, variantId, assetPath) and content
 * hash a variant WOULD get if approved right now — without copying the PNG or
 * touching the manifest/catalog. Shares `approveVariant`'s validation (throws
 * the same `ApproveError` kinds: `run-not-found`, `summary-invalid`,
 * `variant-not-found`, `processed-missing`) so callers that need to reconcile
 * against durable state BEFORE deciding whether to mutate (e.g. the sidecar's
 * atomic accept route checking the check-in queue) can do so safely.
 */
export function resolveVariantIdentity(
  runDir: string,
  variantIndex: number,
  fs: ApproveFs = DEFAULT_FS,
): VariantIdentity {
  const summaryPath = path.join(runDir, 'summary.json');
  if (!fs.existsSync(summaryPath)) {
    throw new ApproveError('run-not-found', `Run directory has no summary.json: ${runDir}`);
  }
  const summary = parseSummary(fs.readFileSync(summaryPath, 'utf8'), summaryPath);
  const rawBriefId = summary.brief;
  if (!rawBriefId) {
    throw new ApproveError('summary-invalid', `summary.json has no "brief" field: ${summaryPath}`);
  }
  const briefId = bareConcept(rawBriefId);

  const candidate = (summary.candidates ?? []).find((c) => c.index === variantIndex);
  if (!candidate) {
    throw new ApproveError(
      'variant-not-found',
      `Variant ${variantIndex} not in summary.json candidates ` +
        `(have: ${(summary.candidates ?? []).map((c) => c.index).join(', ') || 'none'})`,
    );
  }

  const padded = padIndex(variantIndex);
  const processedPng = path.join(runDir, 'processed', `${padded}.png`);
  if (!fs.existsSync(processedPng)) {
    throw new ApproveError(
      'processed-missing',
      `Processed PNG not found for variant ${variantIndex}: ${processedPng}`,
    );
  }

  const variantId = `${briefId}-var-${variantIndex}`;
  const contentHash = createHash('sha256').update(fs.readFileSync(processedPng)).digest('hex');
  return { briefId, variantId, assetPath: `generated/${variantId}.png`, contentHash };
}

/**
 * Load the manifest entry for a variant that is ALREADY approved with identical
 * content, WITHOUT mutating anything. Returns null when no such entry exists
 * (e.g. the manifest was hand-edited away). Reuses `resolveVariantIdentity` to
 * derive the canonical manifest key (`${briefId}-var-${variantIndex}`), so it
 * throws the same run-validation `ApproveError` kinds when the run itself is
 * gone.
 *
 * Used by the sidecar approve route to close the failed-push retry gap: when a
 * prior approval already wrote the local manifest (so re-approve is a no-op
 * `already-approved`) but its best-effort durable queue-commit never landed on
 * the remote `assets/queue` branch, the route loads the stored entry via this
 * helper and re-runs the queue-commit instead of returning a bare 409.
 */
export function loadApprovedEntry(options: {
  readonly runDir: string;
  readonly variantIndex: number;
  readonly manifestPath: string;
  readonly fs?: ApproveFs;
}): ManifestEntry | null {
  const fs = options.fs ?? DEFAULT_FS;
  const identity = resolveVariantIdentity(options.runDir, options.variantIndex, fs);
  return readManifestEntry(fs, options.manifestPath, identity.variantId);
}

/**
 * Frame-sequence counterpart to `loadApprovedEntry`: loads the manifest entry
 * for a frame-sequence run that is ALREADY approved with identical content,
 * WITHOUT mutating anything. Returns null when no such entry exists.
 *
 * Closes the same retry gap `loadApprovedEntry` closes for `--variant`
 * approvals: re-running `approveFrameSequence` after a failed queue-commit
 * throws `ApproveError('already-approved')` before `runQueueCommit` ever
 * executes (the manifest write already succeeded), so the CLI's "re-run to
 * retry queue-commit" advice would otherwise be false for `--sequence`. The
 * caller catches `already-approved`, loads the existing entry via this
 * helper, and falls through to `runQueueCommit` exactly as the `--variant`
 * path does.
 */
export function loadApprovedFrameSequenceEntry(options: {
  readonly runDir: string;
  readonly manifestPath: string;
  readonly repoRoot: string;
  readonly fs?: ApproveFs;
}): ManifestEntry | null {
  const fs = options.fs ?? DEFAULT_FS;
  const summaryPath = path.join(options.runDir, 'summary.json');
  if (!fs.existsSync(summaryPath)) {
    throw new ApproveError('run-not-found', `Run directory has no summary.json: ${options.runDir}`);
  }
  const summary = parseSummary(fs.readFileSync(summaryPath, 'utf8'), summaryPath);
  const rawBriefId = summary.brief;
  if (!rawBriefId) {
    throw new ApproveError('summary-invalid', `summary.json has no "brief" field: ${summaryPath}`);
  }
  const briefId = bareConcept(rawBriefId);
  return readManifestEntry(fs, options.manifestPath, briefId);
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
 * Read the manifest entry stored in the per-asset shard for `entryKey`, or null
 * when the shard is missing/unparseable. Best-effort: a corrupt shard reads as
 * "no entry" so approval proceeds (it will be overwritten by the write below).
 */
function readManifestEntry(
  fs: ApproveFs,
  manifestPath: string,
  entryKey: string,
): ManifestEntry | null {
  const shardPath = shardPathForKey(path.dirname(manifestPath), entryKey);
  if (!fs.existsSync(shardPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(shardPath, 'utf8')) as ManifestEntry;
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
 * Write the manifest entry to its own per-asset shard
 * (`entries/<entryKey>.json`). Sharding is the whole point of this design: two
 * approvals touching different assets never touch the same file, so parallel
 * art PRs no longer conflict by construction. The aggregate `manifest.json` is a
 * gitignored build artifact composed from these shards (see
 * `scripts/sprites/build-manifest.ts` and the Vite plugin).
 */
function upsertManifest(
  fs: ApproveFs,
  manifestPath: string,
  entry: ManifestEntry,
  entryKey: string,
): void {
  const shardPath = shardPathForKey(path.dirname(manifestPath), entryKey);
  fs.mkdirSync(path.dirname(shardPath), { recursive: true });
  fs.writeFileSync(shardPath, `${JSON.stringify(entry, null, 2)}\n`);
  // Apply Prettier so the on-disk format matches the committed style enforced
  // by `format:check`.
  formatJsonFilesSync([shardPath]);
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

function normalizeSourceRunOverride(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new ApproveError(
      'summary-invalid',
      `sourceRunOverride must be a safe repo-relative path, got: ${value}`,
    );
  }
  return normalized;
}

/**
 * One entry in an icon batch brief — identifies a single icon within the batch.
 * Callers supply this by extracting `brief.iconBatch` from a loaded Brief.
 */
export interface IconBatchEntry {
  readonly id: string;
  readonly concept: string;
  readonly description?: string;
}

export interface ApproveIconBatchOptions {
  /** Absolute path to the run directory (`generated/runs/<brief>/<runId>`). */
  readonly runDir: string;
  /**
   * The `iconBatch` array from the brief (index N maps to cell N on the sheet).
   * Must match the number of candidate cells that were generated.
   */
  readonly iconBatch: readonly IconBatchEntry[];
  /**
   * Absolute path to `public/assets/generated/manifest.json`. Approve derives
   * the generated directory from this path and writes per-asset shards under
   * `entries/<iconId>.json`.
   */
  readonly manifestPath: string;
  /** Absolute path to `public/assets/` (parent of `generated/`). */
  readonly publicAssetsDir: string;
  /** Absolute path to the repo root, used to compute `sourceRun` relative path. */
  readonly repoRoot: string;
  /**
   * Zero-based cell indices to SKIP (e.g. icons the operator judged as poor
   * quality). Default: approve all cells whose processed PNG exists.
   */
  readonly skipIndices?: ReadonlySet<number>;
  /** Clock injection for deterministic tests. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /** Injected fs for tests. Defaults to `node:fs`. */
  readonly fs?: ApproveFs;
  readonly allowReapprove?: boolean;
  /**
   * When `true`, cells with `judgeScorecard.hardBlocked === true` are approved
   * despite the judge veto. Defaults to `false` (fail-closed).
   * Reserved for conscious human overrides; automated batch runs must not set
   * this flag.
   */
  readonly allowHardBlocked?: boolean;
}

/**
 * Approve an entire icon-batch run as a set of individual icon assets.
 *
 * Unlike `approveVariant` (one design-alternative cell → `briefId-var-N`),
 * this function maps each cell by index to its declared icon `id` from
 * `iconBatch`, writing:
 *   - `public/assets/generated/<iconId>.png`
 *   - a manifest shard keyed by `iconId` (not `briefId-var-N`)
 *
 * This lets icons be referenced directly by their semantic ID (e.g.
 * `achv-first-bonk`) rather than by generation-run metadata. Cells listed in
 * `skipIndices` are silently skipped. Cells whose processed PNG is missing are
 * also skipped (non-fatal — a partial batch still ships the good icons).
 *
 * Returns an array of all approved manifest entries, in cell-index order.
 */
export function approveIconBatch(options: ApproveIconBatchOptions): ManifestEntry[] {
  const fs = options.fs ?? DEFAULT_FS;
  const now = options.now ?? (() => new Date());
  const skipIndices = options.skipIndices ?? new Set<number>();

  const summaryPath = path.join(options.runDir, 'summary.json');
  if (!fs.existsSync(summaryPath)) {
    throw new ApproveError('run-not-found', `Run directory has no summary.json: ${options.runDir}`);
  }

  const summary = parseSummary(fs.readFileSync(summaryPath, 'utf8'), summaryPath);
  const sourceRun = toRepoRelativePosix(options.repoRoot, options.runDir);
  const rawBriefId = summary.brief;
  if (!rawBriefId) {
    throw new ApproveError('summary-invalid', `summary.json has no "brief" field: ${summaryPath}`);
  }
  const briefId = rawBriefId;

  const type = resolveBriefType(fs, options.repoRoot, summary.briefPath);
  const generatedDir = path.join(options.publicAssetsDir, 'generated');
  const processedDir = path.join(options.runDir, 'processed');
  const candidatesByIndex = new Map((summary.candidates ?? []).map((c) => [c.index, c]));

  // Safety: the processed-cell count MUST exactly match the iconBatch entry
  // count. A short run (model/slicer dropped a row or cell) renumbers the
  // surviving processed files contiguously, so a count < length is just as
  // dangerous as count > length — both map later concepts to wrong icon IDs.
  // Require an exact match before any writes; missing individual PNG files
  // (per-cell gaps after the guard passes) are still handled non-fatally below.
  const processedCount = (summary.candidates ?? []).length;
  if (processedCount !== options.iconBatch.length) {
    throw new ApproveError(
      'icon-batch-count-mismatch',
      `Run produced ${processedCount} processed cells but iconBatch has ${options.iconBatch.length} entries. ` +
        `Counts must match exactly — a short or over-run risks mapping icons to the wrong IDs. ` +
        `Re-run with the correct brief or use skipIndices to exclude unwanted cells.`,
    );
  }

  const approved: ManifestEntry[] = [];

  for (let cellIndex = 0; cellIndex < options.iconBatch.length; cellIndex++) {
    if (skipIndices.has(cellIndex)) continue;

    const iconEntry = options.iconBatch[cellIndex]!;
    const iconId = iconEntry.id;
    const padded = padIndex(cellIndex);
    const processedPng = path.join(processedDir, `${padded}.png`);

    if (!fs.existsSync(processedPng)) {
      // Non-fatal: partial batches (model dropped a cell) still ship the rest.
      process.stderr.write(
        `approveIconBatch: processed PNG missing for cell ${cellIndex} (${iconId}), skipping.\n`,
      );
      continue;
    }

    const processedBytes = fs.readFileSync(processedPng);
    const contentHash = createHash('sha256').update(processedBytes).digest('hex');

    // Hard-block gate: mirrors the same contract in approveVariant. A judge-
    // issued hard-block is a veto, not a score to be weighed. Refuse unless
    // the caller explicitly opts out with allowHardBlocked: true (reserved for
    // conscious human overrides; automated batch runs must not set this flag).
    const candidate = candidatesByIndex.get(cellIndex);
    if (candidate?.judgeScorecard?.hardBlocked === true && !options.allowHardBlocked) {
      const instruction = candidate.judgeScorecard.hardBlockInstruction;
      throw new ApproveError(
        'hard-blocked',
        `Cell ${cellIndex} (${iconId}) was hard-blocked by the judge and cannot be approved. ` +
          (instruction ? `Judge instruction: "${instruction}". ` : '') +
          `Pass allowHardBlocked: true to override deliberately.`,
      );
    }

    if (!options.allowReapprove) {
      const existing = readManifestEntry(fs, options.manifestPath, iconId);
      if (existing) {
        const storedHash =
          existing.contentHash && existing.contentHash.length > 0
            ? existing.contentHash
            : hashFileIfExists(fs, path.join(generatedDir, `${iconId}.png`));
        if (storedHash !== null && storedHash === contentHash) {
          process.stderr.write(
            `approveIconBatch: icon "${iconId}" already approved with identical content, skipping.\n`,
          );
          approved.push(existing);
          continue;
        }
      }
    }

    let opaqueBounds: DerivedBounds | undefined;
    try {
      opaqueBounds = deriveOpaqueBounds(PNG.sync.read(processedBytes));
    } catch {
      opaqueBounds = undefined;
    }

    const assetAbsPath = path.join(generatedDir, `${iconId}.png`);
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.copyFileSync(processedPng, assetAbsPath);

    const sensorScore =
      typeof candidate?.score === 'number' && typeof candidate.outOf === 'number'
        ? `${candidate.score}/${candidate.outOf}`
        : 'unknown';
    const judgeScore =
      typeof candidate?.judgeScorecard?.minScore === 'number'
        ? String(candidate.judgeScorecard.minScore)
        : null;

    const entry: ManifestEntry = {
      briefId,
      spriteName: iconId,
      assetPath: `generated/${iconId}.png`,
      approvedAt: now().toISOString(),
      sourceRun,
      variantIndex: cellIndex,
      anchor: null,
      anchors: { hold: null, centerOfGravity: null },
      sensorScore,
      judgeScore,
      sensorBreakdown: candidate?.breakdown,
      judgeScorecard: candidate?.judgeScorecard ?? null,
      type,
      contentHash,
      ...(opaqueBounds !== undefined ? { opaqueBounds } : {}),
      postprocessOverrideProfilePath: null,
      effectivePipelineSnapshotPath: null,
      effectivePipelineSnapshotYamlPath: null,
      effectiveAnchorSource: null,
    };

    upsertManifest(fs, options.manifestPath, entry, iconId);
    approved.push(entry);
  }

  return approved;
}

/**
 * Error thrown by `unapproveVariant` when the operation cannot proceed.
 * Discriminated by `kind` so callers can translate to HTTP status / exit code.
 */
export class UnapproveError extends Error {
  constructor(
    public readonly kind: 'not-found' | 'manifest-invalid',
    message: string,
  ) {
    super(message);
    this.name = 'UnapproveError';
  }
}

export interface UnapproveVariantOptions {
  /**
   * Variant id (`<briefId>-var-<N>`), the manifest key to remove.
   * Must match a shard file name in `entries/` exactly.
   */
  readonly variantId: string;
  /**
   * Absolute path to `public/assets/generated/manifest.json`. The aggregate is a
   * gitignored build artifact; unapprove derives the generated directory from
   * this path and deletes the per-asset shard under `entries/<key>.json`.
   */
  readonly manifestPath: string;
  /**
   * @deprecated The `generated:` catalog rows are DERIVED from the manifest
   * shards; unapprove no longer edits the catalog. Accepted for backward
   * compatibility and ignored.
   */
  readonly catalogPath?: string;
  /** Absolute path to `public/assets/` (parent of `generated/`). */
  readonly publicAssetsDir: string;
  /**
   * When true (default), also deletes the approved PNG from
   * `publicAssetsDir/generated/<variantId>.png`. Set false to
   * keep the asset on disk (e.g. for a dry-run preview).
   */
  readonly deleteAsset?: boolean;
  /** Injected fs for tests. Defaults to `node:fs`. */
  readonly fs?: UnapproveFs;
}

/**
 * Evict one approved variant from the repo's checked-in art surface.
 *
 * This is the inverse of `approveVariant`. It deletes the per-asset manifest
 * shard and (by default) the PNG from `public/assets/generated/`. The
 * `generated:` catalog rows are derived from the manifest, so removing the shard
 * removes the catalog row automatically — there is no separate catalog edit.
 *
 * Steps:
 *   1. Locate the shard for `variantId` under `entries/`.
 *   2. Read + return the entry, then delete the shard.
 *   3. If `deleteAsset` is true (default), delete the PNG file.
 *
 * Throws `UnapproveError('not-found')` when the shard is absent, or
 * `UnapproveError('manifest-invalid')` for a corrupt shard.
 */
export function unapproveVariant(options: UnapproveVariantOptions): ManifestEntry {
  const deleteAsset = options.deleteAsset !== false;
  const fs = options.fs ?? DEFAULT_UNAPPROVE_FS;

  const generatedDir = path.dirname(options.manifestPath);
  const shardsRoot = path.join(generatedDir, 'entries');
  // `shardPathForKey` routes through `assertSafeManifestKey`, which throws for an
  // unsafe key (empty, `..`/`.` segment, absolute, or backslash) BEFORE any fs
  // access. Convert that into the unapprove contract: an unsafe key is simply
  // "not approved", never a leaked low-level error and never an fs touch.
  let shardPath: string;
  try {
    shardPath = shardPathForKey(generatedDir, options.variantId);
  } catch {
    throw new UnapproveError(
      'not-found',
      `Variant "${options.variantId}" is not approved (unsafe manifest key).`,
    );
  }

  // Defense-in-depth: even for a key that passed `assertSafeManifestKey`, refuse
  // any shard path that resolves outside the entries/ tree.
  if (!path.resolve(shardPath).startsWith(path.resolve(shardsRoot) + path.sep)) {
    throw new UnapproveError(
      'not-found',
      `Variant "${options.variantId}" is not approved (shard path escapes entries/).`,
    );
  }

  // 1. Locate the shard.
  if (!fs.existsSync(shardPath)) {
    throw new UnapproveError(
      'not-found',
      `Variant "${options.variantId}" is not approved (no shard at ${shardPath}).`,
    );
  }

  // 2. Read + validate the entry, then delete the shard.
  let entry: ManifestEntry;
  try {
    entry = JSON.parse(fs.readFileSync(shardPath, 'utf8')) as ManifestEntry;
  } catch (err) {
    throw new UnapproveError(
      'manifest-invalid',
      `Shard ${shardPath} is not parseable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  fs.unlinkSync(shardPath);

  // 3. Delete the on-disk PNG when requested.
  if (deleteAsset) {
    const assetGeneratedDir = path.join(options.publicAssetsDir, 'generated');
    const assetAbsPath = path.join(assetGeneratedDir, `${options.variantId}.png`);
    // Safety guard: ensure the resolved path stays inside generated/ to prevent
    // a variantId like `../../etc/passwd` from traversing outside the tree.
    if (!path.resolve(assetAbsPath).startsWith(path.resolve(assetGeneratedDir) + path.sep)) {
      // Skip deletion — the shard was already removed above.
      return entry;
    }
    if (fs.existsSync(assetAbsPath)) {
      fs.unlinkSync(assetAbsPath);
    }
  }

  return entry;
}
