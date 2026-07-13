/**
 * Canonical catalog I/O utilities.
 *
 * **All** writers of `sprite-catalog.json` must use the helpers in this
 * module so every write path produces identical, Prettier-formatted output.
 *
 * Formatting policy
 * -----------------
 * 1. Serialise to `JSON.stringify(data, null, 2)` followed by a trailing
 *    newline.
 * 2. Run the repo's Prettier pass over the file (`parser: "json"`), which
 *    compacts short primitive arrays to a single line (e.g. `["sheet",
 *    "enemy", "generated"]`) and is the style enforced by `format:check`.
 *
 * Writers that bypass these helpers (e.g. raw `JSON.stringify` without
 * a Prettier pass) will produce a different on-disk format and cause
 * noisy diffs.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/** Lazily-resolved absolute path to Prettier's CJS entry point. */
let _prettierBin: string | undefined;
function getPrettierBin(): string {
  if (!_prettierBin) {
    const require = createRequire(import.meta.url);
    _prettierBin = require.resolve('prettier/bin/prettier.cjs');
  }
  return _prettierBin;
}

/**
 * Run the repo's Prettier over `files` (must already exist on disk).
 * Accepts multiple paths so callers that write several related files
 * (e.g. manifest + catalog) can format them in a single subprocess call.
 * Passes `--parser json` so Prettier handles files regardless of extension.
 */
export function formatJsonFiles(files: readonly string[]): void {
  if (files.length === 0) return;
  execFileSync(process.execPath, [getPrettierBin(), '--parser', 'json', '--write', ...files], {
    stdio: 'inherit',
  });
}

/**
 * Write `data` as Prettier-formatted JSON to `filePath`.
 *
 * - Creates parent directories if needed.
 * - Uses an atomic write (temp file → rename) to avoid partial reads.
 * - Runs Prettier on the final path so the on-disk format matches what
 *   `format:check` enforces.
 */
export function writeCatalogJson(filePath: string, data: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  renameSync(tmpPath, filePath);
  formatJsonFiles([filePath]);
}

/**
 * Compute the Prettier-formatted JSON string for `data` without writing to
 * the target path. Useful for `--check` / diff modes that need to compare
 * what *would* be written against what is currently on disk.
 *
 * Internally writes to a temp file beside `referencePath`, formats it,
 * reads the result, and cleans up.
 */
export function formatCatalogJsonToString(referencePath: string, data: unknown): string {
  const tmpPath = `${referencePath}.format-tmp`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
    formatJsonFiles([tmpPath]);
    return readFileSync(tmpPath, 'utf-8');
  } finally {
    if (existsSync(tmpPath)) {
      unlinkSync(tmpPath);
    }
  }
}
