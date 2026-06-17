/**
 * Reference spritesheet allow-list.
 *
 * The brief synthesizer (`scripts/sprites/synthesize-brief.ts`) lets an
 * LLM pick reference sprite-sheets that ground the generation call's
 * style + silhouette. Letting the model name raw filesystem paths is
 * unsafe — it would invent paths that don't exist on disk, point
 * outside the repo, or smuggle path-traversal segments. This module
 * is the only place that resolves a stable *id* into a real file path.
 *
 * Behaviour:
 *   - Discover all `public/assets/kenney/<pack>/spritesheet.png` files
 *     on disk. The pack-directory name becomes the stable id.
 *   - Attach a hand-curated one-line note per known pack describing
 *     what it contains, so the LLM can match the right pack to the
 *     subject. Unknown packs fall back to a generic note rather than
 *     dropping out of the catalog.
 *   - Expose `resolveReferenceId(id)` which returns the validated
 *     repo-relative path or throws if the id is not in the catalog.
 *
 * The module is pure given (`repoRoot`, `readdir`-style hook) so unit
 * tests build catalogs without touching real disk.
 */
export interface ReferenceSheet {
  /** Stable id — the pack directory name (e.g. `tiny-dungeon`). */
  readonly id: string;
  /** Repo-relative path to the spritesheet PNG (forward slashes). */
  readonly path: string;
  /** One-line note describing the pack's contents. */
  readonly note: string;
}
export interface BuildReferenceCatalogOptions {
  readonly repoRoot: string;
  /**
   * Override the directory enumerator. Tests pass a fake to avoid
   * touching disk. The fake receives the absolute path to
   * `public/assets/kenney`.
   */
  readonly readPacks?: (kenneyRoot: string) => ReadonlyArray<string>;
  /**
   * Override the per-file existence check. Tests use this to assert
   * the existence guard fires when a directory entry's
   * `spritesheet.png` is missing.
   */
  readonly fileExists?: (absolutePath: string) => boolean;
}
export declare function buildReferenceCatalog(
  options: BuildReferenceCatalogOptions,
): ReadonlyArray<ReferenceSheet>;
/**
 * Resolve a model-supplied reference id into a validated repo-relative
 * path. Throws if the id is not in the catalog. Used both at
 * validation time (synthesize-brief) and as the single mapping point
 * from "what the LLM said" → "what we write into YAML".
 */
export declare function resolveReferenceId(
  catalog: ReadonlyArray<ReferenceSheet>,
  id: string,
): ReferenceSheet;
/**
 * Format the catalog as a short list block suitable for embedding in
 * the LLM system prompt. Stable formatting helps the prompt hash.
 */
export declare function formatCatalogForPrompt(catalog: ReadonlyArray<ReferenceSheet>): string;
//# sourceMappingURL=reference-allow-list.d.ts.map
