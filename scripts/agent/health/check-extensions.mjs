#!/usr/bin/env node
/* global console */
/**
 * check-extensions.mjs — Deterministic guard against broken extension imports.
 *
 * Extensions run in a sandboxed Node.js process that has NO access to the
 * project's node_modules via bare-specifier ESM imports. Only two specifier
 * families are safe:
 *   - `node:*`          (Node.js built-ins)
 *   - `@github/copilot-sdk` / `@github/copilot-sdk/extension`
 *                       (intercepted by the extension bootstrap's SDK resolver)
 *
 * Any other bare specifier (e.g. `import { z } from 'zod'`) will cause the
 * extension to fail silently — it simply disappears from the UI with no user-
 * facing error. This script catches those violations at commit time.
 *
 * Exit codes:
 *   0  all extensions clean
 *   1  at least one violation found
 *   2  the guard itself crashed
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// Bare-specifier ESM import:
//   - static: `import … from 'pkg'` and side-effect `import 'pkg'`
//   - dynamic: `import('pkg')`
// We deliberately do NOT flag require() / _require() calls — those go through
// createRequire() which CAN resolve the project's node_modules, and they are
// the canonical workaround pattern (see workflow-model.mjs).
// Only 'node:*' built-ins and '@github/copilot-sdk' are safe for ESM imports.
const STATIC_BARE_IMPORT_RE = /\bimport\s+(?!\s*\()(?:(?:[\s\S]*?)\s+from\s*)?['"]([^'"]+)['"]/g;
const DYNAMIC_BARE_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const ALLOWED_PREFIXES = ['node:', '@github/copilot-sdk'];

/** @param {string} specifier @returns {boolean} */
function isAllowed(specifier) {
  return ALLOWED_PREFIXES.some((prefix) => specifier.startsWith(prefix));
}

/** @param {string} specifier @returns {boolean} */
function isValidSpecifier(specifier) {
  // Bare specifiers must not start with `.`, `/`, or `\` (those are relative/absolute)
  // and must not contain spaces or template-literal interpolation artifacts.
  if (
    !specifier ||
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('\\')
  ) {
    return false;
  }
  if (specifier.includes(' ') || specifier.includes('+') || specifier.includes('${')) {
    return false;
  }
  return true;
}

/**
 * Walk a directory recursively, yielding .mjs file paths.
 * Skips `tests/` subdirectories — test runners can install their own deps.
 * @param {string} dir
 * @returns {string[]}
 */
function collectMjsFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip test directories — test runners provide their own module resolution
      if (entry.name === 'tests' || entry.name === '__tests__') continue;
      results.push(...collectMjsFiles(abs));
    } else if (entry.isFile() && entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs')) {
      results.push(abs);
    }
  }
  return results;
}

/**
 * Replace strings/comments with spaces so regex scanning can match import
 * statements across full source (including multiline forms) without false
 * positives from comments or string literals.
 * @param {string} source
 * @returns {string}
 */
export function stripCommentsAndStrings(source) {
  const out = source.split('');
  const mask = (i, ch) => {
    out[i] = ch === '\n' ? '\n' : ' ';
  };
  let i = 0;
  let mode = 'code';
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (mode === 'code') {
      if (ch === "'" || ch === '"' || ch === '`') {
        mode = ch;
        mask(i, ch);
        i += 1;
        continue;
      }
      if (ch === '/' && next === '/') {
        mask(i, ch);
        mask(i + 1, next);
        i += 2;
        mode = 'line-comment';
        continue;
      }
      if (ch === '/' && next === '*') {
        mask(i, ch);
        mask(i + 1, next);
        i += 2;
        mode = 'block-comment';
        continue;
      }
      i += 1;
      continue;
    }
    if (mode === 'line-comment') {
      mask(i, ch);
      if (ch === '\n') mode = 'code';
      i += 1;
      continue;
    }
    if (mode === 'block-comment') {
      mask(i, ch);
      if (ch === '*' && next === '/') {
        mask(i + 1, next);
        i += 2;
        mode = 'code';
      } else {
        i += 1;
      }
      continue;
    }
    if (mode === "'" || mode === '"') {
      mask(i, ch);
      if (ch === '\\') {
        if (i + 1 < source.length) mask(i + 1, source[i + 1]);
        i += 2;
        continue;
      }
      if (ch === mode) mode = 'code';
      i += 1;
      continue;
    }
    // Template literal: keep entire content masked (including ${...}) so
    // import-like text inside template strings never appears as code.
    if (mode === '`') {
      mask(i, ch);
      if (ch === '\\') {
        if (i + 1 < source.length) mask(i + 1, source[i + 1]);
        i += 2;
        continue;
      }
      if (ch === '`') mode = 'code';
      i += 1;
      continue;
    }
  }
  return out.join('');
}

