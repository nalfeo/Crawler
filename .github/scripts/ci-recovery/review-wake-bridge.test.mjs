import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  getGitHubSubtreeSnapshot,
  getWorkflowTreeSnapshot,
  inspectReviewWake,
  PROTECTED_WORKFLOW_PATHS,
  runFromEnv,
} from './review-wake-bridge.mjs';

const repository = 'nalfeo/Crawler';
const trustedActor = { id: 175728472, login: 'Copilot', type: 'Bot' };
const trustedReviewAlias = {
  id: 175728472,
  login: 'copilot-pull-request-reviewer[bot]',
  type: 'Bot',
};
const mergeBaseSha = 'd'.repeat(40);
const runCreatedAt = '2026-07-17T04:36:29Z';
const evidenceSince = '2026-07-17T04:35:59.000Z';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const protectedPaths = [
  '.github/workflows/ci-recovery-router.yml',
  '.github/workflows/ci-recovery-review-wake-bridge.yml',
  '.github/workflows/ci-recovery.yml',
  '.github/workflows/auto-rebase-prs.yml',
  '.github/scripts/ci-recovery/review-wake-bridge.mjs',
  '.github/scripts/ci-recovery/router.mjs',
  '.github/scripts/ci-recovery/reconcile.mjs',
  '.github/scripts/ci-recovery/dispatch-table.mjs',
  '.github/scripts/ci-recovery/decision-log.mjs',
  '.github/scripts/ci-recovery/pr-lifecycle.mjs',
  '.github/scripts/ci-recovery/review-request.mjs',
  '.github/scripts/ci-recovery/loop-incident-lib.mjs',
  '.github/scripts/ci-recovery/markers.mjs',
  '.github/scripts/ci-recovery/github.mjs',
  '.github/scripts/ci-recovery/issue-intake-lib.mjs',
  '.github/scripts/ci-recovery/state.mjs',
  '.github/scripts/ci-recovery/approval.mjs',
  '.github/scripts/ci-recovery/unexpected-error.mjs',
  '.github/scripts/ci-conflict-coordinator/state.mjs',
  '.github/scripts/merge-train/state.mjs',
  '.github/scripts/merge-train/human-approval.mjs',
];
const addedProtectedPaths = protectedPaths.slice(3);

