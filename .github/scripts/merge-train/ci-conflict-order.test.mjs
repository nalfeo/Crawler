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

// Returns a pull object in the shape returned by the GitHub list endpoint:
// no additions, deletions, or changed_files fields. This mirrors the real
// shape used by fetchOpenPulls() and exposes the asymmetry that would arise
// if normalizePull used the detailed REST shape for the candidate.
function makeListShapePull(number, sha, createdAt) {
  return {
    number,
    title: `feat: pr ${number}`,
    state: 'open',
    draft: false,
    created_at: createdAt,
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

test('ciConflictOrderReasonForPromotion excludes fork PRs from the cluster', async () => {
  // A fork PR that overlaps CI paths should never join the cluster or become
  // the ranked active slot; this prevents it from blocking internal promotions
  // or causing git-fetch failures for external SHAs.
  const { tmpDir, workDir, baseSha, pr1Sha, pr2Sha, pr3Sha } = setupRepo();
  try {
    const forkPull = {
      ...makePull(2, pr2Sha, 1, '2026-07-20T00:01:00Z'),
      // Override head repo to simulate a fork.
      head: {
        sha: pr2Sha,
        ref: 'feature/pr-2',
        repo: { full_name: 'external-user/Crawler' },
      },
    };
    const pulls = [
      makePull(1, pr1Sha, 2, '2026-07-20T00:00:00Z'),
      forkPull,
      makePull(3, pr3Sha, 2, '2026-07-20T00:02:00Z'),
    ];
    const files = new Map([
      [1, [{ filename: '.github/workflows/a.yml' }, { filename: '.github/workflows/b.yml' }]],
      [2, [{ filename: '.github/workflows/b.yml' }]],
      [3, [{ filename: '.github/workflows/b.yml' }, { filename: '.github/workflows/c.yml' }]],
    ]);
    // PR #1 is the active candidate; fork PR #2 touches overlapping CI paths
    // but must be ignored. The verifier should allow PR #1 (null reason).
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
    // Without the fork filter PR #1 and fork #2 overlap on b.yml and fork #2
    // would also overlap with #3 on b.yml, forming a 3-PR cluster. With the
    // filter, only PR #1 and PR #3 are internal — they overlap on b.yml — so
    // #1 is the active slot and the reason is null.
    assert.equal(reason, null);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ciConflictOrderReasonForPromotion excludes draft PRs from the cluster', async () => {
  const { tmpDir, workDir, baseSha, pr1Sha, pr2Sha, pr3Sha } = setupRepo();
  try {
    const draftPull = { ...makePull(2, pr2Sha, 1, '2026-07-20T00:01:00Z'), draft: true };
    const pulls = [
      makePull(1, pr1Sha, 2, '2026-07-20T00:00:00Z'),
      draftPull,
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

test('ciConflictOrderReasonForPromotion fails closed when a group member synchronizes during the scan', async () => {
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
    // Simulate PR #3 getting a new commit (synchronize) during the scan: the
    // final re-fetch returns a different head SHA for #3.
    const NEW_SHA_3 = 'a'.repeat(40);
    let fetchCallCount = 0;
    const reason = await ciConflictOrderReasonForPromotion({
      pullRequest: pulls[0],
      baseSha,
      owner: OWNER,
      repo: REPO,
      repository: REPOSITORY,
      trustedAppId: TRUSTED_APP_ID,
      requiredChecks: ['ci', 'Security checks'],
      git: (args, options) => git(workDir, args, options),
      fetchOpenPulls: async () => {
        fetchCallCount += 1;
        if (fetchCallCount === 1) {
          return pulls;
        }
        // Second call (final revalidation): PR #3 has a new head.
        return pulls.map((p) =>
          p.number === 3 ? { ...p, head: { ...p.head, sha: NEW_SHA_3 } } : p,
        );
      },
      fetchPullFiles: async (number) => files.get(number) || [],
      fetchComments: async () => [],
      fetchCheckRuns: async () => [
        { name: 'ci', status: 'completed', conclusion: 'success' },
        { name: 'Security checks', status: 'completed', conclusion: 'success' },
      ],
      fetchClosingIssues: async () => [],
    });
    assert.match(reason, /head drifted/);
    assert.match(reason, /#3/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ciConflictOrderReasonForPromotion fails closed when coordinated group membership changes during final revalidation', async () => {
  const { tmpDir, workDir, baseSha, pr1Sha, pr2Sha, pr3Sha } = setupRepo();
  try {
    const pulls = [
      makePull(1, pr1Sha, 2, '2026-07-20T00:00:00Z'),
      makePull(2, pr2Sha, 1, '2026-07-20T00:01:00Z'),
      makePull(3, pr3Sha, 2, '2026-07-20T00:02:00Z'),
    ];
    const pull4 = makePull(4, '4'.repeat(40), 1, '2026-07-20T00:03:00Z');
    const files = new Map([
      [1, [{ filename: '.github/workflows/a.yml' }, { filename: '.github/workflows/b.yml' }]],
      [2, [{ filename: '.github/workflows/b.yml' }]],
      [3, [{ filename: '.github/workflows/b.yml' }, { filename: '.github/workflows/c.yml' }]],
      [4, [{ filename: '.github/workflows/b.yml' }]],
    ]);
    let fetchOpenPullsCallCount = 0;
    const reason = await ciConflictOrderReasonForPromotion({
      pullRequest: pulls[0],
      baseSha,
      owner: OWNER,
      repo: REPO,
      repository: REPOSITORY,
      trustedAppId: TRUSTED_APP_ID,
      requiredChecks: ['ci', 'Security checks'],
      git: (args, options) => git(workDir, args, options),
      fetchOpenPulls: async () => {
        fetchOpenPullsCallCount += 1;
        return fetchOpenPullsCallCount === 1 ? pulls : [...pulls, pull4];
      },
      fetchPullFiles: async (number) => files.get(number) || [],
      fetchComments: async () => [],
      fetchCheckRuns: async () => [
        { name: 'ci', status: 'completed', conclusion: 'success' },
        { name: 'Security checks', status: 'completed', conclusion: 'success' },
      ],
      fetchClosingIssues: async () => [],
    });
    assert.match(reason, /group membership changed during verification/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ciConflictOrderReasonForPromotion fails closed when peer check status changes during final revalidation', async () => {
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
    let fetchOpenPullsCallCount = 0;
    const reason = await ciConflictOrderReasonForPromotion({
      pullRequest: pulls[0],
      baseSha,
      owner: OWNER,
      repo: REPO,
      repository: REPOSITORY,
      trustedAppId: TRUSTED_APP_ID,
      requiredChecks: ['ci', 'Security checks'],
      git: (args, options) => git(workDir, args, options),
      fetchOpenPulls: async () => {
        fetchOpenPullsCallCount += 1;
        return pulls;
      },
      fetchPullFiles: async (number) => files.get(number) || [],
      fetchComments: async () => [],
      fetchCheckRuns: async (sha) => {
        const finalPass = fetchOpenPullsCallCount > 1;
        if (finalPass && sha === pr2Sha) {
          return [{ name: 'ci', status: 'completed', conclusion: 'failure' }];
        }
        return [
          { name: 'ci', status: 'completed', conclusion: 'success' },
          { name: 'Security checks', status: 'completed', conclusion: 'success' },
        ];
      },
      fetchClosingIssues: async () => [],
    });
    assert.match(reason, /check status changed during verification/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ciConflictOrderReasonForPromotion uses file inventory for ranking regardless of REST shape', async () => {
  // Regression: fetchOpenPulls() returns list-endpoint shape (no additions/
  // deletions/changed_files), but the candidate is the detailed pullRequest
  // object (full GET response with additions/deletions populated). Without
  // uniform derivation from file inventory, the candidate always wins the
  // additions+deletions tiebreaker and can claim to be the active slot even
  // when an earlier-created peer should be ranked first.
  const { tmpDir, workDir, baseSha, pr1Sha, pr2Sha, pr3Sha } = setupRepo();
  try {
    // PR #1 was created first and has the same CI-file footprint as PR #3.
    // PR #3 is the candidate with a full GET shape (large additions/deletions).
    // PR #2 connects the cluster via b.yml overlap.
    const pull1 = makeListShapePull(1, pr1Sha, '2026-07-20T00:00:00Z');
    const pull2 = makeListShapePull(2, pr2Sha, '2026-07-20T00:01:00Z');
    // Candidate: full detailed GET shape with nonzero additions/deletions that
    // would win the tiebreaker before the file-inventory fix.
    const candidatePull3 = {
      ...makeListShapePull(3, pr3Sha, '2026-07-20T00:02:00Z'),
      additions: 200,
      deletions: 150,
      changed_files: 2,
    };
    const pulls = [pull1, pull2, candidatePull3];
    const files = new Map([
      [1, [{ filename: '.github/workflows/a.yml' }, { filename: '.github/workflows/b.yml' }]],
      [2, [{ filename: '.github/workflows/b.yml' }]],
      [3, [{ filename: '.github/workflows/a.yml' }, { filename: '.github/workflows/b.yml' }]],
    ]);
    // PR #1 and PR #3 both touch a.yml and b.yml (2 CI files each) so they
    // rank equally on green/ciFiles/changedFiles. The createdAt tiebreaker
    // makes PR #1 the active slot, so the later-created candidate #3 must be
    // blocked — regardless of how large its additions/deletions are.
    const reason = await ciConflictOrderReasonForPromotion({
      pullRequest: candidatePull3,
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

test('ciConflictOrderReasonForPromotion applies changed-line tiebreaker from file inventory', async () => {
  const { tmpDir, workDir, baseSha, pr1Sha, pr2Sha, pr3Sha } = setupRepo();
  try {
    const pull1 = makeListShapePull(1, pr1Sha, '2026-07-20T00:00:00Z');
    const pull2 = makeListShapePull(2, pr2Sha, '2026-07-20T00:01:00Z');
    const candidatePull3 = {
      ...makeListShapePull(3, pr3Sha, '2026-07-20T00:02:00Z'),
      additions: 1,
      deletions: 1,
      changed_files: 2,
    };
    const pulls = [pull1, pull2, candidatePull3];
    const files = new Map([
      [
        1,
        [
          { filename: '.github/workflows/a.yml', additions: 1, deletions: 1 },
          { filename: '.github/workflows/b.yml', additions: 1, deletions: 1 },
        ],
      ],
      [2, [{ filename: '.github/workflows/b.yml', additions: 1, deletions: 0 }]],
      [
        3,
        [
          { filename: '.github/workflows/a.yml', additions: 12, deletions: 4 },
          { filename: '.github/workflows/b.yml', additions: 10, deletions: 6 },
        ],
      ],
    ]);

    const reason = await ciConflictOrderReasonForPromotion({
      pullRequest: candidatePull3,
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
