import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ciConflictOrderReasonForPromotion } from './ci-conflict-order.mjs';

const OWNER = 'nalfeo';
const REPO = 'Crawler';
const REPOSITORY = `${OWNER}/${REPO}`;
const TRUSTED_APP_ID = 12345;

function git(cwd, args, options = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: cwd,
      ...(options.env || {}),
    },
  }).trim();
}

function commit(cwd, message) {
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '--allow-empty', '-m', message], {
    env: {
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
  return git(cwd, ['rev-parse', 'HEAD']);
}

function setupRepo() {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'crawler-merge-train-ci-order-'));
  const remoteDir = path.join(tmpDir, 'remote.git');
  const workDir = path.join(tmpDir, 'work');
  mkdirSync(remoteDir);
  mkdirSync(workDir);
  git(remoteDir, ['init', '--bare']);

  git(workDir, ['init', '--initial-branch=main']);
  git(workDir, ['remote', 'add', 'origin', remoteDir]);
  git(workDir, ['config', 'user.email', 'test@example.com']);
  git(workDir, ['config', 'user.name', 'Test']);

  mkdirSync(path.join(workDir, '.github', 'workflows'), { recursive: true });
  writeFileSync(path.join(workDir, '.github', 'workflows', 'a.yml'), 'base-a\n');
  writeFileSync(path.join(workDir, '.github', 'workflows', 'b.yml'), 'base-b\n');
  writeFileSync(path.join(workDir, '.github', 'workflows', 'c.yml'), 'base-c\n');
  const baseSha = commit(workDir, 'base');
  git(workDir, ['push', 'origin', 'main']);

  git(workDir, ['checkout', '-b', 'pr1', baseSha]);
  writeFileSync(path.join(workDir, '.github', 'workflows', 'a.yml'), 'pr1-a\n');
  writeFileSync(path.join(workDir, '.github', 'workflows', 'b.yml'), 'pr1-b\n');
  const pr1Sha = commit(workDir, 'pr1');
  git(workDir, ['push', 'origin', 'pr1']);

  git(workDir, ['checkout', '-b', 'pr2', baseSha]);
  writeFileSync(path.join(workDir, '.github', 'workflows', 'b.yml'), 'pr2-b\n');
  const pr2Sha = commit(workDir, 'pr2');
  git(workDir, ['push', 'origin', 'pr2']);

  git(workDir, ['checkout', '-b', 'pr3', baseSha]);
  writeFileSync(path.join(workDir, '.github', 'workflows', 'b.yml'), 'pr3-b\n');
  writeFileSync(path.join(workDir, '.github', 'workflows', 'c.yml'), 'pr3-c\n');
  const pr3Sha = commit(workDir, 'pr3');
  git(workDir, ['push', 'origin', 'pr3']);

  git(workDir, ['checkout', 'main']);
  return { tmpDir, workDir, baseSha, pr1Sha, pr2Sha, pr3Sha };
}

function makePull(number, sha, fileCount, createdAt) {
  return {
    number,
    title: `feat: pr ${number}`,
    state: 'open',
    draft: false,
    created_at: createdAt,
    additions: fileCount,
    deletions: 0,
    changed_files: fileCount,
    node_id: `PR_${number}`,
    auto_merge: null,
    labels: [{ name: 'merge-train' }],
    base: { ref: 'main' },
    head: {
      sha,
      ref: `feature/pr-${number}`,
      repo: { full_name: REPOSITORY },
    },
  };
}

test('ciConflictOrderReasonForPromotion blocks a non-current PR even before the label fence exists', async () => {
  const { tmpDir, workDir, baseSha, pr1Sha, pr2Sha, pr3Sha } = setupRepo();
  try {
    const pulls = [
      makePull(1, pr1Sha, 2, '2026-07-20T00:00:00Z'),
      makePull(2, pr2Sha, 1, '2026-07-20T00:01:00Z'),
      makePull(3, pr3Sha, 2, '2026-07-20T00:02:00Z'),
    ];
    const files = new Map([
      [1, [{ filename: '.github/workflows/a.yml' }, { filename: '.github/workflows/b.yml' }]],
      [2, [{ filename: '.github/workflows/b.yml' }]],
      [3, [{ filename: '.github/workflows/b.yml' }, { filename: '.github/workflows/c.yml' }]],
    ]);
    const reason = await ciConflictOrderReasonForPromotion({
      pullRequest: pulls[1],
      baseSha,
      owner: OWNER,
      repo: REPO,
      repository: REPOSITORY,
      trustedAppId: TRUSTED_APP_ID,
      requiredChecks: ['ci', 'Security checks'],
      git: (args, options) => git(workDir, args, options),
      fetchOpenPulls: async () => pulls,
      fetchPullFiles: async (number) => files.get(number) || [],
      fetchComments: async () => [],
      fetchCheckRuns: async () => [
        { name: 'ci', status: 'completed', conclusion: 'success' },
        { name: 'Security checks', status: 'completed', conclusion: 'success' },
      ],
      fetchClosingIssues: async () => [],
    });
    assert.match(reason, /currently selects #1/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ciConflictOrderReasonForPromotion allows the live active slot', async () => {
  const { tmpDir, workDir, baseSha, pr1Sha, pr2Sha, pr3Sha } = setupRepo();
  try {
    const pulls = [
      makePull(1, pr1Sha, 2, '2026-07-20T00:00:00Z'),
      makePull(2, pr2Sha, 1, '2026-07-20T00:01:00Z'),
      makePull(3, pr3Sha, 2, '2026-07-20T00:02:00Z'),
    ];
    const files = new Map([
      [1, [{ filename: '.github/workflows/a.yml' }, { filename: '.github/workflows/b.yml' }]],
      [2, [{ filename: '.github/workflows/b.yml' }]],
      [3, [{ filename: '.github/workflows/b.yml' }, { filename: '.github/workflows/c.yml' }]],
    ]);
    const reason = await ciConflictOrderReasonForPromotion({
      pullRequest: pulls[0],
      baseSha,
      owner: OWNER,
      repo: REPO,
      repository: REPOSITORY,
      trustedAppId: TRUSTED_APP_ID,
      requiredChecks: ['ci', 'Security checks'],
      git: (args, options) => git(workDir, args, options),
      fetchOpenPulls: async () => pulls,
      fetchPullFiles: async (number) => files.get(number) || [],
      fetchComments: async () => [],
      fetchCheckRuns: async () => [
        { name: 'ci', status: 'completed', conclusion: 'success' },
        { name: 'Security checks', status: 'completed', conclusion: 'success' },
      ],
      fetchClosingIssues: async () => [],
    });
    assert.equal(reason, null);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
