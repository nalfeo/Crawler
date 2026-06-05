// Cached git helpers for PR-preflight. Results are keyed by HEAD sha so
// repeated checks within one PR attempt don't re-shell.

import { execFileSync } from 'node:child_process';

const cache = new Map();

function git(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = err.stderr?.toString() || err.message;
    throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
  }
}

function headSha(cwd) {
  return git(cwd, ['rev-parse', 'HEAD']).trim();
}

function cached(key, cwd, compute) {
  const sha = headSha(cwd);
  const fullKey = `${key}:${cwd}`;
  const entry = cache.get(fullKey);
  if (entry && entry.headSha === sha) return entry.value;
  const value = compute(sha);
  cache.set(fullKey, { headSha: sha, value });
  return value;
}

/**
 * Resolve the merge-base between HEAD and origin/main (or main if no
 * remote). Returns null if nothing resolves (very shallow clone, etc).
 */
export function mergeBaseWithMain(cwd) {
  return cached('mergebase', cwd, () => {
    const candidates = ['origin/main', 'main', 'origin/master', 'master'];
    for (const ref of candidates) {
      try {
        return git(cwd, ['merge-base', ref, 'HEAD']).trim();
      } catch {
        /* try next */
      }
    }
    try {
      return git(cwd, ['rev-parse', 'HEAD~1']).trim();
    } catch {
      return null;
    }
  });
}

/**
 * Files changed on the current branch since the merge-base with main.
 * POSIX-style paths.
 */
export function branchFiles(cwd) {
  return cached('branchfiles', cwd, () => {
    const base = mergeBaseWithMain(cwd);
    if (!base) return [];
    const out = git(cwd, ['diff', '--name-only', `${base}...HEAD`]);
    return out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  });
}

/**
 * Files ADDED on the current branch since the merge-base with main.
 * Uses `git diff --name-status` and filters to status 'A' so callers
 * that need "newly added" semantics (e.g. handoff check) aren't fooled
 * by edits to pre-existing files.
 */
export function branchAddedFiles(cwd) {
  return cached('branchaddedfiles', cwd, () => {
    const base = mergeBaseWithMain(cwd);
    if (!base) return [];
    const out = git(cwd, ['diff', '--name-status', `${base}...HEAD`]);
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => line.startsWith('A\t'))
      .map((line) => line.slice(2).trim());
  });
}

/**
 * Commit subjects on the branch since merge-base with main, excluding merges.
 */
export function branchCommitSubjects(cwd) {
  return cached('subjects', cwd, () => {
    const base = mergeBaseWithMain(cwd);
    if (!base) return [];
    const out = git(cwd, ['log', '--no-merges', '--format=%s', `${base}..HEAD`]);
    return out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  });
}

export function _resetCache() {
  cache.clear();
}