function relativeImportClosure(entryPaths, rootDir = repoRoot) {
  const pending = [...entryPaths];
  const visited = new Set();
  while (pending.length > 0) {
    const relativePath = pending.pop();
    if (visited.has(relativePath)) continue;
    visited.add(relativePath);
    const absolutePath = path.join(rootDir, relativePath);
    const source = readFileSync(absolutePath, 'utf8');
    // Match all relative ESM import forms:
    //   import { … } from './rel'   (named/default)
    //   import './rel'              (side-effect)
    //   import('./rel')             (dynamic)
    for (const match of source.matchAll(
      /(?:from\s+|import\s+|import\s*\(\s*)['"`](\.{1,2}\/[^'"`]+)['"`]/g,
    )) {
      const dependency = path
        .relative(rootDir, path.resolve(path.dirname(absolutePath), match[1]))
        .replaceAll('\\', '/');
      pending.push(dependency);
    }
  }
  return visited;
}

function fixture() {
  // Parked-run shape and timing are captured from production runs 29555271824
  // and 29555438886. IDs and head values stay compact for deterministic tests.
  const pullRequest = {
    number: 42,
    state: 'open',
    draft: false,
    changed_files: 1,
    base: { ref: 'main', repo: { full_name: repository } },
    head: { sha: 'a'.repeat(40), ref: 'feature-branch', repo: { full_name: repository } },
  };
  return {
    payload: {
      action: 'completed',
      repository: { full_name: repository, default_branch: 'main' },
      workflow_run: { id: 123 },
    },
    run: {
      id: 123,
      name: 'CI Recovery Router',
      display_title: 'ci: recover parked trusted Copilot review wakes',
      path: '.github/workflows/ci-recovery-router.yml',
      status: 'completed',
      conclusion: 'action_required',
      event: 'pull_request_review_comment',
      created_at: runCreatedAt,
      head_sha: 'a'.repeat(40),
      head_branch: 'feature-branch',
      repository: { full_name: repository },
      head_repository: { full_name: repository },
      actor: trustedActor,
      triggering_actor: trustedActor,
      pull_requests: [{ number: 42 }],
    },
    pullRequest,
  };
}

function trustedEvidence(run, prNumber = 42) {
  if (run.event === 'pull_request_review_comment') {
    return {
      id: 3600395651,
      created_at: '2026-07-17T04:36:26Z',
      commit_id: run.head_sha,
      pull_request_url: `https://api.github.com/repos/${repository}/pulls/${prNumber}`,
      user: trustedActor,
    };
  }
  return {
    id: 4719379726,
    submitted_at: '2026-07-17T04:36:27Z',
    commit_id: run.head_sha,
    user: trustedReviewAlias,
  };
}

function fakeApi({
  run,
  pulls = {},
  workflowFiles = {},
  workflowTrees = {},
  comparison = { merge_base_commit: { sha: mergeBaseSha } },
  reviewEvidence = null,
}) {
  const calls = [];
  const workflowCalls = [];
  const githubSubtreeCalls = [];
  const evidenceByPr = reviewEvidence ?? { 42: [trustedEvidence(run)] };
  return {
    calls,
    workflowCalls,
    githubSubtreeCalls,
    api: {
      async getRun(id) {
        calls.push(['getRun', id]);
        return run;
      },
      async getWorkflowFile(path, ref) {
        workflowCalls.push([path, ref]);
        const specificKey = `${path}@${ref}`;
        const sha = Object.hasOwn(workflowFiles, specificKey)
          ? workflowFiles[specificKey]
          : Object.hasOwn(workflowFiles, ref)
            ? workflowFiles[ref]
            : `trusted-workflow-blob:${path}`;
        return sha === null ? null : { sha };
      },
      async getGitHubSubtree(subtree, ref) {
        githubSubtreeCalls.push([subtree, ref]);
        const key = `${subtree}@${ref}`;
        const sha = Object.hasOwn(workflowTrees, key)
          ? workflowTrees[key]
          : Object.hasOwn(workflowTrees, ref)
            ? workflowTrees[ref]
            : 'trusted-workflow-tree';
        return sha === null ? null : { sha };
      },
      async compareCommits(base, head) {
        calls.push(['compareCommits', base, head]);
        return comparison;
      },
      async getPull(number) {
        calls.push(['getPull', number]);
        return pulls[number];
      },
      async listReviewEvidence(number, event, since) {
        calls.push(['listReviewEvidence', number, event, since]);
        return evidenceByPr[number] ?? [];
      },
    },
  };
}

test('accepts one parked trusted Copilot review wake for one exact PR', async () => {
  const data = fixture();
  const fake = fakeApi({
    run: data.run,
    pulls: { 42: data.pullRequest },
  });

  assert.deepEqual(await inspectReviewWake({ payload: data.payload, repository, api: fake.api }), {
    prNumber: 42,
    trigger: 'trusted-review-wake:pull_request_review_comment:run-123',
    headSha: 'a'.repeat(40),
  });
  assert.deepEqual(fake.calls, [
    ['getRun', 123],
    ['compareCommits', 'main', 'a'.repeat(40)],
    ['listReviewEvidence', 42, 'pull_request_review_comment', evidenceSince],
    ['getPull', 42],
  ]);
  assert.deepEqual(fake.githubSubtreeCalls, [
    ['workflows', mergeBaseSha],
    ['workflows', 'a'.repeat(40)],
    ['scripts', mergeBaseSha],
    ['scripts', 'a'.repeat(40)],
    ['actions', mergeBaseSha],
    ['actions', 'a'.repeat(40)],
  ]);
  assert.equal(fake.workflowCalls.length, protectedPaths.length * 2);
  for (const path of protectedPaths) {
    assert.deepEqual(
      fake.workflowCalls.filter(([candidate]) => candidate === path),
      [
        [path, mergeBaseSha],
        [path, 'a'.repeat(40)],
      ],
    );
  }
});

test('runFromEnv keeps slashes literal in default-branch compare URLs', async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'review-wake-bridge-test-'));
  const eventPath = path.join(tempDir, 'event.json');
  const outputPath = path.join(tempDir, 'output.txt');
  const data = fixture();
  data.payload.repository.default_branch = 'copilot/default-branch';
  writeFileSync(eventPath, JSON.stringify(data.payload));
  const paths = [];
  const stop = new Error('stop after compare');
  const comparePath = `/repos/${repository}/compare/copilot/default-branch...${data.run.head_sha}`;

  try {
    await assert.rejects(
      runFromEnv(
        {
          GITHUB_TOKEN: 'test-token',
          GITHUB_REPOSITORY: repository,
          GITHUB_EVENT_NAME: 'workflow_run',
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_OUTPUT: outputPath,
        },
        async (_token, requestPath) => {
          paths.push(requestPath);
          if (requestPath.endsWith('/actions/runs/123')) return { data: data.run };
          if (requestPath.includes('/compare/')) throw stop;
          throw new Error(`Unexpected request ${requestPath}`);
        },
      ),
      stop,
    );
    assert.ok(paths.includes(comparePath));
    assert.ok(!paths.some((requestPath) => requestPath.includes('%2F')));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('protected paths are the exact privileged recovery execution boundary', () => {
  assert.deepEqual([...PROTECTED_WORKFLOW_PATHS].sort(), [...protectedPaths].sort());
  assert.equal(
    [...PROTECTED_WORKFLOW_PATHS].some((candidate) => candidate.includes('*')),
    false,
  );

  const closure = relativeImportClosure([
    '.github/scripts/ci-recovery/router.mjs',
    '.github/scripts/ci-recovery/review-wake-bridge.mjs',
    '.github/scripts/ci-recovery/reconcile.mjs',
  ]);
  for (const dependency of closure) {
    assert.equal(
      PROTECTED_WORKFLOW_PATHS.has(dependency),
      true,
      `privileged dependency must be protected: ${dependency}`,
    );
  }
});

test('rejects when the protected .github/scripts subtree differs from merge base', async () => {
  const data = fixture();
  const fake = fakeApi({
    run: data.run,
    pulls: { 42: data.pullRequest },
    workflowTrees: {
      [`scripts@${mergeBaseSha}`]: 'trusted-scripts-tree',
      [`scripts@${'a'.repeat(40)}`]: 'modified-scripts-tree',
    },
  });

  assert.deepEqual(await inspectReviewWake({ payload: data.payload, repository, api: fake.api }), {
    reason: 'github-scripts-tree-modified',
  });
});

test('rejects when the protected .github/actions subtree differs from merge base', async () => {
  const data = fixture();
  const fake = fakeApi({
    run: data.run,
    pulls: { 42: data.pullRequest },
    workflowTrees: {
      [`actions@${mergeBaseSha}`]: 'trusted-actions-tree',
      [`actions@${'a'.repeat(40)}`]: 'modified-actions-tree',
    },
  });

  assert.deepEqual(await inspectReviewWake({ payload: data.payload, repository, api: fake.api }), {
    reason: 'github-actions-tree-modified',
  });
});

test('resolves the immutable Actions subtree and rejects incomplete tree evidence', async () => {
  const rootTreeSha = '1'.repeat(40);
  const githubTreeSha = '2'.repeat(40);
  const workflowTreeSha = '3'.repeat(40);
  const calls = [];
  const requestFn = async (_token, path) => {
    calls.push(path);
    if (path.endsWith(`/git/commits/${mergeBaseSha}`)) {
      return { data: { tree: { sha: rootTreeSha } } };
    }
    if (path.endsWith(`/git/trees/${rootTreeSha}`)) {
      return {
        data: { truncated: false, tree: [{ path: '.github', type: 'tree', sha: githubTreeSha }] },
      };
    }
    if (path.endsWith(`/git/trees/${githubTreeSha}`)) {
      return {
        data: {
          truncated: false,
          tree: [{ path: 'workflows', type: 'tree', sha: workflowTreeSha }],
        },
      };
    }
    throw new Error(`unexpected request: ${path}`);
  };

  assert.deepEqual(
    await getWorkflowTreeSnapshot({
      token: 'test-token',
      owner: 'nalfeo',
      repo: 'Crawler',
      ref: mergeBaseSha,
      requestFn,
    }),
    { sha: workflowTreeSha },
  );
  assert.deepEqual(calls, [
    `/repos/nalfeo/Crawler/git/commits/${mergeBaseSha}`,
    `/repos/nalfeo/Crawler/git/trees/${rootTreeSha}`,
    `/repos/nalfeo/Crawler/git/trees/${githubTreeSha}`,
  ]);
  assert.equal(
    await getWorkflowTreeSnapshot({
      token: 'test-token',
      owner: 'nalfeo',
      repo: 'Crawler',
      ref: mergeBaseSha,
      requestFn: async () => ({ data: { truncated: true, tree: [] } }),
    }),
    null,
  );
  assert.deepEqual(
    await getGitHubSubtreeSnapshot({
      token: 'test-token',
      owner: 'nalfeo',
      repo: 'Crawler',
      ref: mergeBaseSha,
      subtree: 'scripts',
      requestFn: async (_token, path) => {
        if (path.endsWith(`/git/commits/${mergeBaseSha}`)) {
          return { data: { tree: { sha: rootTreeSha } } };
        }
        if (path.endsWith(`/git/trees/${rootTreeSha}`)) {
          return {
            data: {
              truncated: false,
              tree: [{ path: '.github', type: 'tree', sha: githubTreeSha }],
            },
          };
        }
        if (path.endsWith(`/git/trees/${githubTreeSha}`)) {
          return {
            data: {
              truncated: false,
              tree: [{ path: 'scripts', type: 'tree', sha: workflowTreeSha }],
            },
          };
        }
        throw new Error(`unexpected request: ${path}`);
      },
    }),
    { sha: workflowTreeSha },
  );
});

test('relativeImportClosure follows side-effect and dynamic relative imports', () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'ci-closure-test-'));
  try {
    writeFileSync(
      path.join(tempDir, 'entry.mjs'),
      [
        "import './side-effect.mjs';",
        "const m = await import('./dynamic.mjs');",
        "const spaced = await import( './dynamic-spaced.mjs' );",
        'const template = await import(`./dynamic-template.mjs`);',
        "import { named } from './named.mjs';",
      ].join('\n'),
    );
    writeFileSync(path.join(tempDir, 'side-effect.mjs'), '');
    writeFileSync(path.join(tempDir, 'dynamic.mjs'), '');
    writeFileSync(path.join(tempDir, 'dynamic-spaced.mjs'), '');
    writeFileSync(path.join(tempDir, 'dynamic-template.mjs'), '');
    writeFileSync(path.join(tempDir, 'named.mjs'), '');

    const closure = relativeImportClosure(['entry.mjs'], tempDir);
    assert.equal(closure.has('entry.mjs'), true);
    assert.equal(closure.has('side-effect.mjs'), true, 'side-effect import not followed');
    assert.equal(closure.has('dynamic.mjs'), true, 'dynamic import not followed');
    assert.equal(closure.has('dynamic-spaced.mjs'), true, 'spaced dynamic import not followed');
    assert.equal(closure.has('dynamic-template.mjs'), true, 'template dynamic import not followed');
    assert.equal(closure.has('named.mjs'), true, 'named import not followed');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('accepts trusted comment provenance from the configured GHES API origin', async () => {
  const data = fixture();
  const apiBaseUrl = 'https://github.example.test/api/v3';
  const evidence = trustedEvidence(data.run);
  evidence.pull_request_url = `${apiBaseUrl}/repos/${repository}/pulls/42`;
  const fake = fakeApi({
    run: data.run,
    pulls: { 42: data.pullRequest },
    reviewEvidence: { 42: [evidence] },
  });

  const result = await inspectReviewWake({
    payload: data.payload,
    repository,
    api: fake.api,
    apiBaseUrl,
  });
  assert.equal(result.prNumber, 42);
});

test('binds the accepted wake to the validated run head SHA (lowercased)', async () => {
  const data = fixture();
  const upper = 'A'.repeat(40);
  data.run.head_sha = upper;
  data.pullRequest.head.sha = upper;
  const fake = fakeApi({
    run: data.run,
    pulls: { 42: data.pullRequest },
  });

  const result = await inspectReviewWake({ payload: data.payload, repository, api: fake.api });
  assert.equal(result.prNumber, 42);
  assert.equal(result.headSha, 'a'.repeat(40));
});

test('accepts a parked trusted submitted-review wake using the REST review record', async () => {
  const data = fixture();
  data.run.event = 'pull_request_review';
  const fake = fakeApi({
    run: data.run,
    pulls: { 42: data.pullRequest },
  });

  assert.deepEqual(await inspectReviewWake({ payload: data.payload, repository, api: fake.api }), {
    prNumber: 42,
    trigger: 'trusted-review-wake:pull_request_review:run-123',
    headSha: 'a'.repeat(40),
  });
  assert.deepEqual(fake.calls, [
    ['getRun', 123],
    ['compareCommits', 'main', data.run.head_sha],
    ['listReviewEvidence', 42, 'pull_request_review', evidenceSince],
    ['getPull', 42],
  ]);
});

test('multiple matching trusted comments on one PR still select exactly that PR', async () => {
  const data = fixture();
  const secondComment = {
    ...trustedEvidence(data.run),
    id: 3600395682,
    created_at: '2026-07-17T04:36:27Z',
  };
  const fake = fakeApi({
    run: data.run,
    pulls: { 42: data.pullRequest },
    reviewEvidence: { 42: [trustedEvidence(data.run), secondComment] },
  });

  const result = await inspectReviewWake({ payload: data.payload, repository, api: fake.api });
  assert.equal(result.prNumber, 42);
});

test('fails closed when run.pull_requests is empty without calling any commit API', async () => {
  const data = fixture();
  data.run.pull_requests = [];
  const fake = fakeApi({ run: data.run });

  assert.deepEqual(await inspectReviewWake({ payload: data.payload, repository, api: fake.api }), {
    reason: 'no-associated-pr',
  });
  // Must not reach any PR or commit lookup — only the run fetch is allowed.
  assert.deepEqual(fake.calls, [['getRun', 123]]);
});

test('fails closed when a parked association has no valid PR number', async () => {
  const data = fixture();
  data.run.pull_requests = [{ number: 'not-a-number' }];
  const fake = fakeApi({ run: data.run });

  assert.deepEqual(await inspectReviewWake({ payload: data.payload, repository, api: fake.api }), {
    reason: 'invalid-associated-pr',
  });
});

test('fails closed before source-PR selection when the run used a modified router workflow', async () => {
  const data = fixture();
  const fake = fakeApi({
    run: data.run,
    workflowFiles: {
      [`.github/workflows/ci-recovery-router.yml@${mergeBaseSha}`]: 'trusted-router-blob',
      [`.github/workflows/ci-recovery-router.yml@${data.run.head_sha}`]: 'modified-router-blob',
    },
  });

  assert.deepEqual(await inspectReviewWake({ payload: data.payload, repository, api: fake.api }), {
    reason: 'router-workflow-untrusted',
  });
  assert.deepEqual(fake.calls, [
    ['getRun', 123],
    ['compareCommits', 'main', data.run.head_sha],
  ]);
  assert.equal(fake.workflowCalls.length, protectedPaths.length * 2);
  for (const protectedPath of protectedPaths) {
    assert.deepEqual(
      fake.workflowCalls.filter(([candidate]) => candidate === protectedPath),
      [
        [protectedPath, mergeBaseSha],
        [protectedPath, data.run.head_sha],
      ],
    );
  }
});

test('selects the trusted-event source PR even when extra PRs are associated', async () => {
  const data = fixture();
  // Association only bounds the lookup. Only PR #42 has the trusted review
  // record matching this run's immutable head and timestamp.
  data.run.pull_requests = [{ number: 42 }, { number: 43 }];
  const fake = fakeApi({
    run: data.run,
    pulls: { 42: data.pullRequest },
  });

  assert.deepEqual(await inspectReviewWake({ payload: data.payload, repository, api: fake.api }), {
    prNumber: 42,
    trigger: 'trusted-review-wake:pull_request_review_comment:run-123',
    headSha: 'a'.repeat(40),
  });
  assert.deepEqual(fake.calls, [
    ['getRun', 123],
    ['compareCommits', 'main', 'a'.repeat(40)],
    ['listReviewEvidence', 42, 'pull_request_review_comment', evidenceSince],
    ['listReviewEvidence', 43, 'pull_request_review_comment', evidenceSince],
    ['getPull', 42],
  ]);
});

test('does not substitute an unrelated associated PR when the source PR head moved', async () => {
  const data = fixture();
  // The reviewed source PR (#42) advanced its head after the run, so it no
  // longer matches run.head_sha. An unrelated PR (#43) happens to sit at
  // run.head_sha. Only #42 has the trusted review event that preceded the run,
  // so the bridge must fail closed on its moved live head and never fetch #43.
  data.run.pull_requests = [{ number: 42 }, { number: 43 }];
  const movedSource = {
    ...data.pullRequest,
    head: { ...data.pullRequest.head, sha: 'c'.repeat(40) },
  };
  const unrelatedAtRunHead = {
    number: 43,
    state: 'open',
    changed_files: 1,
    base: { ref: 'main', repo: { full_name: repository } },
    head: { sha: 'a'.repeat(40), ref: 'other-branch', repo: { full_name: repository } },
  };
  const fake = fakeApi({
    run: data.run,
    pulls: { 42: movedSource, 43: unrelatedAtRunHead },
  });

  assert.deepEqual(await inspectReviewWake({ payload: data.payload, repository, api: fake.api }), {
    reason: 'head-sha-mismatch',
  });
  // Only the bound PR is fetched; the unrelated same-head PR is never read.
  assert.deepEqual(fake.calls, [
    ['getRun', 123],
    ['compareCommits', 'main', 'a'.repeat(40)],
    ['listReviewEvidence', 42, 'pull_request_review_comment', evidenceSince],
    ['listReviewEvidence', 43, 'pull_request_review_comment', evidenceSince],
    ['getPull', 42],
  ]);
});

test('fails closed when no associated PR has trusted review-event provenance', async () => {
  const data = fixture();
  const fake = fakeApi({ run: data.run, reviewEvidence: {} });

  assert.deepEqual(await inspectReviewWake({ payload: data.payload, repository, api: fake.api }), {
    reason: 'missing-review-event-provenance',
  });
  assert.deepEqual(fake.calls, [
    ['getRun', 123],
    ['compareCommits', 'main', data.run.head_sha],
    ['listReviewEvidence', 42, 'pull_request_review_comment', evidenceSince],
  ]);
});

for (const [name, mutateEvidence] of [
  [
    'untrusted reviewer',
    (evidence) => (evidence.user = { id: 4, login: 'attacker', type: 'User' }),
  ],
  ['different reviewed commit', (evidence) => (evidence.commit_id = 'b'.repeat(40))],
  [
    'evidence older than the bounded correlation window',
    (evidence) => {
      evidence.created_at = '2026-07-17T04:35:58Z';
    },
  ],
  [
    'evidence created after the run',
    (evidence) => {
      evidence.created_at = '2026-07-17T04:36:30Z';
    },
  ],
  [
    'evidence naming another PR',
    (evidence) => {
      evidence.pull_request_url = `https://api.github.com/repos/${repository}/pulls/43`;
    },
  ],
]) {
  test(`fails closed for ${name}`, async () => {
    const data = fixture();
    const evidence = trustedEvidence(data.run);
    mutateEvidence(evidence);
    const fake = fakeApi({
      run: data.run,
      reviewEvidence: { 42: [evidence] },
    });

    assert.deepEqual(
      await inspectReviewWake({ payload: data.payload, repository, api: fake.api }),
      {
        reason: 'missing-review-event-provenance',
      },
    );
  });
}

test('an old edited or dismissed review has no fresh immutable provenance', async () => {
  const data = fixture();
  data.run.event = 'pull_request_review';
  const oldReview = trustedEvidence(data.run);
  oldReview.submitted_at = '2026-07-17T04:35:58Z';
  const fake = fakeApi({
    run: data.run,
    reviewEvidence: { 42: [oldReview] },
  });

  assert.deepEqual(await inspectReviewWake({ payload: data.payload, repository, api: fake.api }), {
    reason: 'missing-review-event-provenance',
  });
});

test('fails closed when trusted review evidence matches more than one associated PR', async () => {
  const data = fixture();
  data.run.pull_requests = [{ number: 42 }, { number: 43 }];
  const fake = fakeApi({
    run: data.run,
    reviewEvidence: {
      42: [trustedEvidence(data.run, 42)],
      43: [trustedEvidence(data.run, 43)],
    },
  });

  assert.deepEqual(await inspectReviewWake({ payload: data.payload, repository, api: fake.api }), {
    reason: 'ambiguous-review-event-provenance',
  });
  assert.deepEqual(fake.calls, [
    ['getRun', 123],
    ['compareCommits', 'main', data.run.head_sha],
    ['listReviewEvidence', 42, 'pull_request_review_comment', evidenceSince],
    ['listReviewEvidence', 43, 'pull_request_review_comment', evidenceSince],
  ]);
});

test('rejects a source PR whose head ref differs from the run head branch', async () => {
  const data = fixture();
  data.pullRequest.head.ref = 'renamed-branch';
  const fake = fakeApi({
    run: data.run,
    pulls: { 42: data.pullRequest },
  });

  assert.deepEqual(await inspectReviewWake({ payload: data.payload, repository, api: fake.api }), {
    reason: 'head-branch-mismatch',
  });
  assert.deepEqual(fake.calls, [
    ['getRun', 123],
    ['compareCommits', 'main', data.run.head_sha],
    ['listReviewEvidence', 42, 'pull_request_review_comment', evidenceSince],
    ['getPull', 42],
  ]);
});

for (const [name, mutate, expected] of [
  ['normal success', (run) => (run.conclusion = 'success'), 'conclusion=success'],
  ['non-review event', (run) => (run.event = 'pull_request_target'), 'event=pull_request_target'],
  ['different workflow', (run) => (run.path = '.github/workflows/ci.yml'), 'workflow-path'],
  [
    'case-variant router workflow path',
    (run) => (run.path = '.github/workflows/CI-Recovery-Router.yml'),
    'workflow-path',
  ],
  ['untrusted actor', (run) => (run.actor = { id: 4, login: 'attacker', type: 'User' }), 'actor'],
  [
    'human rerun',
    (run) => (run.triggering_actor = { id: 5, login: 'maintainer', type: 'User' }),
    'triggering-actor',
  ],
  [
    'fork run',
    (run) => (run.head_repository = { full_name: 'attacker/Crawler' }),
    'run-head-repository',
  ],
  ['invalid run timestamp', (run) => (run.created_at = 'not-a-date'), 'run-created-at'],
]) {
  test(`dispatches nothing for ${name}`, async () => {
    const data = fixture();
    mutate(data.run);
    const fake = fakeApi({ run: data.run });
    assert.deepEqual(
      await inspectReviewWake({ payload: data.payload, repository, api: fake.api }),
      { reason: expected },
    );
    assert.deepEqual(fake.calls, [['getRun', 123]]);
  });
}

test('rejects changed or missing protected workflows using immutable run-head blobs', async () => {
  for (const [path, runBlob] of [
    ['.github/workflows/ci-recovery-review-wake-bridge.yml', 'modified-workflow-blob'],
    ['.github/workflows/ci-recovery.yml', null],
  ]) {
    const data = fixture();
    const fake = fakeApi({
      run: data.run,
      workflowFiles: {
        [`${path}@${mergeBaseSha}`]: 'trusted-workflow-blob',
        [`${path}@${data.run.head_sha}`]: runBlob,
      },
    });
    assert.deepEqual(
      await inspectReviewWake({ payload: data.payload, repository, api: fake.api }),
      { reason: 'protected-workflow-modified' },
    );
  }
});

test('rejects any workflow-tree addition, edit, deletion, rename, or missing evidence', async () => {
  for (const [name, baseTree, headTree] of [
    ['addition or edit', 'trusted-workflow-tree', 'branch-authored-workflow-tree'],
    ['missing base evidence', null, 'branch-authored-workflow-tree'],
    ['missing head evidence', 'trusted-workflow-tree', null],
    ['missing both snapshots', null, null],
  ]) {
    const data = fixture();
    const fake = fakeApi({
      run: data.run,
      workflowTrees: {
        [mergeBaseSha]: baseTree,
        [data.run.head_sha]: headTree,
      },
    });
    assert.deepEqual(
      await inspectReviewWake({ payload: data.payload, repository, api: fake.api }),
      { reason: 'workflow-tree-modified' },
      name,
    );
    assert.deepEqual(fake.workflowCalls, [], name);
  }
});

test('rejects script-only and auto-rebase changes in the privileged execution boundary', async () => {
  for (const protectedPath of addedProtectedPaths) {
    const data = fixture();
    const fake = fakeApi({
      run: data.run,
      workflowFiles: {
        [`${protectedPath}@${mergeBaseSha}`]: 'trusted-at-fork-point',
        [`${protectedPath}@${data.run.head_sha}`]: 'modified-at-run-head',
      },
    });
    assert.deepEqual(
      await inspectReviewWake({ payload: data.payload, repository, api: fake.api }),
      { reason: 'protected-workflow-modified' },
      protectedPath,
    );
  }
});

test('rejects ABA changes from immutable run-head evidence without reading mutable PR files', async () => {
  const data = fixture();
  const fake = fakeApi({
    run: data.run,
    workflowFiles: {
      [`.github/workflows/ci-recovery.yml@${mergeBaseSha}`]: 'trusted-at-fork-point',
      [`.github/workflows/ci-recovery.yml@${data.run.head_sha}`]: 'modified-at-run-head',
    },
  });
  fake.api.listPullFiles = async () => {
    throw new Error('mutable PR file evidence must never be consulted');
  };

  assert.deepEqual(await inspectReviewWake({ payload: data.payload, repository, api: fake.api }), {
    reason: 'protected-workflow-modified',
  });
  assert.deepEqual(fake.calls, [
    ['getRun', 123],
    ['compareCommits', 'main', data.run.head_sha],
  ]);
});

test('accepts a stale branch that predates a protected workflow addition', async () => {
  for (const protectedPath of addedProtectedPaths) {
    const data = fixture();
    const fake = fakeApi({
      run: data.run,
      pulls: { 42: data.pullRequest },
      workflowFiles: {
        [`${protectedPath}@${mergeBaseSha}`]: null,
        [`${protectedPath}@${data.run.head_sha}`]: null,
      },
    });

    const result = await inspectReviewWake({ payload: data.payload, repository, api: fake.api });
    assert.equal(result.prNumber, 42, protectedPath);
    assert.equal(
      fake.workflowCalls.some(([, ref]) => ref === 'main'),
      false,
      'protected blobs must never be compared to the mutable default-branch tip',
    );
  }
});

test('fails closed when GitHub does not provide an immutable merge base', async () => {
  const data = fixture();
  const fake = fakeApi({
    run: data.run,
    comparison: { merge_base_commit: null },
  });

  assert.deepEqual(await inspectReviewWake({ payload: data.payload, repository, api: fake.api }), {
    reason: 'missing-merge-base',
  });
  assert.deepEqual(fake.calls, [
    ['getRun', 123],
    ['compareCommits', 'main', data.run.head_sha],
  ]);
  assert.deepEqual(fake.workflowCalls, []);
});

for (const [name, mutate, expected] of [
  ['closed PR', (pullRequest) => (pullRequest.state = 'closed'), 'not-open'],
  ['draft PR', (pullRequest) => (pullRequest.draft = true), 'pr-drafted'],
  ['non-default base', (pullRequest) => (pullRequest.base.ref = 'release'), 'wrong-base'],
  [
    'different base repository',
    (pullRequest) => (pullRequest.base.repo.full_name = 'attacker/Crawler'),
    'base-repository',
  ],
  ['stale head SHA', (pullRequest) => (pullRequest.head.sha = 'b'.repeat(40)), 'head-sha-mismatch'],
  [
    'case-variant base ref (Main vs main)',
    (pullRequest) => (pullRequest.base.ref = 'Main'),
    'wrong-base',
  ],
  [
    'case-variant head ref (Feature-Branch vs feature-branch)',
    (pullRequest) => (pullRequest.head.ref = 'Feature-Branch'),
    'head-branch-mismatch',
  ],
]) {
  test(`rejects ${name} metadata before dispatch`, async () => {
    const data = fixture();
    mutate(data.pullRequest);
    const fake = fakeApi({
      run: data.run,
      pulls: { 42: data.pullRequest },
    });
    assert.deepEqual(
      await inspectReviewWake({ payload: data.payload, repository, api: fake.api }),
      { reason: expected },
    );
    assert.deepEqual(fake.calls, [
      ['getRun', 123],
      ['compareCommits', 'main', data.run.head_sha],
      ['listReviewEvidence', 42, 'pull_request_review_comment', evidenceSince],
      ['getPull', 42],
    ]);
  });
}
