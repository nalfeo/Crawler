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
import { posix, resolve, sep } from 'node:path';

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

/** Repo-relative POSIX path for `absolutePath`, which must live under `root`. */
function toRelativePosix(root, absolutePath) {
  return absolutePath
    .slice(root.length + 1)
    .split(sep)
    .join(posix.sep);
}

/**
 * Recursively collect `*.test.mjs` files under `absoluteDirectory`.
 * Throws when the directory is missing so a stale root cannot pass silently.
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
 * Discover and run one group with `node --test`.
 *
 * `roots` is injectable so tests can exercise the runner against a fixture
 * tree instead of re-entering the repository's real groups.
 *
 * @returns {number} process exit code (0 only when the child exited 0)
 */
export function runGroup({ group, repoRoot, spawn, roots = rootsForGroup(group), log = () => {} }) {
  const files = discoverTests(repoRoot, roots);
  log(`node --test: ${files.length} file(s) discovered for group "${group}"`);

  const result = spawn(process.execPath, ['--test', ...files], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: false,
  });

  // Fail closed on every non-clean outcome: a spawn error or a signal kill
  // leaves `status` null, which must never be read as success.
  if (result.error) {
    log(`node --test could not be started: ${result.error.message}`);
    return 1;
  }
  if (typeof result.status !== 'number') {
    log(`node --test terminated by signal ${result.signal ?? 'unknown'}`);
    return 1;
  }
  return result.status;
}
