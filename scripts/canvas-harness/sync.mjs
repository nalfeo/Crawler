#!/usr/bin/env node
/**
 * sync.mjs — vendor the canonical canvas-harness files into extension `lib/`
 * folders, and (in `--check` mode) assert the vendored copies have not drifted.
 *
 * The canvas harness is a SINGLE SOURCE OF TRUTH: the files listed in
 * `CANONICAL_FILES` in this directory (`canvas-harness.mjs`, `image-cache.mjs`).
 * Every extension that uses the harness keeps byte copies at
 * `<ext>/lib/<file>` so the extension folder stays self-contained and portable
 * (the `share_extension`/`install_extension` gist flow operates per folder).
 * This script is how the copies stay identical instead of drifting into hand-
 * edited variants.
 *
 * An extension is considered a harness user (and therefore a sync target) when
 * it has the ANCHOR file vendored: `<ext>/lib/canvas-harness.mjs`. Syncing then
 * writes ALL canonical files into that extension's `lib/`.
 *
 * Usage:
 *   node scripts/canvas-harness/sync.mjs            # refresh every existing vendored copy
 *   node scripts/canvas-harness/sync.mjs --to NAME  # create/refresh .github/extensions/NAME/lib copies
 *   node scripts/canvas-harness/sync.mjs --check     # exit 1 if any copy drifted (used by the drift test)
 *
 * @module canvas-harness/sync
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');

/**
 * Canonical harness files, in vendor order. The FIRST entry is the anchor: an
 * extension is a sync target iff it has the anchor vendored in its `lib/`.
 */
export const CANONICAL_FILES = ['canvas-harness.mjs', 'image-cache.mjs'];
const ANCHOR_FILE = CANONICAL_FILES[0];

// Back-compat single-file export (the anchor's canonical path).
export const CANONICAL_PATH = path.join(HERE, ANCHOR_FILE);
const EXTENSIONS_DIR = path.join(REPO_ROOT, '.github', 'extensions');

/** Normalize EOL so a CRLF/LF checkout difference is not reported as drift. */
function normalize(text) {
  return text.replace(/\r\n/g, '\n');
}

function canonicalPath(file) {
  return path.join(HERE, file);
}

function vendoredPath(extName, file) {
  return path.join(EXTENSIONS_DIR, extName, 'lib', file);
}

/** List every extension dir that vendors the anchor harness file. */
export function listVendoredExtensions() {
  if (!existsSync(EXTENSIONS_DIR)) return [];
  return readdirSync(EXTENSIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(vendoredPath(name, ANCHOR_FILE)))
    .sort();
}

/**
 * Compare every vendored copy of every canonical file to canonical.
 * `checked` is the list of extension NAMES inspected (contract relied on by the
 * drift test). A missing or differing vendored file is reported in `drifted`.
 * @returns {{ ok: boolean, checked: string[], drifted: Array<{ ext: string, file: string, reason: string }> }}
 */
export function checkHarness() {
  const canonicals = new Map(
    CANONICAL_FILES.map((file) => [
      file,
      normalize(readFileSync(canonicalPath(file)).toString('utf8')),
    ]),
  );
  const checked = [];
  const drifted = [];
  for (const ext of listVendoredExtensions()) {
    checked.push(ext);
    for (const file of CANONICAL_FILES) {
      const dest = vendoredPath(ext, file);
      if (!existsSync(dest)) {
        drifted.push({ ext, file, reason: `missing vendored copy of ${file}` });
        continue;
      }
      const copy = normalize(readFileSync(dest).toString('utf8'));
      if (copy !== canonicals.get(file)) {
        drifted.push({ ext, file, reason: `content differs from canonical ${file}` });
      }
    }
  }
  return { ok: drifted.length === 0, checked, drifted };
}

/**
 * Write every canonical harness file into the given extensions (defaults to
 * every ext that already vendors the anchor). Creates each `lib/` dir if needed.
 * @param {{ to?: string[] }} [options]
 * @returns {string[]} the extension names written
 */
export function syncHarness(options = {}) {
  const canonicals = CANONICAL_FILES.map((file) => ({
    file,
    bytes: readFileSync(canonicalPath(file)),
  }));
  const targets = options.to && options.to.length > 0 ? options.to : listVendoredExtensions();
  for (const ext of targets) {
    for (const { file, bytes } of canonicals) {
      const dest = vendoredPath(ext, file);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, bytes);
    }
  }
  return targets;
}

function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--check')) {
    const { ok, checked, drifted } = checkHarness();
    if (ok) {
      process.stdout.write(`canvas-harness: ${checked.length} vendored copy(ies) in sync\n`);
      process.exit(0);
    }
    process.stderr.write('canvas-harness: DRIFT DETECTED\n');
    for (const { ext, file, reason } of drifted) {
      process.stderr.write(`  - ${ext}/${file}: ${reason}\n`);
    }
    process.stderr.write('Fix: node scripts/canvas-harness/sync.mjs\n');
    process.exit(1);
  }

  const toIndex = args.indexOf('--to');
  const to = toIndex >= 0 && args[toIndex + 1] ? [args[toIndex + 1]] : undefined;
  const written = syncHarness({ to });
  if (written.length === 0) {
    process.stdout.write(
      'canvas-harness: no vendored copies found (use --to <ext> to create one)\n',
    );
  } else {
    process.stdout.write(`canvas-harness: synced -> ${written.join(', ')}\n`);
  }
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1] === fileURLToPath(import.meta.url)
) {
  main(process.argv);
}
