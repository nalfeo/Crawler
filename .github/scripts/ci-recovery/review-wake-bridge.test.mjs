import assert from 'node:assert/strict';
import test from 'node:test';

import { inspectReviewWake } from './review-wake-bridge.mjs';

const repository = 'nalfeo/Crawler';
const trustedActor = { id: 175728472, login: 'Copilot', type: 'Bot' };

function fixture() {
  const pullRequest = {
    number: 42,
    state: 'open',
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
      display_title: 'CI Recovery Router: review-wake pr-42',
      path: '.github/workflows/ci-recovery-router.yml',
      status: 'completed',
      conclusion: 'action_required',
      event: 'pull_request_review_comment',
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

function fakeApi({ run, pulls = {}, workflowFiles = {} }) {
  const calls = [];
  const workflowCalls = [];
  return {
    calls,
    workflowCalls,
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
      async getPull(number) {
        calls.push(['getPull', number]);
        return pulls[number];
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
    ['getPull', 42],
  ]);
  assert.equal(fake.workflowCalls.length, 6);
  for (const path of [
    '.github/workflows/ci-recovery-router.yml',
    '.github/workflows/ci-recovery-review-wake-bridge.yml',
    '.github/workflows/ci-recovery.yml',
  ]) {
    assert.deepEqual(
      fake.workflowCalls.filter(([candidate]) => candidate === path),
      [
        [path, 'a'.repeat(40)],
        [path, 'main'],
      ],
    );
  }
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

test('fails closed before source-PR selection when the run used a modified router workflow', async () => {
  const data = fixture();
  const fake = fakeApi({
    run: data.run,
    workflowFiles: {
      [data.run.head_sha]: 'modified-router-blob',
      main: 'trusted-router-blob',
    },
  });

  assert.deepEqual(await inspectReviewWake({ payload: data.payload, repository, api: fake.api }), {
    reason: 'router-workflow-untrusted',
  });
  assert.deepEqual(fake.calls, [['getRun', 123]]);
  assert.deepEqual(fake.workflowCalls, [
    ['.github/workflows/ci-recovery-router.yml', data.run.head_sha],
    ['.github/workflows/ci-recovery-router.yml', 'main'],
    ['.github/workflows/ci-recovery-review-wake-bridge.yml', data.run.head_sha],
    ['.github/workflows/ci-recovery-review-wake-bridge.yml', 'main'],
    ['.github/workflows/ci-recovery.yml', data.run.head_sha],
    ['.github/workflows/ci-recovery.yml', 'main'],
  ]);
});

test('selects the run-name source PR even when extra PRs are associated', async () => {
  const data = fixture();
  // GitHub associates two open PRs at the run head, but the trusted run-name
  // binds recovery to exactly PR #42. #43 must never be fetched.
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
    ['getPull', 42],
  ]);
});

test('does not substitute an unrelated associated PR when the source PR head moved', async () => {
  const data = fixture();
  // The reviewed source PR (#42) advanced its head after the run, so it no
  // longer matches run.head_sha. An unrelated PR (#43) happens to sit at
  // run.head_sha. The bridge must evaluate ONLY the run-name-bound #42, fail
  // closed on its head mismatch, and never consider #43.
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
    ['getPull', 42],
  ]);
});

test('fails closed when the run-name binding is missing', async () => {
  const data = fixture();
  delete data.run.display_title;
  const fake = fakeApi({ run: data.run });

  assert.deepEqual(await inspectReviewWake({ payload: data.payload, repository, api: fake.api }), {
    reason: 'missing-source-pr-binding',
  });
  assert.deepEqual(fake.calls, [['getRun', 123]]);
});

test('fails closed when the run-name PR is not in the association', async () => {
  const data = fixture();
  data.run.pull_requests = [{ number: 43 }];
  const fake = fakeApi({ run: data.run, pulls: { 43: { ...data.pullRequest, number: 43 } } });

  assert.deepEqual(await inspectReviewWake({ payload: data.payload, repository, api: fake.api }), {
    reason: 'source-pr-not-associated',
  });
  // Disagreement is detected from the association set alone — no PR fetch.
  assert.deepEqual(fake.calls, [['getRun', 123]]);
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
        [`${path}@${data.run.head_sha}`]: runBlob,
        [`${path}@main`]: 'trusted-workflow-blob',
      },
    });
    assert.deepEqual(
      await inspectReviewWake({ payload: data.payload, repository, api: fake.api }),
      { reason: 'protected-workflow-modified' },
    );
  }
});

test('rejects ABA changes from immutable run-head evidence without reading mutable PR files', async () => {
  const data = fixture();
  const fake = fakeApi({
    run: data.run,
    workflowFiles: {
      [`.github/workflows/ci-recovery.yml@${data.run.head_sha}`]: 'modified-at-run-head',
      [`.github/workflows/ci-recovery.yml@main`]: 'trusted-on-default',
    },
  });
  fake.api.listPullFiles = async () => {
    throw new Error('mutable PR file evidence must never be consulted');
  };

  assert.deepEqual(await inspectReviewWake({ payload: data.payload, repository, api: fake.api }), {
    reason: 'protected-workflow-modified',
  });
  assert.deepEqual(fake.calls, [['getRun', 123]]);
});

for (const [name, mutate, expected] of [
  ['closed PR', (pullRequest) => (pullRequest.state = 'closed'), 'not-open'],
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
      ['getPull', 42],
    ]);
  });
}
