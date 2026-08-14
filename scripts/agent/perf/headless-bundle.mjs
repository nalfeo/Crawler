#!/usr/bin/env node
/**
 * `npm run ai:headless` — run the headless AI CLI from a pre-bundled entrypoint.
 *
 * ## Why this exists
 *
 * Running the CLI through `tsx` costs ~4.0s of fixed startup *before frame one*,
 * because tsx transpiles every reachable `.ts` file on demand, in-process, at
 * each process start. On a ~16s Floor-1 run that is ~25% of wall time, and it is
 * paid again by every process that runs a simulation.
 *
 * Bundling the CLI once with esbuild (already a direct dependency, and the same
 * transform tsx uses under the hood) collapses that to ~1.3s:
 *
 * | invocation  | startup | full seed-1 run |
 * | ----------- | ------- | --------------- |
 * | `tsx`       | ~4.0s   | 11.6-19.2s      |
 * | pre-bundled | ~1.3s   | 8.3-12.0s       |
 *
 * Interleaved paired rounds measured 1.0x-1.64x (median ~1.34x). This is
 * gameplay-neutral **by construction**: it is the same source reached through a
 * different loader, not a change to any simulation code. Outcome and
 * `totalFrames` were byte-identical across seeds 1-3 (VICTORY,
 * 14780/14654/14854).
 *
 * ## Why this file is .mjs and not .ts
 *
 * A `.ts` launcher would itself have to be started by tsx, re-introducing a
 * large share of the very startup cost it exists to remove. Plain ESM runs on
 * node directly, so the only transpile left in the pipeline is the one esbuild
 * does once, ahead of time. (`find-baseline.mjs` in this directory is the same
 * pattern.)
 *
 * ## Why it always rebuilds
 *
 * A stale bundle would silently run *old game code* — a correctness hazard far
 * worse than the time it saves. Bundling costs ~85ms, about 3% of the ~2.7s it
 * saves, so the bundle is rebuilt unconditionally rather than cached behind
 * mtime/hash logic that could get invalidation wrong. There is no staleness
 * window to reason about.
 *
 * The bundle lands in `files/` (gitignored, per repo convention) so it is never
 * committed and never shipped.
 *
 * ## Scope
 *
 * This changes only how the **headless CLI** is launched. The released game is
 * already bundled by `vite build` and never pays this cost.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ENTRY = path.join(REPO_ROOT, 'src', 'game', 'ai', 'headless-runner-cli.ts');
const OUT_DIR = path.join(REPO_ROOT, 'files');

/**
 * Bundle the CLI ahead of time.
 *
 * Uses esbuild's JS API rather than its `bin/esbuild` shim: the shim is a
 * platform-specific launcher (a shell script on POSIX, resolved via a per-arch
 * optional dependency on Windows), so spawning it by path is fragile across
 * platforms and install layouts. The API is the supported entrypoint and skips
 * a process spawn.
 *
 * `--packages=external` deliberately leaves `node_modules` imports alone: they
 * are already plain JS that node resolves natively, so bundling them would add
 * build time without removing any transpile work. Only first-party TypeScript —
 * the part tsx would otherwise transform on every start — gets inlined.
 */
async function buildBundle() {
  mkdirSync(OUT_DIR, { recursive: true });

  const esbuild = await import('esbuild');
  const result = await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: `node${process.versions.node.split('.')[0]}`,
    packages: 'external',
    logLevel: 'warning',
    write: false,
  });
  const output = result.outputFiles?.[0];
  if (!output) throw new Error('esbuild produced no output for the headless runner CLI.');

  const digest = createHash('sha256').update(output.contents).digest('hex').slice(0, 16);
  const entry = path.join(OUT_DIR, `headless-runner-cli.bundle-${digest}.mjs`);
  if (!existsSync(entry)) publishAtomically(entry, output.contents);
  return entry;
}

function publishAtomically(entry, contents) {
  const temporary = path.join(OUT_DIR, `.tmp-${randomUUID()}.mjs`);
  writeFileSync(temporary, contents);
  try {
    renameSync(temporary, entry);
  } catch (error) {
    rmSync(temporary, { force: true });
    if (!existsSync(entry)) throw error;
  }
}

/** Run the CLI through tsx — the historical path, kept as a fallback. */
function runViaTsx(args) {
  return spawnSync(process.execPath, ['--import', 'tsx', ENTRY, ...args], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
}

async function main() {
  const args = process.argv.slice(2);

  let entry;
  try {
    entry = await buildBundle();
  } catch (error) {
    console.error(
      `ai:headless — ${error instanceof Error ? error.message : String(error)}\n` +
        'Falling back to the tsx loader: slower, but functionally identical.',
    );
  }

  const run = entry
    ? spawnSync(process.execPath, [entry, ...args], { cwd: process.cwd(), stdio: 'inherit' })
    : runViaTsx(args);

  if (run.error) {
    console.error(`ai:headless — could not start the headless runner: ${run.error.message}`);
    process.exit(1);
  }
  if (run.signal) {
    // Reproduce death-by-signal rather than reporting a clean exit code, so a
    // killed or OOM'd run is not mistaken for a finished one.
    process.kill(process.pid, run.signal);
    return;
  }
  // The headless CLI uses its exit code to report whether the AI *won the run*,
  // so it must be propagated verbatim rather than normalized.
  process.exit(run.status ?? 1);
}

await main();
