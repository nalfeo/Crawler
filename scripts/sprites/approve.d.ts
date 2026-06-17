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
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
/** Subset of `node:fs` calls approveVariant needs. Exposed for tests. */
export interface ApproveFs {
  readonly existsSync: typeof existsSync;
  readonly readFileSync: typeof readFileSync;
  readonly writeFileSync: typeof writeFileSync;
  readonly copyFileSync: typeof copyFileSync;
  readonly mkdirSync: typeof mkdirSync;
}
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
export declare const MANIFEST_VERSION: 1;
export declare class ApproveError extends Error {
  readonly kind:
    | 'run-not-found'
    | 'summary-invalid'
    | 'variant-not-found'
    | 'processed-missing'
    | 'manifest-invalid';
  constructor(
    kind:
      | 'run-not-found'
      | 'summary-invalid'
      | 'variant-not-found'
      | 'processed-missing'
      | 'manifest-invalid',
    message: string,
  );
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
export declare function approveVariant(options: ApproveVariantOptions): ManifestEntry;
/**
 * Compute a stable short hash for a manifest entry. Currently only used by
 * test snapshots / future cache-busting; export so consumers don't have to
 * recompute the hashing convention.
 */
export declare function entryHash(entry: ManifestEntry): string;
//# sourceMappingURL=approve.d.ts.map
