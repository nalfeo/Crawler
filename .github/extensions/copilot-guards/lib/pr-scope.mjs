// PR scope classifier for the pr-review-ledger guard.
//
// Decides whether a branch diff is "non-code only" (docs / art / dependency
// lockfiles / config) and therefore exempt from the review-ledger requirement, vs.
// "code-touching" and therefore required to ship a review ledger.
//
// Design rule (see plan-review concern #2): this is a STRICT ALLOWLIST of
// skippable paths. Anything not explicitly listed — including scripts/**,
// .github/workflows/**, .github/extensions/**, .github/skills/**,
// .github/copilot-instructions.md, eslint/vite/vitest/tsconfig/commitlint
// config, and package.json — counts as CODE and requires a ledger. We never
// classify any src/** path as skippable EXCEPT entity-sprite mappings and
// other whitelisted config files. Erring toward over-enforcement is intentional:
// a skipped review is a silent hole, a needless ledger is cheap.

// Skippable buckets (paths are normalized to forward slashes first).
const DOCS_RE = /^docs\//;
const ROOT_DOC_RE = /^[^/]+\.(md|txt)$/; // README.md, CHANGELOG.md, LICENSE.txt, ...
const ART_RE = /^(public\/assets|briefs|data\/palettes)\//;
const DEPS_RE = /^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;
const CONFIG_RE = /^src\/shared\/data\/(entity-sprite-mappings|sprite-catalog)\.(json)$/;

// src/** is NEVER skippable EXCEPT for whitelisted config files (defense in depth).
const SRC_NEVER_RE = /^src\//;
const CONFIG_ALLOWLIST_RE = /^src\/shared\/data\//;

function normalize(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Classify a single path into 'docs' | 'art' | 'deps' | 'config' | 'code'. */
export function classifyPath(p) {
  const f = normalize(p);
  if (DOCS_RE.test(f) || ROOT_DOC_RE.test(f)) return 'docs';
  if (ART_RE.test(f)) return 'art';
  if (DEPS_RE.test(f)) return 'deps';
  if (CONFIG_ALLOWLIST_RE.test(f) && CONFIG_RE.test(f)) return 'config';
  if (SRC_NEVER_RE.test(f)) return 'code';
  return 'code';
}

/** True if a path is skippable (docs/art/deps) and not code. */
export function isSkippablePath(p) {
  return classifyPath(p) !== 'code';
}

/**
 * True if EVERY changed file is non-code (docs/art/deps). An empty list is
 * NOT non-code-only — the caller decides what to do with an empty diff.
 * @param {string[]} files
 */
export function isNonCodeOnlyDiff(files) {
  if (!Array.isArray(files) || files.length === 0) return false;
  return files.every(isSkippablePath);
}

/** Names of the code files in a diff (for explaining why a ledger is required). */
export function codeFiles(files) {
  if (!Array.isArray(files)) return [];
  return files.map(normalize).filter((f) => classifyPath(f) === 'code');
}

export { DOCS_RE, ROOT_DOC_RE, ART_RE, DEPS_RE, CONFIG_RE, CONFIG_ALLOWLIST_RE, SRC_NEVER_RE };
