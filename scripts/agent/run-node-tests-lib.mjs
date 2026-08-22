/**
 * Deterministic discovery for the repository's `node --test` suites.
 *
 * These suites used to be enumerated file-by-file inside `package.json`
 * (`test:guards` was a single 1311-character line listing 161 paths). Because
 * it was one physical line that every new extension/script had to append to,
 * it was the repo's #1 hand-authored merge-conflict magnet: two PRs that each
 * registered a new suite conflicted by construction. Deriving the list from
 * the filesystem removes the shared line entirely and stops suites from being
 * silently unregistered when somebody forgets to add them.
 *
 * Discovery is fail-closed on purpose: every configured root must yield at
 * least one test file. A renamed or mistyped root is a loud error, never a
 * vacuously green gate.
 */
import { readdirSync } from 'node:fs';
import process from 'node:process';
import { posix, relative, resolve, sep } from 'node:path';

/** File suffix that marks a `node --test` suite. */
const TEST_SUFFIX = '.test.mjs';

/** Directories never worth walking. */
const IGNORED_DIRECTORIES = new Set(['node_modules', '.git']);

/**
 * Named groups of roots, mirroring the npm scripts that consume them.
 * Each root is repo-relative and must contain at least one `*.test.mjs`.
 */
export const TEST_GROUPS = Object.freeze({
  guards: Object.freeze(['.github/extensions', '.github/scripts', 'scripts/agent']),
  'sweep-viewer': Object.freeze(['.github/extensions/sweep-results-viewer/tests']),
});

/**
 * Repo-relative POSIX path for `absolutePath`. `path.relative` (rather than a
 * prefix slice) keeps this correct on Windows, where drive-letter casing and
 * trailing separators would otherwise corrupt the result.
 */
function toRelativePosix(root, absolutePath) {
  return relative(root, absolutePath).split(sep).join(posix.sep);
}

/**
 * Recursively collect `*.test.mjs` files under `absoluteDirectory`.
 *
 * Throws when the directory is missing so a stale root cannot pass silently.
 * Symlinks are not followed (`Dirent.isDirectory()` is false for them), which
 * also makes the walk immune to symlink cycles.
 */
function walk(repoRoot, absoluteDirectory, found) {
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      walk(repoRoot, resolve(absoluteDirectory, entry.name), found);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(TEST_SUFFIX)) {
      found.push(toRelativePosix(repoRoot, resolve(absoluteDirectory, entry.name)));
    }
  }
  return found;
}

/**
 * Discover every test file under `roots`, sorted for deterministic ordering.
 *
 * @param {string} repoRoot absolute path to the repository root
 * @param {readonly string[]} roots repo-relative directories to search
 * @returns {string[]} repo-relative POSIX paths, sorted
 * @throws when a root does not exist or contains no test files
 */
export function discoverTests(repoRoot, roots) {
  if (roots.length === 0) throw new Error('No roots configured for discovery');

  const found = [];
  for (const root of roots) {
    const absoluteRoot = resolve(repoRoot, root);
    let matches;
    try {
      matches = walk(repoRoot, absoluteRoot, []);
    } catch (error) {
      throw new Error(`Test root "${root}" could not be read: ${error.message}`, { cause: error });
    }
    if (matches.length === 0) {
      throw new Error(
        `Test root "${root}" matched no ${TEST_SUFFIX} files. ` +
          'Fix or remove the root — an empty root would silently weaken the gate.',
      );
    }
    found.push(...matches);
  }

  // Sort with a plain codepoint comparison (not localeCompare) so the order is
  // identical on every platform and locale.
  return [...new Set(found)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Roots for `group`, or a thrown error naming the valid groups. */
export function rootsForGroup(group) {
  const roots = TEST_GROUPS[group];
  if (!roots) {
    throw new Error(
      `Unknown test group "${group}". Valid groups: ${Object.keys(TEST_GROUPS).join(', ')}`,
    );
  }
  return roots;
}

/**
 * Conservative per-invocation argument budget, in characters.
 *
 * Windows caps a `CreateProcess` command line at 32,767 characters, so a
 * single `node --test <every file>` call would eventually break there as the
 * suite grows. Chunking keeps each invocation well inside that ceiling on
 * every platform while preserving the discovered (sorted) order.
 */
export const ARG_BUDGET_CHARS = 16000;

/** Split `files` into deterministic, budget-bounded batches. */
export function chunkFiles(files, budget = ARG_BUDGET_CHARS) {
  const chunks = [];
  let current = [];
  let length = 0;
  for (const file of files) {
    // +1 for the separating space the OS command line needs.
    const cost = file.length + 1;
    if (current.length > 0 && length + cost > budget) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(file);
    length += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Discover and run one group with `node --test`.
 *
 * `roots` is injectable so tests can exercise the runner against a fixture
 * tree instead of re-entering the repository's real groups.
 *
 * @returns {number} process exit code (0 only when every batch exited 0)
 */
export function runGroup({
  group,
  repoRoot,
  spawn,
  roots = rootsForGroup(group),
  argBudget = ARG_BUDGET_CHARS,
  log = () => {},
}) {
  const files = discoverTests(repoRoot, roots);
  const batches = chunkFiles(files, argBudget);
  log(
    `node --test: ${files.length} file(s) discovered for group "${group}" ` +
      `in ${batches.length} batch(es)`,
  );

  let exitCode = 0;
  for (const batch of batches) {
    const result = spawn(process.execPath, ['--test', ...batch], {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: false,
    });

    // Fail closed on every non-clean outcome: a spawn error or a signal kill
    // leaves `status` null, which must never be read as success.
    if (result.error) {
      log(`node --test could not be started: ${result.error.message}`);
      exitCode = exitCode || 1;
      continue;
    }
    if (typeof result.status !== 'number') {
      log(`node --test terminated by signal ${result.signal ?? 'unknown'}`);
      exitCode = exitCode || 1;
      continue;
    }
    // Run every batch so one failing suite does not hide later failures, but
    // keep the first non-zero code as the group's result.
    if (result.status !== 0) exitCode = exitCode || result.status;
  }
  return exitCode;
}
