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
    head: { sha: 'a'.repeat(40), repo: { full_name: repository } },
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
      path: '.github/workflows/ci-recovery-router.yml',
      status: 'completed',
      conclusion: 'action_required',
      event: 'pull_request_review_comment',
      head_sha: 'a'.repeat(40),
      repository: { full_name: repository },
      head_repository: { full_name: repository },
      actor: trustedActor,
      triggering_actor: trustedActor,
      pull_requests: [{ number: 42 }],
    },
    pullRequest,
    changedFiles: [{ filename: 'src/example.ts' }],
  };
}

function fakeApi({ run, pulls = {}, files = {} }) {
  const calls = [];
  return {
    calls,
    api: {
      async getRun(id) {
        calls.push(['getRun', id]);
        return run;
      },
      async getPull(number) {
        calls.push(['getPull', number]);
        return pulls[number];
      },
      async listPullFiles(number) {
        calls.push(['listPullFiles', number]);
        return files[number] || [];
      },
    },
  };
}

test('accepts one parked trusted Copilot review wake for one exact PR', async () => {
  const data = fixture();
  const fake = fakeApi({
    run: data.run,
    pulls: { 42: data.pullRequest },
    files: { 42: data.changedFiles },
  });

  assert.deepEqual(await inspectReviewWake({ payload: data.payload, repository, api: fake.api }), {
    prNumber: 42,
    trigger: 'trusted-review-wake:pull_request_review_comment:run-123',
    headSha: 'a'.repeat(40),
  });
  assert.deepEqual(fake.calls, [
    ['getRun', 123],
    ['getPull', 42],
    ['listPullFiles', 42],
  ]);
});

test('binds the accepted wake to the validated run head SHA (lowercased)', async () => {
  const data = fixture();
  const upper = 'A'.repeat(40);
  data.run.head_sha = upper;
  data.pullRequest.head.sha = upper;
  const fake = fakeApi({
    run: data.run,
    pulls: { 42: data.pullRequest },
    files: { 42: data.changedFiles },
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

test('fails closed when two PR associations remain eligible', async () => {
  const data = fixture();
  data.run.pull_requests = [{ number: 42 }, { number: 43 }];
  const second = { ...data.pullRequest, number: 43 };
  const fake = fakeApi({
    run: data.run,
    pulls: { 42: data.pullRequest, 43: second },
    files: { 42: data.changedFiles, 43: data.changedFiles },
  });

  assert.deepEqual(await inspectReviewWake({ payload: data.payload, repository, api: fake.api }), {
    reason: 'eligible-pr-count=2',
  });
});

for (const [name, mutate, expected] of [
  ['normal success', (run) => (run.conclusion = 'success'), 'conclusion=success'],
  ['non-review event', (run) => (run.event = 'pull_request_target'), 'event=pull_request_target'],
  ['different workflow', (run) => (run.path = '.github/workflows/ci.yml'), 'workflow-path'],
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

test('rejects a same-repository PR that modifies or renames a protected workflow', async () => {
  for (const changedFile of [
    { filename: '.github/workflows/ci-recovery.yml' },
    {
      filename: '.github/workflows/router-v2.yml',
      previous_filename: '.github/workflows/ci-recovery-router.yml',
    },
  ]) {
    const data = fixture();
    const fake = fakeApi({
      run: data.run,
      pulls: { 42: data.pullRequest },
      files: { 42: [changedFile] },
    });
    assert.deepEqual(
      await inspectReviewWake({ payload: data.payload, repository, api: fake.api }),
      { reason: 'eligible-pr-count=0' },
    );
  }
});

test('rejects incomplete changed-file evidence', async () => {
  const data = fixture();
  data.pullRequest.changed_files = 2;
  const fake = fakeApi({
    run: data.run,
    pulls: { 42: data.pullRequest },
    files: { 42: data.changedFiles },
  });
  assert.deepEqual(await inspectReviewWake({ payload: data.payload, repository, api: fake.api }), {
    reason: 'eligible-pr-count=0',
  });
});

for (const [name, mutate] of [
  ['closed PR', (pullRequest) => (pullRequest.state = 'closed')],
  ['non-default base', (pullRequest) => (pullRequest.base.ref = 'release')],
  [
    'different base repository',
    (pullRequest) => (pullRequest.base.repo.full_name = 'attacker/Crawler'),
  ],
  ['stale head SHA', (pullRequest) => (pullRequest.head.sha = 'b'.repeat(40))],
]) {
  test(`rejects ${name} metadata before reading changed files`, async () => {
    const data = fixture();
    mutate(data.pullRequest);
    const fake = fakeApi({
      run: data.run,
      pulls: { 42: data.pullRequest },
    });
    assert.deepEqual(
      await inspectReviewWake({ payload: data.payload, repository, api: fake.api }),
      { reason: 'eligible-pr-count=0' },
    );
    assert.deepEqual(fake.calls, [
      ['getRun', 123],
      ['getPull', 42],
    ]);
  });
}
