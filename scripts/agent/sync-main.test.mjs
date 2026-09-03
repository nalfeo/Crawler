import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { attemptMainSync, readSyncState } from './sync-main.mjs';

function git(cwd, args, env = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: cwd,
      ...env,
    },
  }).trim();
}

function commit(cwd, message) {
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-m', message], {
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  });
  return git(cwd, ['rev-parse', 'HEAD']);
}

function setupDivergedRepo({ branchName = 'feature', conflict = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'crawler-main-sync-'));
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  git(root, ['init', '--bare', remote]);
  git(root, ['init', '--initial-branch=main', work]);
  git(work, ['remote', 'add', 'origin', remote]);
  git(work, ['config', 'user.name', 'Test']);
  git(work, ['config', 'user.email', 'test@example.com']);
  git(work, ['config', 'core.autocrlf', 'false']);
  git(work, ['config', 'core.eol', 'lf']);

  writeFileSync(path.join(work, '.gitignore'), 'files/\n');
  writeFileSync(path.join(work, conflict ? 'shared.txt' : 'base.txt'), 'base\n');
  commit(work, 'base');
  git(work, ['push', '-u', 'origin', 'main']);

  git(work, ['checkout', '-b', branchName]);
  writeFileSync(path.join(work, conflict ? 'shared.txt' : 'feature.txt'), 'feature\n');
  const featureSha = commit(work, 'feature');

  git(work, ['checkout', 'main']);
  writeFileSync(path.join(work, conflict ? 'shared.txt' : 'main.txt'), 'main\n');
  commit(work, 'main');
  git(work, ['push', 'origin', 'main']);
  git(work, ['checkout', branchName]);

  return { root, work, featureSha };
}

function advanceMain(work, branchName, fileName, contents) {
  git(work, ['checkout', 'main']);
  writeFileSync(path.join(work, fileName), contents);
  commit(work, `main advances ${fileName}`);
  git(work, ['push', 'origin', 'main']);
  git(work, ['checkout', branchName]);
}

function setupReconciledShepherdRepo() {
  const branchName = 'copilot/ratings-ram-recovery';
  const root = mkdtempSync(path.join(tmpdir(), 'crawler-main-sync-'));
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  git(root, ['init', '--bare', remote]);
  git(root, ['init', '--initial-branch=main', work]);
  git(work, ['remote', 'add', 'origin', remote]);
  git(work, ['config', 'user.name', 'Test']);
  git(work, ['config', 'user.email', 'test@example.com']);
  git(work, ['config', 'core.autocrlf', 'false']);
  git(work, ['config', 'core.eol', 'lf']);

  writeFileSync(path.join(work, '.gitignore'), 'files/\n');
  writeFileSync(path.join(work, 'shared.txt'), 'base\n');
  commit(work, 'base');
  git(work, ['push', '-u', 'origin', 'main']);

  git(work, ['checkout', '-b', branchName]);
  writeFileSync(path.join(work, 'shared.txt'), 'feature\n');
  commit(work, 'feature edits shared file');

  git(work, ['checkout', 'main']);
  writeFileSync(path.join(work, 'shared.txt'), 'main one\n');
  commit(work, 'main edits shared file');
  git(work, ['push', 'origin', 'main']);

  git(work, ['checkout', branchName]);
  assert.throws(() => git(work, ['merge', '--no-edit', 'origin/main']));
  writeFileSync(path.join(work, 'shared.txt'), 'resolved feature plus main\n');
  commit(work, 'reconcile origin/main');
  const firstMergeSha = git(work, ['rev-parse', 'HEAD']);

  return { root, work, branchName, firstMergeSha };
}

test('clean branch rebases onto fetched origin/main and records success', (t) => {
  const { root, work, featureSha } = setupDivergedRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = attemptMainSync({ cwd: work, reason: 'test' });

  assert.equal(result.status, 'success');
  assert.equal(result.branchChanged, true);
  assert.equal(result.strategy, 'rebase');
  assert.notEqual(result.headSha, featureSha);
  assert.equal(readSyncState(work).lastResult, 'success');
  assert.equal(readSyncState(work).lastStrategy, 'rebase');
  assert.equal(git(work, ['status', '--porcelain']), '');
});

