import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

function setupDivergedRepo({ conflict = false } = {}) {
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

  git(work, ['checkout', '-b', 'feature']);
  writeFileSync(path.join(work, conflict ? 'shared.txt' : 'feature.txt'), 'feature\n');
  const featureSha = commit(work, 'feature');

  git(work, ['checkout', 'main']);
  writeFileSync(path.join(work, conflict ? 'shared.txt' : 'main.txt'), 'main\n');
  commit(work, 'main');
  git(work, ['push', 'origin', 'main']);
  git(work, ['checkout', 'feature']);

  return { root, work, featureSha };
}

test('clean branch rebases onto fetched origin/main and records success', (t) => {
  const { root, work, featureSha } = setupDivergedRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = attemptMainSync({ cwd: work, reason: 'test' });

  assert.equal(result.status, 'success');
  assert.equal(result.branchChanged, true);
  assert.notEqual(result.headSha, featureSha);
  assert.equal(readSyncState(work).lastResult, 'success');
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
  assert.equal(git(work, ['rev-parse', 'HEAD']), featureSha);
  assert.equal(git(work, ['status', '--porcelain']), '');
  assert.equal(existsSync(path.resolve(work, rebasePath)), false);
});
