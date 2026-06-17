import type { Brief } from './brief-schema.js';
/**
 * Read and parse the style guide markdown file.
 *
 * Looks for the verbatim block between the START and END markers, strips the
 * leading "> " blockquote prefix, and returns the result as a single string.
 * Throws if the markers are missing or out of order — that's a developer
 * error in the style guide, not a runtime input bug.
 *
 * @param repoRoot - Absolute path to the repository root.
 * @param read - File reader, injectable for tests.
 */
export declare function loadStyleGuide(repoRoot: string, read?: (path: string) => string): string;
export declare function extractPreamble(markdown: string): string;
/**
 * Build a prompt for a single-variant (non-sheet) generation.
 *
 * Phase 2 always uses sheet mode in the orchestrator, but the single-variant
 * builder is kept available for ad-hoc tools and future single-image refinement
 * passes. Sharing the same structure with the sheet builder also makes it
 * trivial to diff "what's different about sheet mode?" in tests.
 */
export declare function buildPrompt(brief: Brief, styleGuide: string): string;
/**
 * Build a prompt for a multi-variant sheet generation.
 *
 * The generator is told the exact grid shape (rows × cols), the exact total
 * variant count, and the cells (if any) that must be left empty. We also
 * repeat the per-variant constraints (no clipping, square, no text) at the
 * end of the prompt because models in our manual e2e ignored them when they
 * appeared only at the top.
 */
export declare function buildSheetPrompt(
  brief: Brief,
  styleGuide: string,
  variants?: number,
): string;
//# sourceMappingURL=build-prompt.d.ts.map
