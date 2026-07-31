import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { resolveNodeModules } from '../node-modules-resolver.mjs';

const temporaryRoots = [];

function tempRoot(prefix) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

test('resolveNodeModules returns repoRoot/node_modules in a regular checkout layout', () => {
  const repoRoot = tempRoot('node-modules-resolver-direct-');
  const expected = path.join(repoRoot, 'node_modules');
  mkdirSync(expected, { recursive: true });
  mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
  assert.equal(resolveNodeModules(repoRoot), expected);
});

test('resolveNodeModules follows a relative gitdir pointer for linked worktrees', () => {
  const root = tempRoot('node-modules-resolver-worktree-');
  const mainRoot = path.join(root, 'main');
  const worktreeRoot = path.join(root, 'worktree');
  const expected = path.join(mainRoot, 'node_modules');
  mkdirSync(expected, { recursive: true });
  mkdirSync(path.join(mainRoot, '.git', 'worktrees', 'wt'), { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  writeFileSync(path.join(worktreeRoot, '.git'), 'gitdir: ../main/.git/worktrees/wt\n');
  assert.equal(resolveNodeModules(worktreeRoot), expected);
});
