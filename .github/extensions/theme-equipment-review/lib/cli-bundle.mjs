import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRepoRequire } from '../../shared/node-modules-resolver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// lib -> theme-equipment-review -> extensions -> .github -> repo root
const _repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const _require = createRepoRequire(_repoRoot, import.meta.url);

export const CLI_RELATIVE_PATH = path.join('scripts', 'sprites', 'theme-equipment-review-cli.ts');

/**
 * Running the CLI through `node --import tsx` costs ~3.0s per command,
 * and essentially all of it is module loading: tsx installs resolver
 * hooks that tax every single specifier, including the ones inside
 * `node_modules`. `@azure/storage-blob` alone measured 1.86s under tsx.
 *
 * Because the canvas issues several commands just to open, that cost was
 * the whole of the reported "why does it take so long to open". Pre-
 * bundling the CLI once and running the result with plain `node` drops a
 * `list` from ~3.0s to ~1.0s while keeping every other property of the
 * bridge intact — notably one fresh process per command, so environment
 * changes are still picked up per command and one slow command still
 * cannot affect another.
 *
 * Dependencies stay external. Inlining them is faster still (~0.73s) but
 * pulls the whole Azure SDK through esbuild and relies on a runtime
 * `createRequire` shim for CJS dynamic requires, which fails outright for
 * transitive packages such as `https-proxy-agent`.
 */
export function createCliEntryResolver({ repoRoot, log = () => {}, build = buildCliBundle }) {
  let current = null;
  let inFlight = null;

  return async function resolveCliArgv() {
    // The entry must still be on disk: `npm ci` and cache cleaning delete the
    // published bundle without touching a single source file, and a resolver
    // that only watched sources would hand out that dead path forever.
    if (current && existsSync(current.entry) && !inputsChanged(current.inputs)) {
      return current.argv;
    }
    // Coalesce concurrent callers so a burst of commands triggers one build.
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        current = await build({ repoRoot });
        return current.argv;
      } catch (error) {
        // A broken bundle step must never take the canvas down with it:
        // degrade to the original tsx invocation, which is slower but
        // known-good.
        log(`falling back to tsx (bundle failed: ${error?.message ?? error})`, 'warn');
        current = null;
        return ['--import', 'tsx', path.join(repoRoot, CLI_RELATIVE_PATH)];
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };
}

export async function buildCliBundle({ repoRoot, esbuildModule }) {
  // Use createRepoRequire so this works in git worktrees where node_modules
  // lives in the main checkout, not in the worktree directory.
  const esbuild = esbuildModule ?? _require('esbuild');
  const cacheDir = path.join(repoRoot, 'node_modules', '.cache', 'theme-equipment-review');
  mkdirSync(cacheDir, { recursive: true });
  const result = await esbuild.build({
    entryPoints: [path.join(repoRoot, CLI_RELATIVE_PATH)],
    absWorkingDir: repoRoot,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    sourcemap: false,
    metafile: true,
    write: false,
    logLevel: 'silent',
  });
  const output = result.outputFiles?.[0];
  if (!output) throw new Error('esbuild produced no output for the theme-equipment CLI.');
  // Name the artifact after its own bytes. Two extension processes that
  // build the same sources converge on the same filename, so publishing
  // is idempotent and a concurrent builder can never be observed
  // half-written under a name another process is already executing.
  const digest = createHash('sha256').update(output.contents).digest('hex').slice(0, 16);
  const entry = path.join(cacheDir, `cli-${digest}.mjs`);
  if (!existsSync(entry)) publishAtomically(entry, output.contents, cacheDir);
  return { argv: [entry], entry, inputs: snapshotInputs(repoRoot, result.metafile) };
}

/**
 * Write to a private temporary name and rename into place, so a reader
 * either sees the complete bundle or no file at all.
 */
function publishAtomically(entry, contents, cacheDir) {
  const temporary = path.join(cacheDir, `.tmp-${randomUUID()}.mjs`);
  writeFileSync(temporary, contents);
  try {
    renameSync(temporary, entry);
  } catch (error) {
    rmSync(temporary, { force: true });
    // Windows refuses rename-over-existing. Losing that race is fine:
    // the winner's bytes hash to this same name, so they are identical.
    if (!existsSync(entry)) throw error;
  }
}

/**
 * Track the repo sources the bundle was built from so a developer editing
 * the CLI while a canvas stays open still gets their change. Running the
 * TypeScript directly used to give that for free.
 */
function snapshotInputs(repoRoot, metafile) {
  return Object.keys(metafile?.inputs ?? {})
    .filter((input) => !input.split(path.sep).join('/').includes('node_modules/'))
    .map((input) => statInput(path.resolve(repoRoot, input)));
}

function statInput(file) {
  try {
    const stats = statSync(file);
    return { file, mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return { file, mtimeMs: -1, size: -1 };
  }
}

function inputsChanged(inputs) {
  return inputs.some((previous) => {
    const next = statInput(previous.file);
    return next.mtimeMs !== previous.mtimeMs || next.size !== previous.size;
  });
}
