#!/usr/bin/env node
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
const EXTENSIONS_DIR = path.join(REPO_ROOT, '.github', 'extensions');

// Bare-specifier ESM import: `import … from 'pkg'` or `import('pkg')`.
// We deliberately do NOT flag require() / _require() calls — those go through
// createRequire() which CAN resolve the project's node_modules, and they are
// the canonical workaround pattern (see workflow-model.mjs).
// Only 'node:*' built-ins and '@github/copilot-sdk' are safe for ESM imports.
const ESM_BARE_IMPORT_RE = /\bimport(?:\s+(?:[^'"(;]*?\s+)?from|\s*\()\s*['"]([^'"]+)['"]/g;

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

try {
  // Check that the extensions directory exists
  let extDirExists = false;
  try {
    statSync(EXTENSIONS_DIR);
    extDirExists = true;
  } catch {
    /* not found */
  }

  if (!extDirExists) {
    console.log('check:extensions — no .github/extensions directory found, nothing to check.');
    process.exit(0);
  }

  const files = collectMjsFiles(EXTENSIONS_DIR);

  /** @type {Array<{file: string, line: number, specifier: string}>} */
  const violations = [];

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const lines = source.split('\n');
    lines.forEach((lineText, idx) => {
      // Skip single-line comments
      const trimmed = lineText.trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;

      let m;
      const re = new RegExp(ESM_BARE_IMPORT_RE.source, 'g');
      while ((m = re.exec(lineText)) !== null) {
        const specifier = m[1];
        if (!isValidSpecifier(specifier)) continue;
        if (!isAllowed(specifier)) {
          violations.push({ file, line: idx + 1, specifier });
        }
      }
    });
  }

  const rel = (f) => path.relative(REPO_ROOT, f).replace(/\\/g, '/');

  if (violations.length === 0) {
    console.log(
      `check:extensions — ✅ ${files.length} extension file(s) checked, no bare-import violations.`,
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