/**
 * @param {string} source
 * @returns {Array<{ index: number, specifier: string }>}
 */
export function collectBareEsmImports(source) {
  const masked = stripCommentsAndStrings(source);
  /** @type {Array<{ index: number, specifier: string }>} */
  const imports = [];
  for (const re of [STATIC_BARE_IMPORT_RE, DYNAMIC_BARE_IMPORT_RE]) {
    let m;
    const scan = new RegExp(re.source, 'g');
    while ((m = scan.exec(source)) !== null) {
      if (masked[m.index] === ' ') continue;
      const specifier = m[1];
      if (!isValidSpecifier(specifier)) continue;
      imports.push({ index: m.index, specifier });
    }
  }
  imports.sort((a, b) => a.index - b.index);
  return imports;
}

/** @param {string} source @returns {number[]} */
function lineStartIndices(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/** @param {number[]} starts @param {number} index @returns {number} */
function lineNumberForIndex(starts, index) {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (starts[mid] <= index) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return high + 1;
}

/** @param {string} file @returns {Array<{file: string, line: number, specifier: string}>} */
export function findFileViolations(file) {
  const source = readFileSync(file, 'utf8');
  const starts = lineStartIndices(source);
  return collectBareEsmImports(source)
    .filter(({ specifier }) => !isAllowed(specifier))
    .map(({ index, specifier }) => ({
      file,
      line: lineNumberForIndex(starts, index),
      specifier,
    }));
}

/**
 * @param {{ extensionsDir?: string, repoRoot?: string }} [options]
 * @returns {{ filesChecked: number, violations: Array<{file: string, line: number, specifier: string}>, repoRoot: string }}
 */
export function scanExtensions(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const extensionsDir = options.extensionsDir ?? path.join(repoRoot, '.github', 'extensions');
  let extDirExists = false;
  try {
    statSync(extensionsDir);
    extDirExists = true;
  } catch {
    /* not found */
  }

  if (!extDirExists) {
    return { filesChecked: 0, violations: [], repoRoot };
  }

  const files = collectMjsFiles(extensionsDir);
  const violations = files.flatMap((file) => findFileViolations(file));
  return { filesChecked: files.length, violations, repoRoot };
}

export function runCli() {
  try {
    const { filesChecked, violations, repoRoot } = scanExtensions();
    if (filesChecked === 0) {
      console.log('check:extensions — no .github/extensions directory found, nothing to check.');
      process.exit(0);
    }
    const rel = (f) => path.relative(repoRoot, f).replace(/\\/g, '/');
    if (violations.length === 0) {
      console.log(
        `check:extensions — ✅ ${filesChecked} extension file(s) checked, no bare-import violations.`,
      );
      process.exit(0);
    }
    console.error(`check:extensions — ❌ ${violations.length} bare-import violation(s) found:\n`);
    for (const v of violations) {
      console.error(`  ${rel(v.file)}:${v.line}  →  '${v.specifier}'`);
    }
    console.error(`
Extensions run in a sandboxed process with no access to node_modules.
Only 'node:*' built-ins and '@github/copilot-sdk' are resolvable.

Fix: use createRepoRequire() from .github/extensions/shared/node-modules-resolver.mjs
to load third-party packages. It handles git worktrees automatically by following
the .git file's gitdir pointer to the main checkout's node_modules.
`);
    process.exit(1);
  } catch (err) {
    console.error('check:extensions — crashed:', err);
    process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runCli();
}
