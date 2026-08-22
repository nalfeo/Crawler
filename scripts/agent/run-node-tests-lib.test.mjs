import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ARG_BUDGET_CHARS,
  TEST_GROUPS,
  chunkFiles,
  discoverTests,
  rootsForGroup,
  runGroup,
} from './run-node-tests-lib.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Build a throwaway fixture tree so no test ever invokes the real groups. */
function withFixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'run-node-tests-'));
  for (const relative of files) {
    const absolute = path.join(root, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, '// fixture\n', 'utf8');
  }
  return root;
}

test('discoverTests walks recursively and returns sorted repo-relative POSIX paths', () => {
  const root = withFixture([
    path.join('a', 'zebra.test.mjs'),
    path.join('a', 'nested', 'alpha.test.mjs'),
    path.join('a', 'not-a-test.mjs'),
    path.join('a', 'readme.md'),
  ]);
  try {
    assert.deepEqual(discoverTests(root, ['a']), ['a/nested/alpha.test.mjs', 'a/zebra.test.mjs']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discoverTests skips node_modules so vendored suites never run', () => {
  const root = withFixture([
    path.join('a', 'own.test.mjs'),
    path.join('a', 'node_modules', 'dep', 'vendored.test.mjs'),
  ]);
  try {
    assert.deepEqual(discoverTests(root, ['a']), ['a/own.test.mjs']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discoverTests fails closed on an empty or missing root', () => {
  const root = withFixture([path.join('a', 'own.test.mjs'), path.join('b', 'notes.md')]);
  try {
    // An existing root with no suites: a silently-empty gate is the exact
    // failure mode discovery must never introduce.
    assert.throws(() => discoverTests(root, ['a', 'b']), /matched no \.test\.mjs files/);
    assert.throws(() => discoverTests(root, ['a', 'typo']), /could not be read/);
    assert.throws(() => discoverTests(root, []), /No roots configured/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rootsForGroup rejects unknown groups and exposes the configured ones', () => {
  assert.deepEqual([...rootsForGroup('guards')], [...TEST_GROUPS.guards]);
  assert.throws(() => rootsForGroup('gaurds'), /Unknown test group "gaurds"/);
});

test('every configured group root exists and contains suites in this repository', () => {
  for (const [group, roots] of Object.entries(TEST_GROUPS)) {
    const files = discoverTests(REPO_ROOT, roots);
    assert.ok(files.length > 0, `${group} discovered no test files`);
    // The registry that used to live in package.json can no longer drift:
    // discovery is the only source of truth, so assert it stays non-empty and
    // only ever yields real suites.
    assert.ok(
      files.every((file) => file.endsWith('.test.mjs')),
      `${group} discovered a non-test file`,
    );
  }
});

test('runGroup forwards the child exit code and passes discovered files', () => {
  const root = withFixture([path.join('a', 'own.test.mjs')]);
  try {
    let received = null;
    const code = runGroup({
      group: 'guards',
      roots: ['a'],
      repoRoot: root,
      spawn: (command, args, options) => {
        received = { command, args, options };
        return { status: 3, signal: null };
      },
    });
    assert.equal(code, 3);
    assert.equal(received.command, process.execPath);
    assert.equal(received.args[0], '--test');
    assert.equal(received.options.shell, false);
    assert.equal(received.options.cwd, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runGroup fails when the child cannot start or dies from a signal', () => {
  const root = withFixture([path.join('a', 'own.test.mjs')]);
  try {
    assert.equal(
      runGroup({
        group: 'guards',
        roots: ['a'],
        repoRoot: root,
        spawn: () => ({ error: new Error('ENOENT'), status: null, signal: null }),
      }),
      1,
    );
    assert.equal(
      runGroup({
        group: 'guards',
        roots: ['a'],
        repoRoot: root,
        spawn: () => ({ status: null, signal: 'SIGKILL' }),
      }),
      1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('chunkFiles keeps batches inside the argument budget without reordering', () => {
  const files = Array.from(
    { length: 50 },
    (_, index) => `dir/file-${String(index).padStart(3, '0')}.test.mjs`,
  );
  const chunks = chunkFiles(files, 100);
  assert.deepEqual(chunks.flat(), files, 'chunking must preserve discovery order');
  for (const chunk of chunks) {
    assert.ok(chunk.length > 0);
    assert.ok(chunk.reduce((sum, file) => sum + file.length + 1, 0) <= 100);
  }
  // A single file longer than the whole budget still gets its own batch rather
  // than being silently dropped.
  assert.deepEqual(chunkFiles(['x'.repeat(200)], 100), [['x'.repeat(200)]]);
  assert.deepEqual(chunkFiles([], 100), []);
});

test('the repository guards group stays inside the argument budget per batch', () => {
  for (const chunk of chunkFiles(discoverTests(REPO_ROOT, TEST_GROUPS.guards))) {
    assert.ok(chunk.reduce((sum, file) => sum + file.length + 1, 0) <= ARG_BUDGET_CHARS);
  }
});

test('runGroup runs every batch and reports the first failing exit code', () => {
  const root = withFixture([
    path.join('a', 'one.test.mjs'),
    path.join('a', 'two.test.mjs'),
    path.join('a', 'three.test.mjs'),
  ]);
  try {
    const statuses = [0, 4, 5];
    let calls = 0;
    const code = runGroup({
      group: 'guards',
      roots: ['a'],
      repoRoot: root,
      // A one-character budget forces exactly one batch per discovered file.
      argBudget: 1,
      spawn: () => ({ status: statuses[calls++], signal: null }),
    });
    // Every batch runs (later failures are not hidden) and the first non-zero
    // status is the group's result.
    assert.equal(calls, 3);
    assert.equal(code, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
