/**
 * yaml-reader.mjs — reusable fs-based reader for the repo's `plans/` and
 * `briefs/` YAML, replacing the monolith's build-time `import.meta.glob`.
 *
 * The DevTools monolith loads plans/briefs with Vite's `import.meta.glob`
 * (`../plans/**\/*.art.yaml`, `../briefs/**\/*.yaml`), which only works inside a
 * Vite build. A canvas extension is a plain node process, so it reads the same
 * files directly off disk — simpler and dependency-light. This module is offered
 * to slices B–E (the workflow tool needs it heavily); the read-only sprite-review
 * viewer only lightly uses it.
 *
 * "Self-contained within Crawler": it imports the repo's `yaml` package (a normal
 * dependency resolved from the repo `node_modules`), which is expected for a
 * project-scoped extension.
 *
 * @module workflow/yaml-reader
 */

import { readdirSync, readFileSync, existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRepoRequire } from '../../shared/node-modules-resolver.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// lib -> workflow -> extensions -> .github -> repo root
export const DEFAULT_REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const requireFromRepo = createRepoRequire(DEFAULT_REPO_ROOT, import.meta.url);
const { parse } = requireFromRepo('yaml');

/** Recursively collect files under `dir` whose basename matches `matcher`. */
function walkFiles(dir, matcher, acc) {
  if (!existsSync(dir)) return acc;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    // Never traverse or serve symlinks: a repo-controlled link under plans/ or
    // briefs/ could otherwise escape the repo root and disclose arbitrary files.
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    // Some environments report neither dir nor file; lstat defensively (never
    // following links, so a symlink the dirent missed is skipped, not resolved).
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (!isDir && !isFile) {
      try {
        const st = lstatSync(full);
        if (st.isSymbolicLink()) continue;
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue;
      }
    }
    if (isDir) {
      walkFiles(full, matcher, acc);
    } else if (isFile && matcher(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

function toPosix(relPath) {
  return relPath.split(path.sep).join('/');
}

/**
 * List art-plan files (`plans/**\/*.art.yaml`).
 * @param {{ repoRoot?: string }} [options]
 * @returns {Array<{ path: string, relPath: string, id: string }>}
 */
export function listArtPlans(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const root = path.join(repoRoot, 'plans');
  const files = walkFiles(root, (name) => name.endsWith('.art.yaml'), []);
  return files
    .map((absPath) => {
      const relPath = toPosix(path.relative(repoRoot, absPath));
      const id = path.basename(absPath).replace(/\.art\.yaml$/i, '');
      return { path: absPath, relPath, id };
    })
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
}

/**
 * List brief files (`briefs/**\/*.yaml`), excluding `*.art.yaml` (those are plans).
 * @param {{ repoRoot?: string }} [options]
 * @returns {Array<{ path: string, relPath: string, id: string }>}
 */
export function listBriefs(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const root = path.join(repoRoot, 'briefs');
  const files = walkFiles(
    root,
    (name) => /\.ya?ml$/i.test(name) && !name.endsWith('.art.yaml'),
    [],
  );
  return files
    .map((absPath) => {
      const relPath = toPosix(path.relative(repoRoot, absPath));
      const id = path.basename(absPath).replace(/\.ya?ml$/i, '');
      return { path: absPath, relPath, id };
    })
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
}

/**
 * Read + parse a single YAML file. Returns `null` (never throws) when the file is
 * missing or unparseable, so a bad brief degrades instead of crashing the canvas.
 * @param {string} filePath
 * @returns {unknown | null}
 */
export function readYaml(filePath) {
  try {
    const text = readFileSync(filePath, 'utf8');
    return parse(text);
  } catch {
    return null;
  }
}

/**
 * Read + parse every art plan.
 * @param {{ repoRoot?: string }} [options]
 * @returns {Array<{ relPath: string, id: string, data: unknown | null }>}
 */
export function loadArtPlans(options = {}) {
  return listArtPlans(options).map((entry) => ({
    relPath: entry.relPath,
    id: entry.id,
    data: readYaml(entry.path),
  }));
}

/**
 * Read + parse every brief.
 * @param {{ repoRoot?: string }} [options]
 * @returns {Array<{ relPath: string, id: string, data: unknown | null }>}
 */
export function loadBriefs(options = {}) {
  return listBriefs(options).map((entry) => ({
    relPath: entry.relPath,
    id: entry.id,
    data: readYaml(entry.path),
  }));
}
