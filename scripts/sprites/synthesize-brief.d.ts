/**
 * Brief synthesizer — turns a subject name into N reviewable
 * minimal-brief YAML candidates.
 *
 * Workflow:
 *   1. Refuse if `env.CI` is set (constitutional §3: synthesizer is
 *      local-only because each call costs money and is non-deterministic).
 *   2. Normalise + validate the subject name (lowercase kebab-case, no
 *      path separators, ≤64 chars).
 *   3. Build the reference allow-list from disk.
 *   4. Issue ONE structured-output call to the synth provider for all
 *      N candidates. Per-candidate calls would scale cost linearly for
 *      no quality gain.
 *   5. For each candidate:
 *        a. Reject if the description contains a banned vague adjective.
 *        b. Reject if any reference id is not in the catalog OR its
 *           file does not exist on disk. (Catalog membership alone is
 *           technically enough — the catalog only contains existing
 *           files — but the explicit existence check is a defence
 *           against a stale in-memory catalog if anything ever
 *           re-introduces caching here.)
 *        c. Require 2-3 references and 3-5 embellishment seeds.
 *   6. Decide write policy with `partial`:
 *        - `partial=false` (default): if any candidate is rejected, throw
 *          an aggregated error and write nothing.
 *        - `partial=true`: write the valid candidates and surface
 *          rejections in the sidecar.
 *   7. If type was not supplied: require `typeConfidence >= 0.9`,
 *      otherwise throw (the user must re-run with --type).
 *   8. Write `<outDir>/<name>/<name>-v{1,N}.yaml` and `synthesis.json`.
 *      Atomic-ish: all validation happens before any write.
 *
 * Everything except the provider call and the filesystem hooks is pure.
 */
import { SPRITE_TYPES, type Brief } from './brief-schema.js';
import { type BuildReferenceCatalogOptions } from './reference-allow-list.js';
import type { SynthProvider } from './provider/synth-types.js';
export type SpriteType = Brief['type'];
export declare const MIN_CANDIDATES = 1;
export declare const MAX_CANDIDATES = 5;
export interface SynthesizeBriefOptions {
  /** Subject name. Will be normalised to kebab-case. */
  readonly name: string;
  /**
   * Caller-supplied type. When omitted, the model must classify with
   * `typeConfidence >= ${MIN_TYPE_CONFIDENCE}` or the call throws.
   */
  readonly type?: SpriteType;
  /** Number of candidates to request. Default 3, capped at MAX_CANDIDATES. */
  readonly candidates?: number;
  /** Synth provider — typically `createSynthProvider()` from `factory`. */
  readonly provider: SynthProvider;
  /** Repository root used to resolve the reference catalog + output dir. */
  readonly repoRoot: string;
  /**
   * Output directory. Defaults to `<repoRoot>/generated/brief-candidates`.
   * Each call writes into `<outputRoot>/<name>/`.
   */
  readonly outputRoot?: string;
  /**
   * When true, write all candidates that pass validation even if some
   * fail. Default false: if any candidate fails, the whole run aborts
   * with an aggregated error and no files are written.
   */
  readonly partial?: boolean;
  /**
   * Environment source for the CI guard. Defaults to `process.env`.
   * Tests pass an empty object to exercise the success path.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Optional override for the reference-catalog builder hooks. Lets
   * unit tests bypass disk lookups while still exercising the real
   * allow-list module.
   */
  readonly referenceCatalogOptions?: Pick<BuildReferenceCatalogOptions, 'readPacks' | 'fileExists'>;
  /**
   * Optional override for the per-candidate filesystem re-check. The
   * catalog builder already proves each reference's `spritesheet.png`
   * exists at catalog-build time; this hook is the defence-in-depth
   * check that fires if a sheet is deleted/renamed between catalog
   * build and YAML write. Production uses the same `statSync`-based
   * default as the catalog builder; tests inject a separate function
   * so the failure mode can be exercised directly.
   */
  readonly referenceFileExistsAtSynthesisTime?: (absolutePath: string) => boolean;
  /**
   * Optional override for filesystem writes. Tests inject an in-memory
   * sink; production uses real `fs`.
   */
  readonly fsWrites?: FsWriteHooks;
  /**
   * Optional override for resolving a sprite type's `minVariations`
   * default. Production reads `data/sprite-types/<type>.json` from
   * `repoRoot`; tests inject a literal map so they stay hermetic.
   * Returning `null` means "no override" and the schema default of
   * `${DEFAULT_MIN_VARIATIONS}` is used.
   */
  readonly loadMinVariations?: (type: SpriteType) => number | null;
}
export interface FsWriteHooks {
  readonly mkdir: (absolutePath: string) => void;
  readonly writeFile: (absolutePath: string, contents: string) => void;
}
export interface SynthesizedBriefCandidate {
  /** Candidate id: `<name>-v<N>` (1-based). */
  readonly id: string;
  /** Resolved sprite type. */
  readonly type: SpriteType;
  /** Concrete description (becomes the YAML `description` field). */
  readonly description: string;
  /** Resolved references with repo-relative paths. */
  readonly references: ReadonlyArray<{
    readonly path: string;
    readonly note: string;
  }>;
  /** Variation seeds (become the YAML `variations` field). */
  readonly embellishmentSeeds: ReadonlyArray<string>;
  /** Why this candidate's silhouette differs from the others. */
  readonly synthesisRationale: string;
  /** Absolute path of the YAML written to disk (when not skipped). */
  readonly yamlPath: string;
}
export interface SynthesizedBriefRejection {
  /** 1-based index of the rejected candidate. */
  readonly index: number;
  /** Human-readable reason. */
  readonly reason: string;
}
export interface SynthesizeBriefResult {
  readonly name: string;
  readonly type: SpriteType;
  /** Output directory absolute path. */
  readonly outDir: string;
  /** Successfully written candidates. */
  readonly written: ReadonlyArray<SynthesizedBriefCandidate>;
  /** Per-candidate rejections (when `partial: true`). */
  readonly rejected: ReadonlyArray<SynthesizedBriefRejection>;
  /** Sidecar absolute path. */
  readonly sidecarPath: string;
  /** Provider label (e.g. `azure-openai:gpt-4o-mini`). */
  readonly providerLabel: string;
  /** SHA-256 of the system+user prompt template, for reproducibility. */
  readonly promptHash: string;
}
export declare class SynthesizeBriefError extends Error {
  readonly rejections: ReadonlyArray<SynthesizedBriefRejection>;
  readonly name = 'SynthesizeBriefError';
  constructor(message: string, rejections?: ReadonlyArray<SynthesizedBriefRejection>);
}
export declare function synthesizeBrief(
  options: SynthesizeBriefOptions,
): Promise<SynthesizeBriefResult>;
export declare function normaliseName(raw: string): string;
/** Re-exported for the CLI so it can print the canonical sprite type list. */
export { SPRITE_TYPES };
//# sourceMappingURL=synthesize-brief.d.ts.map
