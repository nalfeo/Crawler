#!/usr/bin/env node
/**
 * Run one of the headless/perf CLIs from an eagerly bundled entrypoint.
 *
 * Bundles are deliberately rebuilt on every invocation: a stale bundle could
 * silently run old game code. The output lives under gitignored files/.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT_DIR = path.join(REPO_ROOT, 'files');

export const BUNDLED_ENTRIES = Object.freeze({
  headless: {
    label: 'ai:headless',
    entry: path.join(REPO_ROOT, 'src', 'game', 'ai', 'headless-runner-cli.ts'),
    output: path.join(OUT_DIR, 'headless-runner-cli.bundle.mjs'),
  },
  'winrate-sweep': {
    label: 'ai:winrate-sweep',
    entry: path.join(REPO_ROOT, 'scripts', 'agent', 'perf', 'winrate-sweep.ts'),
    output: path.join(OUT_DIR, 'winrate-sweep.bundle.mjs'),
  },
  'sweep-eval': {
    label: 'ai:sweep-eval',
    entry: path.join(REPO_ROOT, 'scripts', 'agent', 'perf', 'sweep-eval.ts'),
    output: path.join(OUT_DIR, 'sweep-eval.bundle.mjs'),
  },
  'sim-fingerprint': {
    label: 'perf:fingerprint',
    entry: path.join(REPO_ROOT, 'scripts', 'agent', 'perf', 'sim-fingerprint.ts'),
    output: path.join(OUT_DIR, 'sim-fingerprint.bundle.mjs'),
  },
  'weapon-sweep': {
    label: 'ai:weapon-sweep',
    entry: path.join(REPO_ROOT, 'scripts', 'agent', 'perf', 'weapon-sweep.ts'),
    output: path.join(OUT_DIR, 'weapon-sweep.bundle.mjs'),
  },
  'hill-climb': {
    label: 'ai:hill-climb',
    entry: path.join(REPO_ROOT, 'scripts', 'agent', 'perf', 'hill-climb.ts'),
    output: path.join(OUT_DIR, 'hill-climb.bundle.mjs'),
  },
});

function entryForKey(key) {
  const entry = BUNDLED_ENTRIES[key];
  if (!entry) {
    throw new Error(
      `Unknown prebundle entry "${key}". Expected one of: ${Object.keys(BUNDLED_ENTRIES).join(', ')}`,
    );
  }
  return entry;
}

/**
 * Bundle the selected CLI with esbuild's JS API. First-party TypeScript is
 * inlined while dependencies remain native node-resolved packages.
 */
export async function buildBundle(key) {
  const entry = entryForKey(key);
  mkdirSync(OUT_DIR, { recursive: true });
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: [entry.entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: `node${process.versions.node.split('.')[0]}`,
    outfile: entry.output,
    packages: 'external',
    logLevel: 'warning',
  });
  return entry;
}

function parseInvocation(argv) {
  if (argv[0]?.startsWith('--entry=')) {
    const key = argv[0].slice('--entry='.length);
    if (!key) {
      throw new Error('--entry requires a value');
    }
    return { key, args: argv.slice(1) };
  }
  if (argv[0] === '--entry') {
    if (!argv[1]) {
      throw new Error('--entry requires a value');
    }
    return { key: argv[1], args: argv.slice(2) };
  }
  return { key: 'headless', args: argv };
}

function runViaTsx(entry, args) {
  return spawnSync(process.execPath, ['--import', 'tsx', entry.entry, ...args], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
}

/**
 * Build and run a CLI, preserving its argv, exit status, and signal behavior.
 * If bundling fails, the original tsx path remains available as a safe fallback.
 */
export async function launch(argv, defaultKey = 'headless') {
  const invocation =
    argv[0] === '--entry' || argv[0]?.startsWith('--entry=')
      ? parseInvocation(argv)
      : { key: defaultKey, args: argv };
  const entry = entryForKey(invocation.key);

  let built = true;
  try {
    await buildBundle(invocation.key);
  } catch (error) {
    built = false;
    console.error(
      `${entry.label} — ${error instanceof Error ? error.message : String(error)}\n` +
        'Falling back to the tsx loader: slower, but functionally identical.',
    );
  }
  const run = built
    ? spawnSync(process.execPath, [entry.output, ...invocation.args], {
        cwd: process.cwd(),
        env: { ...process.env, CRAWLER_PREBUNDLED_ENTRY: invocation.key },
        stdio: 'inherit',
      })
    : runViaTsx(entry, invocation.args);

  if (run.error) {
    console.error(`${entry.label} — could not start the runner: ${run.error.message}`);
    process.exitCode = 1;
    return;
  }
  if (run.signal) {
    process.kill(process.pid, run.signal);
    return;
  }
  process.exitCode = run.status ?? 1;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  await launch(process.argv.slice(2));
}
