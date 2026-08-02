/**
 * Validate that a manifest / run-summary `assetPath` is a safe, in-tree
 * reference to OUR generated art.
 *
 * This is the load-bearing "our art only, never Kenney" invariant for the
 * reference pipeline. A bare `assetPath.startsWith('generated/')` check is NOT
 * enough: `generated/../kenney/tiny-dungeon/spritesheet.png` passes it yet
 * `path.resolve`s *outside* the generated tree, so a malformed or tampered
 * manifest/summary could smuggle a Kenney (or any local) file back in as a
 * reference — the exact thing this change exists to prevent. So we reject any
 * path that is absolute, uses Windows separators, or contains `.`/`..`/empty
 * segments, and require it to sit under `generated/` and end in `.png`.
 *
 * Pure string check — no filesystem IO, POSIX separators only — so the pure
 * selector can use it without breaking determinism or cross-platform stability.
 * Impure callers should ALSO verify post-resolve containment as defence in
 * depth (see {@link assertResolvedUnderGenerated}).
 */
import path from 'node:path';

/** The only prefix an eligible generated-reference `assetPath` may carry. */
export const GENERATED_ASSET_PREFIX = 'generated/' as const;

/**
 * True iff `assetPath` is a POSIX-relative path under `generated/`, ending in
 * `.png`, with no traversal (`..`), current-dir (`.`), empty, or backslash
 * segments and no NUL bytes. Anything else is rejected (fail closed).
 */
export function isSafeGeneratedAssetPath(assetPath: string): boolean {
  if (typeof assetPath !== 'string' || assetPath.length === 0) return false;
  if (assetPath.includes('\\') || assetPath.includes('\0')) return false;
  if (!assetPath.startsWith(GENERATED_ASSET_PREFIX)) return false;
  if (!assetPath.toLowerCase().endsWith('.png')) return false;
  // Every segment must be an ordinary name — no traversal, self, or empties.
  for (const segment of assetPath.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return false;
  }
  return true;
}

/**
 * Defence-in-depth for impure callers: assert a resolved absolute path stays
 * inside `<publicAssetsRoot>/generated`. Throws with `context` on any escape.
 * Pair with {@link isSafeGeneratedAssetPath} (which already forbids traversal)
 * so a bug in either check alone cannot let a path escape the generated tree.
 */
export function assertResolvedUnderGenerated(
  resolvedAbsolutePath: string,
  publicAssetsRoot: string,
  context: string,
): void {
  const generatedRoot = path.resolve(publicAssetsRoot, 'generated');
  const rel = path.relative(generatedRoot, resolvedAbsolutePath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `${context}: resolved path "${resolvedAbsolutePath}" escapes the generated asset ` +
        `tree "${generatedRoot}". Only files under public/assets/generated may be used as ` +
        `references.`,
    );
  }
}

/**
 * Resolve a generated asset path only after validating both the raw path shape
 * and the post-resolve containment. Returns the absolute path on success and
 * throws with `context` on any malformed or escaping path.
 */
export function resolveGeneratedAssetPath(
  assetPath: string,
  publicAssetsRoot: string,
  context: string,
): string {
  if (!isSafeGeneratedAssetPath(assetPath)) {
    throw new Error(`${context}: assetPath "${assetPath}" is not a safe generated/*.png path.`);
  }
  const resolvedAbsolutePath = path.resolve(publicAssetsRoot, assetPath);
  assertResolvedUnderGenerated(resolvedAbsolutePath, publicAssetsRoot, context);
  return resolvedAbsolutePath;
}
