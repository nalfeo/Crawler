/**
 * node-modules-resolver.mjs — shared worktree-aware node_modules resolver
 *
 * Extensions run in a sandboxed process with no access to third-party packages
 * via bare ESM specifiers. Use `createRequire` anchored at the project's real
 * node_modules root.
 *
 * In a git worktree the checkout has NO node_modules — they live in the main
 * checkout. Detect this by checking whether `.git` is a file (worktree marker)
 * and, if so, following the `gitdir:` pointer back to the main checkout.
 *
 * @module workflow/node-modules-resolver
 */

import { createRequire } from 'node:module';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Resolve the node_modules directory that holds the project's third-party
 * packages, handling both regular checkouts (node_modules in the repo root)
 * and git worktrees (node_modules in the main checkout).
 *
 * @param {string} repoRoot  absolute path of the current working tree root
 * @returns {string | null}  absolute path to the node_modules dir, or null
 */
export function resolveNodeModules(repoRoot) {
  const gitPath = path.join(repoRoot, '.git');
  try {
    const stat = statSync(gitPath);
    if (stat.isFile()) {
      // Worktree: .git is a file with content "gitdir: /abs/path/.git/worktrees/<name>"
      const content = readFileSync(gitPath, 'utf8').trim();
      const match = content.match(/^gitdir:\s*(.+)/);
      if (match) {
        // Resolve gitdir relative to the worktree root (handles both abs and rel paths)
        const gitdir = path.resolve(repoRoot, match[1].trim());
        // gitdir == .git/worktrees/<name> → go up 3 levels to reach the checkout root
        const mainRoot = path.resolve(gitdir, '..', '..', '..');
        const candidate = path.join(mainRoot, 'node_modules');
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch {
    // ignore — fall through to the direct check below
  }
  // Non-worktree checkout: node_modules sits directly in the repo root
  const direct = path.join(repoRoot, 'node_modules');
  if (existsSync(direct)) return direct;
  return null;
}

/**
 * Create a CJS `require` function anchored at the project's node_modules root,
 * with worktree support. Falls back to `fallbackUrl` (the calling module's
 * `import.meta.url`) if node_modules cannot be located.
 *
 * @param {string} repoRoot    absolute path of the working tree root
 * @param {string} fallbackUrl `import.meta.url` of the calling module
 * @returns {NodeRequire}
 */
export function createRepoRequire(repoRoot, fallbackUrl) {
  const nodeModules = resolveNodeModules(repoRoot);
  if (!nodeModules) {
    process.stderr.write(
      '[node-modules-resolver] WARNING: could not locate node_modules — third-party requires may fail\n',
    );
  }
  // Anchor require at the main checkout's package.json so node_modules resolution
  // starts at the correct root on the first lookup — no directory traversal needed.
  const anchor = nodeModules ? path.join(nodeModules, '..', 'package.json') : fallbackUrl;
  return createRequire(anchor);
}
