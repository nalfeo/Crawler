#!/usr/bin/env node
/**
 * Run one of the headless/perf CLIs from an eagerly bundled entrypoint.
 *
 * Bundles are deliberately rebuilt on every invocation: a stale bundle could
 * silently run old game code. The output lives under gitignored files/.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT_DIR = path.join(REPO_ROOT, 'files');

export const BUNDLED_ENTRIES = Object.freeze({
  headless: {
    label: 'ai:headless',
    entry: path.join(REPO_ROOT, 'src', 'game', 'ai', 'headless-runner-cli.ts'),
    outputPrefix: 'headless-runner-cli.bundle-',
  },
  'winrate-sweep': {
    label: 'ai:winrate-sweep',
    entry: path.join(REPO_ROOT, 'scripts', 'agent', 'perf', 'winrate-sweep.ts'),
    outputPrefix: 'winrate-sweep.bundle-',
  },
  'sweep-eval': {
    label: 'ai:sweep-eval',
    entry: path.join(REPO_ROOT, 'scripts', 'agent', 'perf', 'sweep-eval.ts'),
    outputPrefix: 'sweep-eval.bundle-',
  },
  'sim-fingerprint': {
    label: 'perf:fingerprint',
    entry: path.join(REPO_ROOT, 'scripts', 'agent', 'perf', 'sim-fingerprint.ts'),
    outputPrefix: 'sim-fingerprint.bundle-',
  },
  'weapon-sweep': {
    label: 'ai:weapon-sweep',
    entry: path.join(REPO_ROOT, 'scripts', 'agent', 'perf', 'weapon-sweep.ts'),
    outputPrefix: 'weapon-sweep.bundle-',
  },
  'hill-climb': {
    label: 'ai:hill-climb',
    entry: path.join(REPO_ROOT, 'scripts', 'agent', 'perf', 'hill-climb.ts'),
    outputPrefix: 'hill-climb.bundle-',
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
 * Publish bundle contents under a content-addressed filename, atomically.
 *
 * Concurrent launchers (e.g. parallel sweep workers) can race to build the
 * same entry. Writing to a per-process temp file and renaming it into place
 * means a reader either sees the old, complete file or the new, complete
 * file — never a partially written one. If the content-addressed file
 * already exists, its contents are already known-good, so the write is
 * skipped entirely.
 */
function publishAtomically(target, contents) {
  const temporary = path.join(OUT_DIR, `.tmp-${randomUUID()}.mjs`);
  writeFileSync(temporary, contents);
  try {
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    if (!existsSync(target)) throw error;
  }
}

/**
 * Bundle the selected CLI with esbuild's JS API. First-party TypeScript is
 * inlined while dependencies remain native node-resolved packages.
 *
 * Builds in memory (`write: false`) and publishes to a sha256-addressed
 * output path so concurrent launchers can never observe a partially written
 * bundle from another in-flight build.
 */
export async function buildBundle(key) {
  const entry = entryForKey(key);
  mkdirSync(OUT_DIR, { recursive: true });
  const esbuild = await import('esbuild');
  const result = await esbuild.build({
    entryPoints: [entry.entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: `node${process.versions.node.split('.')[0]}`,
    packages: 'external',
    logLevel: 'warning',
    write: false,
  });
  const output = result.outputFiles?.[0];
  if (!output) throw new Error(`esbuild produced no output for ${entry.label}.`);

  const digest = createHash('sha256').update(output.contents).digest('hex').slice(0, 16);
  const target = path.join(OUT_DIR, `${entry.outputPrefix}${digest}.mjs`);
  if (!existsSync(target)) publishAtomically(target, output.contents);
  return { ...entry, output: target };
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

  let built;
  try {
    built = await buildBundle(invocation.key);
  } catch (error) {
    console.error(
      `${entry.label} — ${error instanceof Error ? error.message : String(error)}\n` +
        'Falling back to the tsx loader: slower, but functionally identical.',
    );
  }
  const run = built
    ? spawnSync(process.execPath, [built.output, ...invocation.args], {
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
