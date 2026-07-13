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
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Lazily-resolved absolute path to Prettier's CJS entry point. */
let _prettierBin: string | undefined;
function getPrettierBin(): string {
  if (!_prettierBin) {
    const require = createRequire(import.meta.url);
    _prettierBin = require.resolve('prettier/bin/prettier.cjs');
  }
  return _prettierBin;
}

/** Generate a unique temp file path to avoid collisions under concurrent writers. */
function uniqueTmpPath(base: string): string {
  return `${base}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
}

/**
 * Run the repo's Prettier over `files` asynchronously (must already exist on
 * disk). Accepts multiple paths so callers can format related files in a
 * single subprocess call. Passes `--parser json` so Prettier handles files
 * regardless of extension.
 *
 * Prefer this in long-running processes (Vite plugin, sidecar server) to
 * avoid blocking the Node.js event loop.
 */
export async function formatJsonFiles(files: readonly string[]): Promise<void> {
  if (files.length === 0) return;
  await execFileAsync(process.execPath, [
    getPrettierBin(),
    '--parser',
    'json',
    '--write',
    ...files,
  ]);
}

/**
 * Synchronous variant of `formatJsonFiles`. Use only in contexts where async
 * is not practical (e.g. `approve.ts` which uses an injected-fs abstraction
 * for tests). Prefer `formatJsonFiles` in new code and in long-running process
 * handlers.
 */
export function formatJsonFilesSync(files: readonly string[]): void {
  if (files.length === 0) return;
  execFileSync(process.execPath, [getPrettierBin(), '--parser', 'json', '--write', ...files], {
    stdio: 'inherit',
  });
}

/**
 * Write `data` as Prettier-formatted JSON to `filePath`.
 *
 * - Creates parent directories if needed.
 * - Uses a unique temp path (PID + random suffix) to avoid collisions under
 *   concurrent writers.
 * - Runs Prettier against the temp file, then does a single atomic rename into
 *   place — no second write after the rename.
 */
export async function writeCatalogJson(filePath: string, data: unknown): Promise<void> {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = uniqueTmpPath(filePath);
  try {
    writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
    await formatJsonFiles([tmpPath]);
    renameSync(tmpPath, filePath);
  } catch (err) {
    if (existsSync(tmpPath)) unlinkSync(tmpPath);
    throw err;
  }
}

/**
 * Compute the Prettier-formatted JSON string for `data` without writing to
 * the target path. Useful for `--check` / diff modes that need to compare
 * what *would* be written against what is currently on disk.
 *
 * Internally writes to a unique temp file beside `referencePath`, formats it,
 * reads the result, and cleans up.
 */
export async function formatCatalogJsonToString(
  referencePath: string,
  data: unknown,
): Promise<string> {
  const tmpPath = uniqueTmpPath(referencePath);
  mkdirSync(path.dirname(tmpPath), { recursive: true });
  try {
    writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
    await formatJsonFiles([tmpPath]);
    return readFileSync(tmpPath, 'utf-8');
  } finally {
    if (existsSync(tmpPath)) {
      unlinkSync(tmpPath);
    }
  }
}