test('dirty worktree defers rebase without discarding changes', (t) => {
  const { root, work } = setupDivergedRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dirtyPath = path.join(work, 'dirty.txt');
  writeFileSync(dirtyPath, 'keep me\n');

  const result = attemptMainSync({ cwd: work, reason: 'test' });

  assert.equal(result.status, 'deferred-dirty');
  assert.equal(result.branchChanged, false);
  assert.equal(existsSync(dirtyPath), true);
});

test('conflicting rebase aborts and restores the original branch', (t) => {
  const { root, work, featureSha } = setupDivergedRepo({ conflict: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = attemptMainSync({ cwd: work, reason: 'test' });
  const rebasePath = git(work, ['rev-parse', '--git-path', 'rebase-merge']);

  assert.equal(result.status, 'conflict-aborted');
  assert.equal(result.strategy, 'rebase');
  assert.equal(git(work, ['rev-parse', 'HEAD']), featureSha);
  assert.equal(git(work, ['status', '--porcelain']), '');
  assert.equal(existsSync(path.resolve(work, rebasePath)), false);
});

test('recovery branch with existing mainline reconciliation merges preserves merge history across repeated main advances', (t) => {
  const { root, work, branchName, firstMergeSha } = setupReconciledShepherdRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  advanceMain(work, branchName, 'main-two.txt', 'main two\n');
  const firstResult = attemptMainSync({ cwd: work, reason: 'test' });
  advanceMain(work, branchName, 'main-three.txt', 'main three\n');
  const secondResult = attemptMainSync({ cwd: work, reason: 'test' });

  assert.equal(firstResult.status, 'success');
  assert.equal(firstResult.strategy, 'merge-preserving');
  assert.equal(secondResult.status, 'success');
  assert.equal(secondResult.strategy, 'merge-preserving');
  assert.equal(readFileSync(path.join(work, 'shared.txt'), 'utf8'), 'resolved feature plus main\n');
  assert.equal(readFileSync(path.join(work, 'main-two.txt'), 'utf8'), 'main two\n');
  assert.equal(readFileSync(path.join(work, 'main-three.txt'), 'utf8'), 'main three\n');
  assert.doesNotThrow(() => git(work, ['merge-base', '--is-ancestor', firstMergeSha, 'HEAD']));
  assert.equal(git(work, ['rev-list', '--count', '--merges', 'HEAD']), '3');
  assert.equal(readSyncState(work).lastStrategy, 'merge-preserving');
  assert.match(readSyncState(work).lastStrategyReason, /existing mainline reconciliation merge/);
});

test('conflicting merge-preserving sync aborts and restores the original shepherd branch', (t) => {
  const { root, work, branchName } = setupReconciledShepherdRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const headBefore = git(work, ['rev-parse', 'HEAD']);
  git(work, ['checkout', 'main']);
  writeFileSync(path.join(work, 'shared.txt'), 'main two\n');
  commit(work, 'main conflicts with reconciled file');
  git(work, ['push', 'origin', 'main']);
  git(work, ['checkout', branchName]);

  const result = attemptMainSync({ cwd: work, reason: 'test' });
  const mergeHeadPath = git(work, ['rev-parse', '--git-path', 'MERGE_HEAD']);

  assert.equal(result.status, 'conflict-aborted');
  assert.equal(result.strategy, 'merge-preserving');
  assert.match(result.message, /Merge-preserving update conflicted and was aborted cleanly/);
  assert.equal(git(work, ['rev-parse', 'HEAD']), headBefore);
  assert.equal(readFileSync(path.join(work, 'shared.txt'), 'utf8'), 'resolved feature plus main\n');
  assert.equal(git(work, ['status', '--porcelain']), '');
  assert.equal(existsSync(path.resolve(work, mergeHeadPath)), false);
});

test('ordinary branch with an existing merge keeps the default rebase strategy', (t) => {
  const { root, work, branchName } = setupReconciledShepherdRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(work, ['branch', '-m', branchName, 'fix/recovery-timeout-bug']);
  const headBefore = git(work, ['rev-parse', 'HEAD']);
  advanceMain(work, 'fix/recovery-timeout-bug', 'main-two.txt', 'main two\n');

  const result = attemptMainSync({ cwd: work, reason: 'test' });

  assert.equal(result.status, 'conflict-aborted');
  assert.equal(result.strategy, 'rebase');
  assert.match(result.strategyReason, /no shepherd\/recovery ownership context/);
  assert.equal(git(work, ['rev-parse', 'HEAD']), headBefore);
  assert.equal(git(work, ['status', '--porcelain']), '');
});
