import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { buildCliBundle, createCliEntryResolver } from '../lib/cli-bundle.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const temporaryRoots = [];

function temporaryRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'theme-cli-bundle-'));
  temporaryRoots.push(root);
  return root;
}

after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

test('resolver builds once and reuses the bundle while sources are unchanged', async () => {
  let builds = 0;
  const root = temporaryRepo();
  const entry = path.join(root, 'cli.mjs');
  writeFileSync(entry, 'export default 1;');
  const stable = { file: path.join(REPO_ROOT, 'package.json') };
  const resolve = createCliEntryResolver({
    repoRoot: REPO_ROOT,
    build: async () => {
      builds += 1;
      const { statSync } = await import('node:fs');
      const stats = statSync(stable.file);
      return {
        argv: [entry],
        entry,
        inputs: [{ file: stable.file, mtimeMs: stats.mtimeMs, size: stats.size }],
      };
    },
  });
  assert.deepEqual(await resolve(), [entry]);
  assert.deepEqual(await resolve(), [entry]);
  assert.equal(builds, 1);
});

test('concurrent callers share a single build', async () => {
  let builds = 0;
  const resolve = createCliEntryResolver({
    repoRoot: REPO_ROOT,
    build: async () => {
      builds += 1;
      await new Promise((done) => setTimeout(done, 20));
      return { argv: ['/cache/cli.mjs'], entry: '/cache/cli.mjs', inputs: [] };
    },
  });
  const results = await Promise.all([resolve(), resolve(), resolve()]);
  assert.equal(builds, 1);
  for (const argv of results) assert.deepEqual(argv, ['/cache/cli.mjs']);
});

test('a changed source file triggers a rebuild', async () => {
  const root = temporaryRepo();
  const watched = path.join(root, 'watched.ts');
  writeFileSync(watched, 'export const a = 1;\n');
  let builds = 0;
  const resolve = createCliEntryResolver({
    repoRoot: root,
    build: async () => {
      builds += 1;
      const { statSync } = await import('node:fs');
      const stats = statSync(watched);
      return {
        argv: [`/cache/cli-${builds}.mjs`],
        entry: `/cache/cli-${builds}.mjs`,
        inputs: [{ file: watched, mtimeMs: stats.mtimeMs, size: stats.size }],
      };
    },
  });
  assert.deepEqual(await resolve(), ['/cache/cli-1.mjs']);
  writeFileSync(watched, 'export const a = 2;\nexport const b = 3;\n');
  const future = new Date(Date.now() + 5_000);
  utimesSync(watched, future, future);
  assert.deepEqual(await resolve(), ['/cache/cli-2.mjs']);
  assert.equal(builds, 2);
});

test('a failed build falls back to the tsx invocation instead of breaking the canvas', async () => {
  const warnings = [];
  const resolve = createCliEntryResolver({
    repoRoot: '/repo',
    log: (message, level) => warnings.push({ message, level }),
    build: async () => {
      throw new Error('esbuild is not installed');
    },
  });
  const argv = await resolve();
  assert.deepEqual(argv.slice(0, 2), ['--import', 'tsx']);
  assert.match(argv[2], /theme-equipment-review-cli\.ts$/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /esbuild is not installed/);
});

test('a build failure is retried rather than cached', async () => {
  let attempts = 0;
  const resolve = createCliEntryResolver({
    repoRoot: '/repo',
    build: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient');
      return { argv: ['/cache/cli.mjs'], entry: '/cache/cli.mjs', inputs: [] };
    },
  });
  assert.deepEqual((await resolve()).slice(0, 2), ['--import', 'tsx']);
  assert.deepEqual(await resolve(), ['/cache/cli.mjs']);
  assert.equal(attempts, 2);
});

