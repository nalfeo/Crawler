/**
 * Shared path-resolution helpers used by doc-check scripts.
 *
 * Centralising these here avoids copy-paste drift across the growing set of
 * automation checks under `scripts/agent/docs/`.
 */

import { statSync } from 'node:fs';
import { fromRepo } from './report.js';

export const PATH_PREFIXES = [
  './',
  'src/',
  'scripts/',
  'tests/',
  'docs/',
  '.github/',
  '.specify/',
  'public/',
  'briefs/',
  'data/',
  'tools/',
];

export const PATH_EXTS = ['.ts', '.tsx', '.md', '.json', '.yml', '.yaml', '.sh', '.mjs', '.cjs'];

/**
 * Heuristically decide whether a backtick-quoted string looks like a repo
 * file/directory path worth checking against the file system.
 *
 * Exclusion rationale:
 *  - Strings with spaces / http URLs / npm or bash commands — these are prose, not paths.
 *  - Strings containing `<` or `>` — HTML tags or template placeholders like `<slug>`.
 *  - Strings containing YYYY, NNNN, or starting with "NN-" — date/ADR templates.
 */
export function looksLikePath(s: string): boolean {
  if (s.includes(' ') || s.startsWith('http') || s.startsWith('npm ') || s.startsWith('bash '))
    return false;
  if (s.includes('<') || s.includes('>')) return false;
  if (/\bYYYY\b/.test(s) || /\bNNNN\b/.test(s) || /\bNN-/.test(s)) return false;
  if (PATH_PREFIXES.some((p) => s.startsWith(p))) return true;
  // Extension-only match requires at least one path separator
  if (PATH_EXTS.some((ext) => s.endsWith(ext)) && s.includes('/')) return true;
  return false;
}

/** Return true if `rel` (repo-root-relative) resolves to an existing file or directory. */
export function existsOnDisk(rel: string): boolean {
  try {
    statSync(fromRepo(rel.replace(/\/+$/, '')));
    return true;
  } catch {
    return false;
  }
}

/**
 * For a glob path, check that the parent directory (the last path segment
 * before the first wildcard) exists on disk.
 */
export function parentDirExists(globPath: string): boolean {
  const first = globPath.search(/[*?{]/);
  if (first < 0) return existsOnDisk(globPath);
  // Find the last '/' before the first wildcard to get the true parent directory
  const slashBefore = globPath.lastIndexOf('/', first);
  const parent = slashBefore < 0 ? '' : globPath.slice(0, slashBefore);
  return !parent || existsOnDisk(parent);
}

/**
 * Resolve a candidate path string: strip leading `./`, determine if it is a
 * glob, and check existence accordingly.
 */
export function pathExistsOnDisk(candidate: string): boolean {
  const resolved = candidate.startsWith('./') ? candidate.slice(2) : candidate;
  const isGlob = candidate.includes('*') || candidate.includes('{');
  return isGlob ? parentDirExists(resolved) : existsOnDisk(resolved);
}
