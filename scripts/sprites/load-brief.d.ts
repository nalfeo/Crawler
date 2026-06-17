/**
 * Brief loader.
 *
 * Reads a YAML brief from disk, merges per-type defaults, validates the
 * merged result against the Zod schema, and resolves the palette `id` into
 * actual `[r, g, b]` color triples loaded from `data/palettes/<id>.json`.
 *
 * Authors write minimal briefs — typically just `type`, `name`, and
 * `description` — and per-type defaults from `data/sprite-types/<type>.json`
 * fill in everything else (size, palette, anchor, references, sheet layout,
 * sensor thresholds). Any field present on the minimal brief overrides the
 * default at that path. The `description` field becomes the `prompt` if the
 * author hasn't set `prompt` explicitly.
 *
 * Why a dedicated module: every consumer (CLI, lab sidecar, tests) wants
 * the same disk-to-validated-brief pipeline. Centralising the merge +
 * validation here keeps the post-processor / scorer / orchestrator
 * unchanged when we add new defaults, brief locations, or palette sources.
 *
 * Pure-ish: this module touches the filesystem (it has to), but given the
 * same inputs (file contents) it produces identical outputs.
 */
import { type Brief, type PaletteColors, type SpriteTypeDefaults } from './brief-schema.js';
export interface LoadedBrief {
  readonly brief: Brief;
  /** Resolved palette colors, from `data/palettes/<brief.palette.id>.json`. */
  readonly palette: PaletteColors;
  /** Absolute path the brief was loaded from — useful for diagnostics + retries. */
  readonly briefPath: string;
}
export interface LoadBriefOptions {
  /**
   * Project root for resolving `data/palettes/<id>.json` and
   * `data/sprite-types/<type>.json`. Defaults to `process.cwd()` which is
   * correct when the CLI is invoked through `npm run sprites:run` from the
   * repo root.
   */
  readonly projectRoot?: string;
  /**
   * Override palette loading entirely — used by tests so they can avoid
   * hitting the disk. When supplied, this is called with the brief's palette
   * id and must return the resolved colors.
   */
  readonly loadPalette?: (paletteId: string) => PaletteColors;
  /**
   * Override per-type defaults loading. Used by tests to avoid disk access
   * and to keep test briefs fully self-contained. When supplied, this is
   * called with the brief's `type` and must return the defaults object (or
   * `null` to skip merging — useful for legacy fully-specified briefs).
   */
  readonly loadTypeDefaults?: (type: string) => SpriteTypeDefaults | null;
}
export declare function loadBrief(briefPath: string, opts?: LoadBriefOptions): LoadedBrief;
/**
 * Merge a minimal brief on top of per-type defaults. Pure; exposed so tests
 * can exercise the merge semantics directly without disk I/O.
 *
 * - `description` becomes `prompt` when the merged brief has no explicit
 *   `prompt`. The `description` field is then stripped because the strict
 *   `briefSchema` doesn't allow unknown keys.
 * - `defaults` is treated as immutable.
 * - When `defaults` is `null` (loader returned no defaults for the type),
 *   the minimal brief is passed through more or less verbatim. The
 *   author is then responsible for supplying every required field.
 */
export declare function mergeMinimalIntoDefaults(
  minimal: Record<string, unknown>,
  defaults: SpriteTypeDefaults | null,
): Record<string, unknown>;
//# sourceMappingURL=load-brief.d.ts.map