test('the bundle is named after its own bytes and published atomically', async () => {
  const root = temporaryRepo();
  const contents = Buffer.from('export const value = 1;\n');
  const esbuildModule = {
    build: async () => ({
      outputFiles: [{ contents }],
      metafile: { inputs: { 'scripts/sprites/theme-equipment-review-cli.ts': {} } },
    }),
  };
  const first = await buildCliBundle({ repoRoot: root, esbuildModule });
  const second = await buildCliBundle({ repoRoot: root, esbuildModule });
  assert.equal(first.entry, second.entry, 'identical bytes must converge on one filename');
  assert.match(path.basename(first.entry), /^cli-[0-9a-f]{16}\.mjs$/);
  assert.equal(readFileSync(first.entry, 'utf8'), contents.toString('utf8'));
  const cacheDir = path.dirname(first.entry);
  const leftovers = (await import('node:fs'))
    .readdirSync(cacheDir)
    .filter((name) => name.startsWith('.tmp-'));
  assert.deepEqual(leftovers, [], 'no temporary files may be left behind');
});

test('different bytes produce different bundle names', async () => {
  const root = temporaryRepo();
  const make = (body) => ({
    build: async () => ({
      outputFiles: [{ contents: Buffer.from(body) }],
      metafile: { inputs: {} },
    }),
  });
  const first = await buildCliBundle({ repoRoot: root, esbuildModule: make('a') });
  const second = await buildCliBundle({ repoRoot: root, esbuildModule: make('b') });
  assert.notEqual(first.entry, second.entry);
  assert.ok(existsSync(first.entry) && existsSync(second.entry));
});

test('buildCliBundle writes cache output under resolved main-checkout node_modules for worktrees', async () => {
  const root = temporaryRepo();
  const mainRoot = path.join(root, 'main');
  const worktreeRoot = path.join(root, 'worktree');
  mkdirSync(path.join(mainRoot, 'node_modules'), { recursive: true });
  mkdirSync(path.join(mainRoot, '.git', 'worktrees', 'wt'), { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  writeFileSync(path.join(worktreeRoot, '.git'), 'gitdir: ../main/.git/worktrees/wt\n');

  const esbuildModule = {
    build: async () => ({
      outputFiles: [{ contents: Buffer.from('export const worktree = true;\n') }],
      metafile: { inputs: {} },
    }),
  };
  const built = await buildCliBundle({ repoRoot: worktreeRoot, esbuildModule });
  assert.equal(
    path.dirname(built.entry),
    path.join(mainRoot, 'node_modules', '.cache', 'theme-equipment-review'),
  );
});

test('node_modules inputs are not watched for staleness', async () => {
  const root = temporaryRepo();
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  const esbuildModule = {
    build: async () => ({
      outputFiles: [{ contents: Buffer.from('x') }],
      metafile: {
        inputs: {
          'scripts/cli.ts': {},
          'node_modules/zod/index.js': {},
        },
      },
    }),
  };
  const built = await buildCliBundle({ repoRoot: root, esbuildModule });
  assert.equal(built.inputs.length, 1);
  assert.match(built.inputs[0].file, /cli\.ts$/);
});

test('the real bundle runs a list command and returns JSON', { timeout: 120_000 }, async () => {
  const built = await buildCliBundle({ repoRoot: REPO_ROOT });
  assert.ok(existsSync(built.entry));
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const encoded = Buffer.from(JSON.stringify({ action: 'list' }), 'utf8').toString('base64url');
  const { stdout } = await promisify(execFile)('node', [built.entry, encoded], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 24 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout);
  assert.ok(Array.isArray(parsed.sets), 'bundled CLI must still emit a set list');
});

test('a deleted bundle is rebuilt rather than served as a dead path', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'teq-evict-'));
  const cacheDir = path.join(repoRoot, 'cache');
  mkdirSync(cacheDir, { recursive: true });
  let builds = 0;
  const build = async () => {
    builds += 1;
    const entry = path.join(cacheDir, 'cli-fixed.mjs');
    writeFileSync(entry, 'export default 1;');
    return { argv: [entry], entry, inputs: [] };
  };
  const resolve = createCliEntryResolver({ repoRoot, build });
  const [entry] = await resolve();
  await resolve();
  assert.equal(builds, 1, 'an intact bundle must be reused');
  rmSync(entry); // e.g. `npm ci`, which never touches a source file
  await resolve();
  assert.equal(builds, 2, 'a missing bundle must trigger a rebuild');
  rmSync(repoRoot, { recursive: true, force: true });
});
