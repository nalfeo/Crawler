import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parse } from 'yaml';

import {
  collectPrNumbers,
  computeBackoffDelayMs,
  computeDispatchBudget,
  countOutstandingRecoveryRuns,
  countOutstandingWorkflowRuns,
  eventPrNumbers,
  GLOBAL_IDLE_TRAIN_DISPATCH_CAP,
  GLOBAL_TRAIN_DISPATCH_CAP,
  hasHealthyOwnerForSweep,
  hydrateRecoveryOwnership,
  isRepairWindowSweepEvent,
  isRetryableError,
  listRecentOutstandingRunIds,
  MAX_DISPATCH_BUDGET_TRAIN_BUSY,
  MAX_DISPATCH_BUDGET_TRAIN_IDLE,
  partitionDispatchable,
  recoveryStateFromComments,
  requestWithBackoff,
  recoveryTriggerForPr,
  RUNNER_CEILING,
  SWEEP_RUNNER_WEIGHT,
  VALIDATION_RESERVED_TRAIN_BUSY,
  VALIDATION_RESERVED_TRAIN_IDLE,
  VALIDATION_RUNNER_WEIGHT,
  isManagedCommentEvent,
  waitForDispatchedRunsVisible,
  waitForOutstandingCount,
} from './router.mjs';
import {
  automationProgressKey,
  blockerFingerprint,
  makeState,
  renderStateComment,
} from './state.mjs';

const workflowPath = new URL('../../workflows/ci-recovery-router.yml', import.meta.url);
const workflow = parse(await readFile(workflowPath, 'utf8'));
const routeJob = workflow.jobs.route;

function makeError(status, message, headerMap = {}) {
  const error = new Error(message);
  error.status = status;
  error.data = { message };
  error.headers = {
    get(name) {
      return headerMap[String(name).toLowerCase()] ?? null;
    },
  };
  return error;
}

function automationOwnerState(prNumber, updatedAt, attempt = 1) {
  const fingerprint = blockerFingerprint([{ kind: 'ci-failure', id: 'ci', summary: 'CI failed' }]);
  return makeState({
    prNumber,
    headSha: `head-${prNumber}`,
    fingerprint,
    owner: 'automation',
    status: 'dispatched',
    blockers: [{ kind: 'ci-failure', id: 'ci', summary: 'CI failed' }],
    attempt,
    progressKey: automationProgressKey(`head-${prNumber}`, fingerprint),
    progressAt: updatedAt,
    updatedAt,
  });
}

test('collectPrNumbers applies dispatch cap for schedule sweeps', () => {
  const scheduledPulls = Array.from({ length: 12 }, (_, index) => ({
    number: index + 1,
    draft: false,
    head: { repo: { full_name: 'nalfeo/Crawler' } },
  }));

  const numbers = collectPrNumbers({
    payload: { repository: { default_branch: 'main' } },
    eventName: 'schedule',
    repository: 'nalfeo/Crawler',
    scheduledPulls,
    maxDispatchPerRun: 5,
    now: new Date('1970-01-01T00:00:00Z'),
  });

  assert.deepEqual(numbers, [1, 2, 3, 4, 5]);
});

test('flag-off schedule sweeps prioritize PRs with train-owned labels before dispatch cap', () => {
  const scheduledPulls = [
    ...Array.from({ length: 8 }, (_, index) => ({
      number: index + 1,
      draft: false,
      labels: [],
      head: { repo: { full_name: 'nalfeo/Crawler' } },
    })),
    {
      number: 99,
      draft: false,
      labels: [{ name: 'merge-train-blocked' }],
      head: { repo: { full_name: 'nalfeo/Crawler' } },
    },
  ];
  const numbers = collectPrNumbers({
    payload: { repository: { default_branch: 'main' } },
    eventName: 'schedule',
    repository: 'nalfeo/Crawler',
    scheduledPulls,
    maxDispatchPerRun: 8,
    trainEnabled: false,
    now: new Date('1970-01-01T00:00:00Z'),
  });

  assert.deepEqual(numbers, [99, 1, 2, 3, 4, 5, 6, 7]);
});

test('collectPrNumbers keeps event-scoped PR dispatch uncapped for non-schedule events', () => {
  const numbers = collectPrNumbers({
    payload: { pull_request: { number: 42 } },
    eventName: 'pull_request_target',
    repository: 'nalfeo/Crawler',
    scheduledPulls: [],
    maxDispatchPerRun: 1,
  });

  assert.deepEqual(numbers, [42]);
});

test('collectPrNumbers prioritizes flag-off PRs still carrying a train-owned label over the cap', () => {
  // 10 PRs, most-recently-updated first (as returned by sort=updated&direction=desc).
  // #9 and #2 are old (near the back) but still carry stale train labels from
  // before MERGE_TRAIN_ENABLED=false; they must not be starved by newer,
  // unrelated PRs #10..#3 filling the whole 5-PR cap.
  const scheduledPulls = [
    { number: 10, draft: false, head: { repo: { full_name: 'nalfeo/Crawler' } }, labels: [] },
    {
      number: 9,
      draft: false,
      head: { repo: { full_name: 'nalfeo/Crawler' } },
      labels: [{ name: 'merge-train-blocked' }],
    },
    { number: 8, draft: false, head: { repo: { full_name: 'nalfeo/Crawler' } }, labels: [] },
    { number: 7, draft: false, head: { repo: { full_name: 'nalfeo/Crawler' } }, labels: [] },
    { number: 6, draft: false, head: { repo: { full_name: 'nalfeo/Crawler' } }, labels: [] },
    { number: 5, draft: false, head: { repo: { full_name: 'nalfeo/Crawler' } }, labels: [] },
    { number: 4, draft: false, head: { repo: { full_name: 'nalfeo/Crawler' } }, labels: [] },
    { number: 3, draft: false, head: { repo: { full_name: 'nalfeo/Crawler' } }, labels: [] },
    {
      number: 2,
      draft: false,
      head: { repo: { full_name: 'nalfeo/Crawler' } },
      labels: [{ name: 'merge-train' }],
    },
    { number: 1, draft: false, head: { repo: { full_name: 'nalfeo/Crawler' } }, labels: [] },
  ];

  const numbers = collectPrNumbers({
    payload: {},
    eventName: 'schedule',
    repository: 'nalfeo/Crawler',
    scheduledPulls,
    maxDispatchPerRun: 5,
    now: new Date('1970-01-01T00:00:00Z'),
  });

  assert.deepEqual(
    new Set(numbers),
    new Set([9, 2, 10, 8, 7]),
    'train-labeled PRs #9 and #2 must be dispatched even though they sort behind the cap on updated-desc order',
  );
  assert.equal(numbers.length, 5);
});

test('collectPrNumbers keeps directly-triggered PRs ahead of the cap alongside train-labeled PRs', () => {
  const scheduledPulls = Array.from({ length: 9 }, (_, index) => ({
    number: index + 1,
    draft: false,
    head: { repo: { full_name: 'nalfeo/Crawler' } },
    labels: index + 1 === 1 ? [{ name: 'merge-train-noop' }] : [],
  }));

  const numbers = collectPrNumbers({
    payload: { issue: { number: 9, pull_request: {} } },
    eventName: 'workflow_dispatch',
    repository: 'nalfeo/Crawler',
    scheduledPulls,
    maxDispatchPerRun: 3,
  });

  assert.equal(numbers.length, 3);
  assert.ok(numbers.includes(9), 'the directly-triggered PR must survive the cap');
  assert.ok(numbers.includes(1), 'the train-labeled PR must survive the cap');
});

test('flag-off sweeps rotate unowned PRs so later entries are eventually dispatchable', () => {
  const scheduledPulls = Array.from({ length: 5 }, (_, index) => ({
    number: 5 - index,
    draft: false,
    labels: [],
    head: { repo: { full_name: 'nalfeo/Crawler' } },
  }));
  const seen = new Set();

  for (let sweep = 0; sweep < 5; sweep += 1) {
    const ordered = collectPrNumbers({
      payload: { repository: { default_branch: 'main' } },
      eventName: 'schedule',
      repository: 'nalfeo/Crawler',
      scheduledPulls,
      maxDispatchPerRun: 8,
      trainEnabled: false,
      now: new Date(`2026-07-21T${String(sweep).padStart(2, '0')}:00:00Z`),
    });
    const { dispatchable } = partitionDispatchable(ordered, 2);
    for (const prNumber of dispatchable) {
      seen.add(prNumber);
    }
  }

  assert.deepEqual(seen, new Set([1, 2, 3, 4, 5]));
});

test('flag-off sweeps keep owned PRs behind unowned PRs before the global budget slice', () => {
  const scheduledPulls = [
    {
      number: 5,
      draft: false,
      labels: [],
      head: { repo: { full_name: 'nalfeo/Crawler' } },
    },
    {
      number: 4,
      draft: false,
      labels: [{ name: 'ci-owner-pr-4' }],
      head: { repo: { full_name: 'nalfeo/Crawler' } },
    },
    {
      number: 3,
      draft: false,
      labels: [],
      head: { repo: { full_name: 'nalfeo/Crawler' } },
    },
    {
      number: 2,
      draft: false,
      labels: [{ name: 'ci-owner-pr-2' }],
      head: { repo: { full_name: 'nalfeo/Crawler' } },
    },
    {
      number: 1,
      draft: false,
      labels: [],
      head: { repo: { full_name: 'nalfeo/Crawler' } },
    },
  ];

  const ordered = collectPrNumbers({
    payload: { repository: { default_branch: 'main' } },
    eventName: 'schedule',
    repository: 'nalfeo/Crawler',
    scheduledPulls,
    maxDispatchPerRun: 8,
    trainEnabled: false,
    now: new Date('2026-07-21T00:00:00Z'),
  });

  const { dispatchable } = partitionDispatchable(ordered, 2);
  assert.deepEqual(dispatchable, [5, 3]);
});

test('train mode routes PR-scoped events only to their directly affected PR', () => {
  const pulls = Array.from({ length: 9 }, (_, index) => ({
    number: index + 1,
    state: 'open',
    draft: false,
    created_at: `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
    base: { ref: 'main' },
    head: { repo: { full_name: 'nalfeo/Crawler' } },
    labels: [],
  }));
  pulls[0].labels = [{ name: 'merge-train' }];
  pulls[2].labels = [{ name: 'ci-owner-pr-3' }];
  assert.deepEqual(
    collectPrNumbers({
      payload: { pull_request: { number: 3 } },
      eventName: 'pull_request_target',
      repository: 'nalfeo/Crawler',
      scheduledPulls: pulls,
      trainEnabled: true,
    }),
    [3],
  );
});

test('train mode keeps directly triggered opt-out PRs in scope for cleanup', () => {
  const pulls = [
    {
      number: 42,
      state: 'open',
      draft: false,
      created_at: '2026-07-01T00:00:00Z',
      base: { ref: 'main' },
      head: { repo: { full_name: 'nalfeo/Crawler' } },
      labels: [{ name: 'ci-recovery-opt-out' }],
    },
    {
      number: 43,
      state: 'open',
      draft: false,
      created_at: '2026-07-02T00:00:00Z',
      base: { ref: 'main' },
      head: { repo: { full_name: 'nalfeo/Crawler' } },
      labels: [{ name: 'ci-recovery-opt-out' }],
    },
  ];

  assert.deepEqual(
    collectPrNumbers({
      payload: { issue: { number: 42, pull_request: {} } },
      eventName: 'issue_comment',
      repository: 'nalfeo/Crawler',
      scheduledPulls: pulls,
      trainEnabled: true,
    }),
    [42],
  );
});

test('train schedule rechecks owned slots for expiry without widening the window', () => {
  const pulls = Array.from({ length: 7 }, (_, index) => ({
    number: index + 1,
    state: 'open',
    draft: false,
    created_at: `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
    base: { ref: 'main' },
    head: { repo: { full_name: 'nalfeo/Crawler' } },
    labels: [{ name: `ci-owner-pr-${index + 1}` }],
  }));
  assert.deepEqual(
    collectPrNumbers({
      payload: {},
      eventName: 'schedule',
      repository: 'nalfeo/Crawler',
      scheduledPulls: pulls,
      trainEnabled: true,
    }),
    [1, 2, 3, 4, 5, 6],
  );
});

test('train sweeps skip genuine waiting PRs while exact direct events preserve them', () => {
  const pulls = Array.from({ length: 9 }, (_, index) => ({
    number: index + 1,
    state: 'open',
    draft: false,
    created_at: `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
    base: { ref: 'main' },
    head: { repo: { full_name: 'nalfeo/Crawler' } },
    labels: index + 1 === 9 ? [{ name: 'ci-recovery-waiting' }] : [],
  }));

  assert.deepEqual(
    collectPrNumbers({
      payload: {},
      eventName: 'schedule',
      repository: 'nalfeo/Crawler',
      scheduledPulls: pulls,
      trainEnabled: true,
    }),
    [1, 2, 3, 4, 5, 6],
  );

  assert.deepEqual(
    collectPrNumbers({
      payload: { pull_request: { number: 9 } },
      eventName: 'pull_request_target',
      repository: 'nalfeo/Crawler',
      scheduledPulls: pulls,
      trainEnabled: true,
    }),
    [9],
  );
});

test('train undirected sweeps select at most the six oldest eligible PRs', () => {
  const pulls = Array.from({ length: 9 }, (_, index) => ({
    number: 9 - index,
    state: 'open',
    draft: false,
    created_at: `2026-07-${String(9 - index).padStart(2, '0')}T00:00:00Z`,
    base: { ref: 'main' },
    head: { repo: { full_name: 'nalfeo/Crawler' } },
    labels: [],
  }));

  assert.deepEqual(
    collectPrNumbers({
      payload: {},
      eventName: 'schedule',
      repository: 'nalfeo/Crawler',
      scheduledPulls: pulls,
      trainEnabled: true,
    }),
    [1, 2, 3, 4, 5, 6],
  );
});

test('train PR-less default-branch CI sweeps preserve owner slots without redispatching them', () => {
  const pulls = Array.from({ length: 7 }, (_, index) => ({
    number: index + 1,
    state: 'open',
    draft: false,
    created_at: `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
    base: { ref: 'main' },
    head: { repo: { full_name: 'nalfeo/Crawler' } },
    labels: index === 0 ? [{ name: 'ci-owner-pr-1' }] : [],
    recoveryState: index === 0 ? automationOwnerState(1, '2026-07-17T12:00:00.000Z') : undefined,
  }));

  assert.deepEqual(
    collectPrNumbers({
      payload: {
        repository: { default_branch: 'main' },
        workflow_run: { name: 'CI', head_branch: 'main', pull_requests: [] },
      },
      eventName: 'workflow_run',
      repository: 'nalfeo/Crawler',
      scheduledPulls: pulls,
      trainEnabled: true,
      now: new Date('2026-07-17T12:10:00.000Z'),
    }),
    [2, 3, 4, 5, 6, 7],
  );
});

test('train sweeps over-select past healthy owners to the next dispatchable PR', () => {
  const pulls = Array.from({ length: 7 }, (_, index) => {
    const number = index + 1;
    return {
      number,
      state: 'open',
      draft: false,
      created_at: `2026-07-${String(number).padStart(2, '0')}T00:00:00Z`,
      base: { ref: 'main' },
      head: { repo: { full_name: 'nalfeo/Crawler' } },
      labels: number <= 6 ? [{ name: `ci-owner-pr-${number}` }] : [],
      recoveryState:
        number <= 6 ? automationOwnerState(number, '2026-07-17T12:00:00.000Z') : undefined,
    };
  });

  assert.deepEqual(
    collectPrNumbers({
      payload: {},
      eventName: 'schedule',
      repository: 'nalfeo/Crawler',
      scheduledPulls: pulls,
      trainEnabled: true,
      now: new Date('2026-07-17T12:10:00.000Z'),
    }),
    [7],
  );
});

test('direct events retain a healthy owner while broad sweeps include stale and inconsistent owners', () => {
  const healthy = {
    number: 1,
    state: 'open',
    draft: false,
    created_at: '2026-07-01T00:00:00Z',
    base: { ref: 'main' },
    head: { repo: { full_name: 'nalfeo/Crawler' } },
    labels: [{ name: 'ci-owner-pr-1' }],
    recoveryState: automationOwnerState(1, '2026-07-17T12:00:00.000Z'),
  };
  const stale = {
    ...healthy,
    number: 2,
    created_at: '2026-07-02T00:00:00Z',
    labels: [{ name: 'ci-owner-pr-2' }],
    recoveryState: automationOwnerState(2, '2026-07-17T11:00:00.000Z'),
  };
  const inconsistent = {
    ...healthy,
    number: 3,
    created_at: '2026-07-03T00:00:00Z',
    labels: [{ name: 'ci-owner-pr-3' }],
    recoveryState: null,
  };

  assert.deepEqual(
    collectPrNumbers({
      payload: {},
      eventName: 'schedule',
      repository: 'nalfeo/Crawler',
      scheduledPulls: [healthy, stale, inconsistent],
      trainEnabled: true,
      now: new Date('2026-07-17T12:10:00.000Z'),
    }),
    [2, 3],
  );
  assert.deepEqual(
    collectPrNumbers({
      payload: { pull_request: { number: 1 } },
      eventName: 'pull_request_target',
      repository: 'nalfeo/Crawler',
      scheduledPulls: [healthy, stale, inconsistent],
      trainEnabled: true,
      now: new Date('2026-07-17T12:10:00.000Z'),
    }),
    [1],
  );
});

test('owner-state hydration is bounded and malformed state remains sweep-visible', async () => {
  const pulls = Array.from({ length: 8 }, (_, index) => ({
    number: index + 1,
    labels: [{ name: `ci-owner-pr-${index + 1}` }],
  }));
  let active = 0;
  let maxActive = 0;
  const hydrated = await hydrateRecoveryOwnership(pulls, async (number) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
    if (number === 8) return [{ body: '<!-- crawler-ci-state:v1 --> broken' }];
    return [{ body: renderStateComment(automationOwnerState(number, '2026-07-17T12:00:00Z')) }];
  });

  assert.equal(maxActive, 6);
  assert.equal(hasHealthyOwnerForSweep(hydrated[0], new Date('2026-07-17T12:10:00Z')), true);
  assert.equal(recoveryStateFromComments([{ body: 'not managed' }]), null);
  assert.equal(hasHealthyOwnerForSweep(hydrated[7], new Date('2026-07-17T12:10:00Z')), false);
});

test('incremental hydration continues past healthy owners and stops at six resolved sweep candidates', async () => {
  const pulls = Array.from({ length: 18 }, (_, index) => ({
    number: index + 1,
    created_at: `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
    labels: [{ name: `ci-owner-pr-${index + 1}` }],
  }));
  const loadedNumbers = [];
  const hydrated = await hydrateRecoveryOwnership(
    pulls,
    async (number) => {
      loadedNumbers.push(number);
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (number <= 6) {
        return [
          {
            body: renderStateComment(automationOwnerState(number, '2026-07-17T12:00:00.000Z')),
          },
        ];
      }
      return [{ body: '<!-- crawler-ci-state:v1 --> malformed' }];
    },
    6,
    {
      targetDispatchable: 6,
      countDispatchable: (resolvedPulls) =>
        resolvedPulls.filter((pr) => !hasHealthyOwnerForSweep(pr, new Date('2026-07-17T12:10:00Z')))
          .length,
    },
  );

  assert.equal(
    loadedNumbers.length,
    12,
    'must scan past the healthy first batch and stop after six unhealthy owners',
  );
  assert.equal(hydrated.length, 18);
  assert.equal(hydrated[11].recoveryState, null);
  assert.equal(hydrated[12].recoveryState, undefined, 'younger owners must remain unhydrated');
});

test('incremental hydration skips younger owners when six older unowned PRs fill the window', async () => {
  const pulls = Array.from({ length: 12 }, (_, index) => ({
    number: index + 1,
    created_at: `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
    labels: index < 6 ? [] : [{ name: `ci-owner-pr-${index + 1}` }],
  }));
  const loadedNumbers = [];
  const hydrated = await hydrateRecoveryOwnership(
    pulls,
    async (number) => {
      loadedNumbers.push(number);
      return [];
    },
    6,
    {
      targetDispatchable: 6,
      countDispatchable: (resolvedPulls) =>
        resolvedPulls.filter((pr) => !hasHealthyOwnerForSweep(pr, new Date('2026-07-17T12:10:00Z')))
          .length,
    },
  );

  assert.deepEqual(loadedNumbers, []);
  assert.equal(hydrated[6].recoveryState, undefined);
});

test('automation owner with a stale head SHA is unhealthy for sweeps even when progressAt is fresh', () => {
  // Regression for Thread 2: an automation state recorded against an older
  // head SHA must NOT be treated as healthy even if progressAt is recent.
  // Without this guard a push/rebase leaves the PR suppressed for up to 30
  // minutes because isHealthyRecoveryOwner only inspects progressAt, not headSha.
  const fingerprint = blockerFingerprint([{ kind: 'ci-failure', id: 'ci', summary: 'CI failed' }]);
  const stateForOldHead = makeState({
    prNumber: 1,
    headSha: 'old-head-sha',
    fingerprint,
    owner: 'automation',
    status: 'dispatched',
    blockers: [{ kind: 'ci-failure', id: 'ci', summary: 'CI failed' }],
    attempt: 1,
    progressKey: automationProgressKey('old-head-sha', fingerprint),
    progressAt: new Date('2026-07-17T12:00:00Z').toISOString(),
    updatedAt: new Date('2026-07-17T12:00:00Z').toISOString(),
  });
  const pullRequestWithNewHead = {
    number: 1,
    labels: [{ name: 'ci-owner-pr-1' }],
    head: { sha: 'new-head-sha' },
    recoveryState: stateForOldHead,
  };
  // 10 minutes after progressAt — fresh enough that the old code would return true
  const now = new Date('2026-07-17T12:10:00Z');

  assert.equal(
    hasHealthyOwnerForSweep(pullRequestWithNewHead, now),
    false,
    'stale-head automation owner must be swept immediately after a head advance',
  );

  // Matching head: should remain healthy (progressAt is fresh, head matches)
  const pullRequestWithMatchingHead = {
    ...pullRequestWithNewHead,
    head: { sha: 'old-head-sha' },
  };
  assert.equal(
    hasHealthyOwnerForSweep(pullRequestWithMatchingHead, now),
    true,
    'matching-head automation owner with a fresh progressAt must remain healthy',
  );
});

test('train direct routing preserves opt-out cleanup and same-repository trust', () => {
  const pulls = [
    {
      number: 42,
      state: 'open',
      draft: false,
      created_at: '2026-07-01T00:00:00Z',
      base: { ref: 'main' },
      head: { repo: { full_name: 'nalfeo/Crawler' } },
      labels: [{ name: 'ci-recovery-opt-out' }],
    },
    {
      number: 43,
      state: 'open',
      draft: false,
      created_at: '2026-07-02T00:00:00Z',
      base: { ref: 'main' },
      head: { repo: { full_name: 'fork/Crawler' } },
      labels: [],
    },
  ];

  assert.deepEqual(
    collectPrNumbers({
      payload: {
        workflow_run: { pull_requests: [{ number: 42 }, { number: 43 }] },
      },
      eventName: 'workflow_run',
      repository: 'nalfeo/Crawler',
      scheduledPulls: pulls,
      trainEnabled: true,
    }),
    [42],
  );
});

test('train direct routing reports no eligible PR when the affected PR is excluded', () => {
  assert.deepEqual(
    collectPrNumbers({
      payload: { pull_request: { number: 42 } },
      eventName: 'pull_request_target',
      repository: 'nalfeo/Crawler',
      scheduledPulls: [
        {
          number: 42,
          state: 'open',
          draft: true,
          created_at: '2026-07-01T00:00:00Z',
          base: { ref: 'main' },
          head: { repo: { full_name: 'nalfeo/Crawler' } },
          labels: [],
        },
      ],
      trainEnabled: true,
    }),
    [],
  );
});

test('repair-window sweeps are limited to explicit train fill and global CI events', () => {
  const globalCiPayload = {
    repository: { default_branch: 'main' },
    workflow_run: { name: 'CI', head_branch: 'main', pull_requests: [] },
  };
  assert.equal(
    isRepairWindowSweepEvent({
      payload: globalCiPayload,
      eventName: 'workflow_run',
      trainEnabled: true,
    }),
    true,
  );
  assert.equal(
    isRepairWindowSweepEvent({
      payload: {
        ...globalCiPayload,
        workflow_run: { ...globalCiPayload.workflow_run, head_branch: 'feature' },
      },
      eventName: 'workflow_run',
      trainEnabled: true,
    }),
    false,
  );
  assert.equal(
    isRepairWindowSweepEvent({
      payload: {
        ...globalCiPayload,
        workflow_run: { ...globalCiPayload.workflow_run, pull_requests: [{ number: 42 }] },
      },
      eventName: 'workflow_run',
      trainEnabled: true,
    }),
    false,
  );
  assert.equal(
    isRepairWindowSweepEvent({
      payload: { action: 'closed' },
      eventName: 'pull_request_target',
      trainEnabled: true,
    }),
    true,
  );
  assert.equal(
    isRepairWindowSweepEvent({
      payload: { action: 'closed' },
      eventName: 'pull_request_target',
      trainEnabled: false,
    }),
    false,
  );
});

test('interrupted waiting transitions remain sweep-visible without admitting genuine waits', () => {
  const interrupted = {
    number: 42,
    state: 'open',
    draft: false,
    created_at: '2026-07-01T00:00:00Z',
    base: { ref: 'main' },
    head: { repo: { full_name: 'nalfeo/Crawler' } },
    labels: [
      { name: 'ci-recovery-waiting' },
      { name: 'ci-recovery-waiting-transition' },
      { name: 'ci-owner-pr-42' },
    ],
  };
  const genuineWait = {
    ...interrupted,
    number: 43,
    labels: [{ name: 'ci-recovery-waiting' }],
  };

  for (const trainEnabled of [true, false]) {
    assert.deepEqual(
      collectPrNumbers({
        payload: {},
        eventName: 'schedule',
        repository: 'nalfeo/Crawler',
        scheduledPulls: [interrupted, genuineWait],
        trainEnabled,
      }),
      [42],
    );
  }

  assert.deepEqual(
    collectPrNumbers({
      payload: {
        repository: { default_branch: 'main' },
        workflow_run: { name: 'CI', head_branch: 'main', pull_requests: [] },
      },
      eventName: 'workflow_run',
      repository: 'nalfeo/Crawler',
      scheduledPulls: [interrupted, genuineWait],
      trainEnabled: true,
    }),
    [42],
  );
});

test('train sweeps retain waiting PRs that also carry dynamic ownership for cleanup retry', () => {
  const ownedWaiting = {
    number: 42,
    state: 'open',
    draft: false,
    created_at: '2026-07-01T00:00:00Z',
    base: { ref: 'main' },
    head: { repo: { full_name: 'nalfeo/Crawler' } },
    labels: [{ name: 'ci-recovery-waiting' }, { name: 'ci-owner-pr-42' }],
  };

  for (const trainEnabled of [true, false]) {
    assert.deepEqual(
      collectPrNumbers({
        payload: {},
        eventName: 'schedule',
        repository: 'nalfeo/Crawler',
        scheduledPulls: [ownedWaiting],
        trainEnabled,
      }),
      [42],
    );
  }
});

test('eventPrNumbers identifies only PRs represented by the triggering event', () => {
  assert.deepEqual([...eventPrNumbers({ pull_request: { number: 42 } })], [42]);
  assert.deepEqual(
    [
      ...eventPrNumbers({
        workflow_run: { pull_requests: [{ number: 3 }, { number: 5 }] },
      }),
    ],
    [3, 5],
  );
  assert.deepEqual([...eventPrNumbers({})], []);
});

test('train sweeps preserve synchronize only for the directly triggered PR', () => {
  const directlyTriggeredPrs = new Set([42]);
  assert.equal(
    recoveryTriggerForPr({
      trainEnabled: true,
      directlyTriggeredPrs,
      prNumber: 42,
      eventName: 'pull_request_target',
      dispatchTrigger: 'pull_request_target:synchronize',
    }),
    'pull_request_target:synchronize',
  );
  assert.equal(
    recoveryTriggerForPr({
      trainEnabled: true,
      directlyTriggeredPrs,
      prNumber: 41,
      eventName: 'pull_request_target',
      dispatchTrigger: 'pull_request_target:synchronize',
    }),
    'pull_request_target:sweep',
  );
});

test('managed recovery comments do not feed the recovery router', () => {
  for (const body of [
    '<!-- crawler-ci-state:v1 -->\nstate',
    '<!-- crawler-ci-task:v1 fingerprint=x -->\ntask',
    '<!-- crawler-merge-train:v1 -->\nstatus',
    '<!-- crawler-review-request:v1 head=x reason=ready -->',
    '<!-- crawler-review-conflict:v1 episode=x head=y base=z -->',
  ]) {
    assert.equal(isManagedCommentEvent({ comment: { body } }, 'issue_comment'), true);
  }
  assert.equal(
    isManagedCommentEvent(
      { comment: { body: '> <!-- crawler-ci-state:v1 -->\n✅ Addressed in abcdef0' } },
      'issue_comment',
    ),
    false,
  );
});

test('managed recovery comments are rejected by the workflow job guard', () => {
  assert.equal(typeof routeJob.if, 'string');
  for (const marker of [
    '<!-- crawler-ci-state:v1 -->',
    '<!-- crawler-ci-task:v1',
    '<!-- crawler-merge-train:v1 -->',
    '<!-- crawler-review-request:v1',
    '<!-- crawler-review-conflict:v1',
  ]) {
    assert.ok(
      routeJob.if.includes(`!startsWith(github.event.comment.body, '${marker}')`),
      `expected job guard for ${marker}`,
    );
  }
});

test('router listens only for completed CI workflow runs', () => {
  assert.deepEqual(workflow.on.workflow_run.types, ['completed']);
});

test('router concurrency serializes every event into one unconditional global group', () => {
  // queue: max is required so GitHub actually queues every event under the
  // shared group instead of its default "1 running + 1 pending, newest
  // replaces pending" behavior, which would silently drop router
  // invocations during a burst rather than serializing them. Both group
  // and queue are now static (not conditional on MERGE_TRAIN_ENABLED): an
  // earlier revision only unified the group in train mode, leaving the
  // legacy flag-off path on per-PR groups where truly concurrent
  // different-PR invocations could each read a stale outstanding-run count
  // before either dispatch became visible. A static, unconditional group
  // makes that race architecturally impossible in any mode.
  assert.equal(
    routeJob.concurrency.queue,
    'max',
    'queue must be an unconditional max, not gated on MERGE_TRAIN_ENABLED',
  );
  const group = routeJob.concurrency.group;
  assert.equal(
    group,
    'crawler-ci-recovery-router',
    'concurrency group must be a static, unconditional string -- not a per-PR/per-sweep/train-gated expression',
  );
});

test('router concurrency cancel-in-progress is unconditionally false', () => {
  // cancel-in-progress must never fire, in any mode, so every queued
  // router event eventually runs instead of being dropped or a stale one
  // cancelled; serialization (not cancellation) is what bounds
  // concurrency, and the scheduled sweep is the backstop for
  // deduplication instead of cancel-in-progress.
  assert.equal(
    routeJob.concurrency['cancel-in-progress'],
    false,
    'cancel-in-progress must be a static false, not a conditional expression',
  );
});

test('router concurrency never combines queue: max with a cancel-in-progress: true condition (GitHub rejects that combination)', () => {
  // GitHub Actions docs: "The combination of queue: max and
  // cancel-in-progress: true is not allowed and will result in a workflow
  // validation error." Both values are now static, so this is
  // structurally guaranteed rather than conditionally guaranteed.
  assert.equal(routeJob.concurrency['cancel-in-progress'], false);
  assert.equal(routeJob.concurrency.queue, 'max');
});

test('isRetryableError only retries relevant HTTP errors', () => {
  assert.equal(isRetryableError(makeError(429, 'Too Many Requests')), true);
  assert.equal(isRetryableError(makeError(502, 'Bad Gateway')), true);
  assert.equal(isRetryableError(makeError(403, 'API rate limit exceeded for user')), true);
  assert.equal(isRetryableError(makeError(403, 'Forbidden')), false);
  assert.equal(isRetryableError(makeError(404, 'Not Found')), false);
});

test('computeBackoffDelayMs honors Retry-After and caps delay', () => {
  const retryAfterError = makeError(429, 'Too Many Requests', { 'retry-after': '2' });
  assert.equal(computeBackoffDelayMs(retryAfterError, 1, 1000, 30000), 2000);

  const cappedRetryAfterError = makeError(429, 'Too Many Requests', { 'retry-after': '600' });
  assert.equal(computeBackoffDelayMs(cappedRetryAfterError, 1, 1000, 30000), 30000);
});

test('requestWithBackoff retries and eventually succeeds for retryable errors', async () => {
  let attempts = 0;
  const response = await requestWithBackoff(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw makeError(429, 'Too Many Requests', { 'retry-after': '0' });
      }
      return { ok: true, attempts };
    },
    {
      maxAttempts: 4,
      baseDelayMs: 1,
      maxDelayMs: 2,
      label: 'router-test',
    },
  );

  assert.equal(attempts, 3);
  assert.deepEqual(response, { ok: true, attempts: 3 });
});

test('requestWithBackoff stops immediately for non-retryable errors', async () => {
  let attempts = 0;
  await assert.rejects(
    requestWithBackoff(
      async () => {
        attempts += 1;
        throw makeError(404, 'Not Found');
      },
      { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 2 },
    ),
    /Not Found/,
  );
  assert.equal(attempts, 1);
});

test('computeDispatchBudget returns MAX_DISPATCH_BUDGET_TRAIN_IDLE when the train queue is empty, no sweeps, no validation', () => {
  assert.equal(GLOBAL_IDLE_TRAIN_DISPATCH_CAP, MAX_DISPATCH_BUDGET_TRAIN_IDLE);
  assert.equal(MAX_DISPATCH_BUDGET_TRAIN_IDLE, 8);
  // Baseline: no external pressure at all
  assert.equal(
    computeDispatchBudget({ trainQueueNonEmpty: false, outstandingCount: 0 }),
    MAX_DISPATCH_BUDGET_TRAIN_IDLE,
    'full idle budget when nothing is running',
  );
  // Contracting as outstanding recovery grows:
  assert.equal(
    computeDispatchBudget({ trainQueueNonEmpty: false, outstandingCount: 4 }),
    MAX_DISPATCH_BUDGET_TRAIN_IDLE,
    'still at max because headroom (20-3-0-4=13) exceeds max',
  );
  // Once outstanding is large enough, headroom clamps the budget below max:
  const largeOutstanding =
    RUNNER_CEILING - VALIDATION_RESERVED_TRAIN_IDLE - MAX_DISPATCH_BUDGET_TRAIN_IDLE + 1;
  assert.equal(
    computeDispatchBudget({ trainQueueNonEmpty: false, outstandingCount: largeOutstanding }),
    MAX_DISPATCH_BUDGET_TRAIN_IDLE - 1,
  );
  // Budget never goes negative when outstanding is very large:
  assert.equal(
    computeDispatchBudget({ trainQueueNonEmpty: false, outstandingCount: 25 }),
    0,
    'budget never goes negative when outstanding exceeds ceiling',
  );
});

test('computeDispatchBudget never returns Infinity -- idle cap is always finite, including when the merge-train feature is disabled', () => {
  // Regression: computeDispatchBudget must never open the budget to Infinity
  // (the old pre-backpressure behaviour). Train disabled/paused collapses to
  // trainQueueNonEmpty=false; this proves the same finite budget holds.
  const budget = computeDispatchBudget({ trainQueueNonEmpty: false, outstandingCount: 0 });
  assert.ok(
    Number.isFinite(budget),
    `budget must be finite but got ${budget}`,
  );
  assert.equal(budget, MAX_DISPATCH_BUDGET_TRAIN_IDLE);
  assert.equal(
    computeDispatchBudget({ trainQueueNonEmpty: false, outstandingCount: RUNNER_CEILING }),
    0,
  );
});

test('computeDispatchBudget returns MAX_DISPATCH_BUDGET_TRAIN_BUSY when train queue is non-empty, no sweeps, no validation', () => {
  assert.equal(GLOBAL_TRAIN_DISPATCH_CAP, MAX_DISPATCH_BUDGET_TRAIN_BUSY);
  assert.equal(MAX_DISPATCH_BUDGET_TRAIN_BUSY, 5);
  // Baseline: train is busy but no other pressure
  assert.equal(
    computeDispatchBudget({ trainQueueNonEmpty: true, outstandingCount: 0 }),
    MAX_DISPATCH_BUDGET_TRAIN_BUSY,
    'full busy budget when headroom (20-9-0-0=11) exceeds max (5)',
  );
  assert.equal(
    computeDispatchBudget({ trainQueueNonEmpty: true, outstandingCount: 6 }),
    MAX_DISPATCH_BUDGET_TRAIN_BUSY,
    'still at max because headroom (20-9-0-6=5) exactly equals max',
  );
  assert.equal(
    computeDispatchBudget({ trainQueueNonEmpty: true, outstandingCount: 7 }),
    4,
    'budget contracts once headroom (20-9-0-7=4) falls below max',
  );
  assert.equal(
    computeDispatchBudget({ trainQueueNonEmpty: true, outstandingCount: 25 }),
    0,
    'budget never goes negative when outstanding exceeds cap',
  );
});

test('partitionDispatchable sends everything when the budget is unbounded', () => {
  const prNumbers = [1, 2, 3, 4, 5];
  assert.deepEqual(partitionDispatchable(prNumbers, Infinity), {
    dispatchable: prNumbers,
    deferred: [],
  });
});

test('partitionDispatchable defers PRs beyond the computed budget', () => {
  const prNumbers = [10, 11, 12];
  assert.deepEqual(partitionDispatchable(prNumbers, 1), {
    dispatchable: [10],
    deferred: [11, 12],
  });
  assert.deepEqual(partitionDispatchable(prNumbers, 0), {
    dispatchable: [],
    deferred: [10, 11, 12],
  });
});

test('countOutstandingRecoveryRuns uses concurrent per-status total_count queries (O(statuses) requests)', async () => {
  // The implementation must NOT paginate all runs -- the live CI Recovery
  // workflow can accumulate tens of thousands of completed runs, and a full
  // pagination at 100 runs/request would exhaust the Actions token quota and
  // 10-minute job timeout. Instead it fires one concurrent request per status
  // using the `total_count` field in the response, keeping request count fixed
  // at O(len(statuses)).
  const queriedStatuses = [];
  const requestFn = async (_token, path) => {
    const url = new URL(path, 'http://example.test');
    const status = url.searchParams.get('status');
    queriedStatuses.push(status);
    const counts = { queued: 3, in_progress: 1, waiting: 2, requested: 0, pending: 1 };
    return { data: { total_count: counts[status] ?? 0, workflow_runs: [] } };
  };

  const total = await countOutstandingRecoveryRuns(
    'token',
    'nalfeo',
    'Crawler',
    'ci-recovery.yml',
    ['queued', 'in_progress', 'waiting', 'requested', 'pending'],
    requestFn,
  );

  assert.equal(total, 7, 'must sum total_count across all queried statuses');
  assert.deepEqual(
    new Set(queriedStatuses),
    new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']),
    'must query each outstanding status exactly once',
  );
  assert.ok(
    queriedStatuses.every((s) => s !== null),
    'each request must carry a status= filter',
  );
  // Exactly one request per status (no pagination):
  assert.equal(queriedStatuses.length, 5, 'must issue exactly one request per status');
});

test('countOutstandingRecoveryRuns counts pending runs by default', async () => {
  // Regression guard: pending is a documented Actions run status; omitting
  // it from the default status list would let a run in that state go
  // uncounted and silently widen the outstanding-run gap.
  const requestFn = async (_token, path) => {
    const url = new URL(path, 'http://example.test');
    const status = url.searchParams.get('status');
    return { data: { total_count: status === 'pending' ? 1 : 0, workflow_runs: [] } };
  };
  const total = await countOutstandingRecoveryRuns(
    'token',
    'nalfeo',
    'Crawler',
    'ci-recovery.yml',
    undefined,
    requestFn,
  );
  assert.equal(total, 1, 'default OUTSTANDING_RUN_STATUSES must include pending');
});

test('countOutstandingWorkflowRuns queries a custom workflow file with a subset of statuses', async () => {
  // Verifies the generic function works for any workflow file and accepts
  // an arbitrary status subset (e.g. in_progress-only for sweep pressure).
  const queriedPaths = [];
  const requestFn = async (_token, path) => {
    queriedPaths.push(path);
    const url = new URL(path, 'http://example.test');
    const status = url.searchParams.get('status');
    return { data: { total_count: status === 'in_progress' ? 7 : 0, workflow_runs: [] } };
  };

  const total = await countOutstandingWorkflowRuns(
    'token',
    'nalfeo',
    'Crawler',
    'ai-sweep.yml',
    ['in_progress'],
    requestFn,
  );

  assert.equal(total, 7, 'must return the total_count for the requested status');
  assert.equal(queriedPaths.length, 1, 'must issue exactly one request for one status');
  assert.ok(
    queriedPaths[0].includes('ai-sweep.yml'),
    'request path must include the requested workflow file',
  );
  assert.ok(
    queriedPaths[0].includes('status=in_progress'),
    'request path must include the requested status',
  );
});

// ── Load-aware budget tests ───────────────────────────────────────────────────

test('computeDispatchBudget: idle scenario -- no sweeps, no validation, queue empty -- returns full MAX_IDLE budget', () => {
  // When runners are fully idle (no sweeps, no validation, no outstanding
  // recovery), the budget should reach the idle max to drain the backlog fast.
  assert.equal(
    computeDispatchBudget({
      trainQueueNonEmpty: false,
      outstandingCount: 0,
      activeSweepJobs: 0,
      activeValidationJobs: 0,
    }),
    MAX_DISPATCH_BUDGET_TRAIN_IDLE,
    'idle scenario: full budget available',
  );
  // Still at max when outstanding is well below the headroom threshold:
  assert.equal(
    computeDispatchBudget({
      trainQueueNonEmpty: false,
      outstandingCount: 3,
      activeSweepJobs: 0,
      activeValidationJobs: 0,
    }),
    MAX_DISPATCH_BUDGET_TRAIN_IDLE,
    'still at max when headroom (20-3-0-3=14) exceeds MAX_IDLE (8)',
  );
});

test('computeDispatchBudget: train-busy scenario -- no sweeps, no validation -- returns MAX_BUSY budget', () => {
  // With an active train queue and no sweep or validation pressure, budget
  // reaches MAX_BUSY (5) -- a dramatic improvement over the old static cap of 1.
  assert.equal(
    computeDispatchBudget({
      trainQueueNonEmpty: true,
      outstandingCount: 0,
      activeSweepJobs: 0,
      activeValidationJobs: 0,
    }),
    MAX_DISPATCH_BUDGET_TRAIN_BUSY,
  );
  // Budget contracts as outstanding recovery grows:
  assert.equal(
    computeDispatchBudget({
      trainQueueNonEmpty: true,
      outstandingCount: 6,
      activeSweepJobs: 0,
      activeValidationJobs: 0,
    }),
    MAX_DISPATCH_BUDGET_TRAIN_BUSY,
    'still at max because headroom (20-9-0-6=5) equals MAX_BUSY',
  );
  assert.equal(
    computeDispatchBudget({
      trainQueueNonEmpty: true,
      outstandingCount: 7,
      activeSweepJobs: 0,
      activeValidationJobs: 0,
    }),
    4,
    'budget contracts below max once headroom (20-9-0-7=4) < MAX_BUSY',
  );
  assert.equal(
    computeDispatchBudget({
      trainQueueNonEmpty: true,
      outstandingCount: RUNNER_CEILING - VALIDATION_RESERVED_TRAIN_BUSY,
    }),
    0,
    'budget reaches zero when outstanding fills all non-reserved slots',
  );
});

test('computeDispatchBudget: sweep-saturated -- active sweep jobs contract the budget', () => {
  // Simulates an in-progress AI Sweep consuming many runner jobs. Each
  // active sweep run is multiplied by SWEEP_RUNNER_WEIGHT in runFromEnv
  // before being passed here as activeSweepJobs.
  const oneSweepRunEstimate = SWEEP_RUNNER_WEIGHT; // = 10

  // One active sweep run, train idle:
  // headroom = 20 - 3 - 10 - 0 = 7, budget = min(8, 7) = 7
  assert.equal(
    computeDispatchBudget({
      trainQueueNonEmpty: false,
      outstandingCount: 0,
      activeSweepJobs: oneSweepRunEstimate,
    }),
    RUNNER_CEILING - VALIDATION_RESERVED_TRAIN_IDLE - oneSweepRunEstimate,
    'sweep jobs reduce the idle budget proportionally',
  );

  // One active sweep run, train busy:
  // headroom = 20 - 9 - 10 - 0 = 1, budget = min(5, 1) = 1
  assert.equal(
    computeDispatchBudget({
      trainQueueNonEmpty: true,
      outstandingCount: 0,
      activeSweepJobs: oneSweepRunEstimate,
    }),
    1,
    'one active sweep run leaves only 1 slot of budget when train is busy',
  );

  // Sweep saturating the runner pool (beyond ceiling minus validation):
  // headroom = 20 - 9 - 15 - 0 = -4 → budget = 0
  assert.equal(
    computeDispatchBudget({
      trainQueueNonEmpty: true,
      outstandingCount: 0,
      activeSweepJobs: 15,
    }),
    0,
    'budget contracts to zero when sweep jobs saturate the runner pool',
  );

  // Budget never goes negative:
  assert.equal(
    computeDispatchBudget({
      trainQueueNonEmpty: true,
      outstandingCount: 0,
      activeSweepJobs: RUNNER_CEILING * 2,
    }),
    0,
    'budget never goes negative regardless of sweep job count',
  );
});

test('computeDispatchBudget: validation-in-flight -- active validation jobs dynamically floor the reservation', () => {
  // When measured validation activity exceeds VALIDATION_RESERVED_TRAIN_BUSY,
  // the reservation is raised to match (dynamic floor). This protects
  // against unexpected validation concurrency spikes.

  // Below static floor: reservation unchanged.
  // activeValidationJobs=5 < VALIDATION_RESERVED_TRAIN_BUSY=9 → uses 9
  assert.equal(
    computeDispatchBudget({
      trainQueueNonEmpty: true,
      outstandingCount: 0,
      activeSweepJobs: 0,
      activeValidationJobs: 5,
    }),
    MAX_DISPATCH_BUDGET_TRAIN_BUSY,
    'measured validation below static floor: reservation unchanged (9), budget at max',
  );

  // Exceeds static floor: reservation raised.
  // activeValidationJobs=12 > VALIDATION_RESERVED_TRAIN_BUSY=9 → uses 12
  // headroom = 20 - 12 - 0 - 0 = 8, budget = min(5, 8) = 5
  assert.equal(
    computeDispatchBudget({
      trainQueueNonEmpty: true,
      outstandingCount: 0,
      activeSweepJobs: 0,
      activeValidationJobs: 12,
    }),
    MAX_DISPATCH_BUDGET_TRAIN_BUSY,
    'measured validation above static floor: reservation raised to 12, but budget still capped at MAX_BUSY',
  );

  // Extreme spike: validation using 18 jobs, train busy, 2 outstanding:
  // headroom = 20 - 18 - 0 - 2 = 0, budget = 0
  assert.equal(
    computeDispatchBudget({
      trainQueueNonEmpty: true,
      outstandingCount: 2,
      activeSweepJobs: 0,
      activeValidationJobs: 18,
    }),
    0,
    'validation spike + existing outstanding exhausts budget entirely',
  );
});

test('computeDispatchBudget: combined load -- sweep + validation + outstanding all contract the budget', () => {
  // All three pressure signals active simultaneously (realistic production peak).
  // Train busy: reserved = max(9, 5*VALIDATION_RUNNER_WEIGHT=45) = 45
  // Wait -- VALIDATION_RUNNER_WEIGHT is a runFromEnv multiplier, not applied here.
  // In the test, activeValidationJobs is already the estimated job count.
  // active validation=8, active sweep=6, outstanding=2, train busy:
  // headroom = 20 - max(9,8) - 6 - 2 = 20 - 9 - 6 - 2 = 3, budget = min(5,3) = 3
  assert.equal(
    computeDispatchBudget({
      trainQueueNonEmpty: true,
      outstandingCount: 2,
      activeSweepJobs: 6,
      activeValidationJobs: 8,
    }),
    3,
    'combined pressure: headroom=20-9-6-2=3, budget=min(5,3)=3',
  );

  // Fully saturated: sweep + validation + outstanding > ceiling minus floor
  assert.equal(
    computeDispatchBudget({
      trainQueueNonEmpty: true,
      outstandingCount: 3,
      activeSweepJobs: 5,
      activeValidationJobs: 9,
    }),
    3,
    'headroom = 20-max(9,9)-5-3=3, budget = min(5,3)=3',
  );

  // Train idle, some sweep pressure, no validation above floor:
  // headroom = 20 - max(3,0) - 8 - 1 = 8, budget = min(8,8) = 8
  assert.equal(
    computeDispatchBudget({
      trainQueueNonEmpty: false,
      outstandingCount: 1,
      activeSweepJobs: 8,
      activeValidationJobs: 0,
    }),
    MAX_DISPATCH_BUDGET_TRAIN_IDLE,
    'train idle + moderate sweep still allows full idle budget when headroom=8',
  );
});

test('listRecentOutstandingRunIds returns IDs of outstanding runs from first page only', async () => {
  const requestFn = async () => ({
    data: {
      total_count: 5,
      workflow_runs: [
        { id: 1001, status: 'queued' },
        { id: 1002, status: 'in_progress' },
        { id: 1003, status: 'completed' },
        { id: 1004, status: 'waiting' },
        { id: 1005, status: 'success' },
      ],
    },
  });
  const ids = await listRecentOutstandingRunIds(
    'token',
    'nalfeo',
    'Crawler',
    'ci-recovery.yml',
    ['queued', 'pending', 'in_progress', 'waiting', 'requested'],
    requestFn,
  );
  assert.deepEqual(ids, new Set([1001, 1002, 1004]), 'must return only outstanding run IDs');
});

test('waitForDispatchedRunsVisible resolves when a newly dispatched run appears', async () => {
  // Pre-dispatch: runs 1000 and 1001 were already outstanding.
  const preDispatchIds = new Set([1000, 1001]);
  let visibleIds = new Set([1000, 1001]); // new run not yet visible
  let now = 0;
  const sleeps = [];
  const sleepFn = async (ms) => {
    sleeps.push(ms);
    now += ms;
    // Newly dispatched run 1002 appears during the poll.
    visibleIds = new Set([1000, 1001, 1002]);
  };

  const newCount = await waitForDispatchedRunsVisible(
    'token',
    'nalfeo',
    'Crawler',
    preDispatchIds,
    1,
    {
      timeoutMs: 30,
      pollIntervalMs: 10,
      nowFn: () => now,
      sleepFn,
      listFn: async () => visibleIds,
    },
  );

  assert.equal(newCount, 1);
  assert.equal(sleeps.length, 1, 'must stop polling as soon as the new run is visible');
});

test('waitForDispatchedRunsVisible does not time out when a pre-existing run completes while waiting', async () => {
  // Models the scenario the old waitForOutstandingCount would fail: invocation
  // dispatches one run, but a pre-existing run completes right after dispatch.
  // The aggregate outstanding count stays the same, but the new run IS visible.
  const preDispatchIds = new Set([1000]); // one run was outstanding before dispatch
  // Pre-existing run 1000 completed; new run 1001 appeared.
  const visibleIds = new Set([1001]); // 1000 gone, 1001 new

  const newCount = await waitForDispatchedRunsVisible(
    'token',
    'nalfeo',
    'Crawler',
    preDispatchIds,
    1,
    {
      timeoutMs: 100,
      pollIntervalMs: 10,
      nowFn: () => 0,
      sleepFn: async () => {},
      listFn: async () => visibleIds,
    },
  );

  assert.equal(newCount, 1, 'must detect the new run even though a pre-existing run completed');
});

test('waitForDispatchedRunsVisible rejects on timeout when no new runs ever appear', async () => {
  const preDispatchIds = new Set([1000]);
  let now = 0;
  const sleeps = [];
  await assert.rejects(
    waitForDispatchedRunsVisible('token', 'nalfeo', 'Crawler', preDispatchIds, 1, {
      timeoutMs: 10,
      pollIntervalMs: 5,
      nowFn: () => now,
      sleepFn: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      // Same IDs as pre-dispatch: no new run appeared.
      listFn: async () => new Set([1000]),
    }),
    /Timed out waiting for 1 dispatched run\(s\) to become visible via Actions API/,
  );
  assert.deepEqual(sleeps, [5, 5], 'must keep the concurrency slot until timeout is exhausted');
});

test('waitForOutstandingCount observes a newly dispatched run before returning', async () => {
  let visibleCount = 0;
  let now = 0;
  const countFn = async () => visibleCount;
  const sleeps = [];
  const sleepFn = async (ms) => {
    sleeps.push(ms);
    now += ms;
    // Simulate the dispatch becoming visible mid-poll, the way GitHub's
    // eventual consistency behaves in practice.
    visibleCount = 1;
  };

  const observed = await waitForOutstandingCount('token', 'nalfeo', 'Crawler', 1, {
    timeoutMs: 30,
    pollIntervalMs: 10,
    nowFn: () => now,
    sleepFn,
    countFn,
  });

  assert.equal(observed, 1);
  assert.equal(sleeps.length, 1, 'must stop polling as soon as the expected count is observed');
});

test('waitForOutstandingCount holds the router slot until timeout, then rejects instead of silently succeeding', async () => {
  let now = 0;
  const sleeps = [];
  await assert.rejects(
    waitForOutstandingCount('token', 'nalfeo', 'Crawler', 1, {
      timeoutMs: 10,
      pollIntervalMs: 5,
      nowFn: () => now,
      sleepFn: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      countFn: async () => 0,
    }),
    /Timed out waiting for dispatched run\(s\) to become visible via Actions API/,
  );

  assert.deepEqual(
    sleeps,
    [5, 5],
    'must keep the concurrency slot until the timeout budget is exhausted',
  );
});

test('serialized router invocations do not both under-count the same in-flight dispatch (TOCTOU close)', async () => {
  // Models the TOCTOU race: invocation A dispatches when headroom is exactly 1,
  // then must observe its own dispatch via waitForDispatchedRunsVisible before
  // the router's `queue: max` concurrency group releases the slot to invocation B.
  // Without that wait, B could read a stale outstandingCount (one less than the
  // true count) and dispatch again, breaching the runner headroom ceiling.
  // With the load-aware formula, this scenario is: outstanding=10 (one slot left
  // of the train-busy headroom RUNNER_CEILING - VALIDATION_RESERVED_TRAIN_BUSY = 11).
  const startingOutstandingCount = RUNNER_CEILING - VALIDATION_RESERVED_TRAIN_BUSY - 1; // = 10
  const preDispatchIds = new Set(
    Array.from({ length: startingOutstandingCount }, (_, i) => 1000 + i),
  );
  let apiVisibleIds = new Set(preDispatchIds);
  const sleepFn = async () => {
    // The newly dispatched run (1010) becomes visible during A's poll.
    apiVisibleIds = new Set([...preDispatchIds, 1010]);
  };

  // Invocation A: exactly one slot of headroom left → budget = 1.
  const budgetA = computeDispatchBudget({
    trainQueueNonEmpty: true,
    outstandingCount: startingOutstandingCount,
  });
  assert.equal(budgetA, 1, 'A should have exactly one slot of headroom');
  const { dispatchable: dispatchableA } = partitionDispatchable([101], budgetA);
  assert.deepEqual(dispatchableA, [101]);
  await waitForDispatchedRunsVisible('token', 'nalfeo', 'Crawler', preDispatchIds, 1, {
    timeoutMs: 30,
    pollIntervalMs: 10,
    nowFn: () => 0,
    sleepFn,
    listFn: async () => apiVisibleIds,
  });

  // Invocation B only starts once A's serialized slot is released, so it
  // now reads the up-to-date, post-dispatch count (10 pre-existing + 1 new = 11).
  const outstandingForB = apiVisibleIds.size;
  assert.equal(outstandingForB, RUNNER_CEILING - VALIDATION_RESERVED_TRAIN_BUSY);
  const budgetB = computeDispatchBudget({
    trainQueueNonEmpty: true,
    outstandingCount: outstandingForB,
  });
  const { dispatchable: dispatchableB } = partitionDispatchable([102], budgetB);
  assert.deepEqual(
    dispatchableB,
    [],
    'B must defer -- runner headroom is fully exhausted after A dispatched',
  );
});

test('25 concurrent router-trigger events are bounded by runner headroom while the train queue is non-empty', () => {
  // Simulates the 2026-07-21 incident shape: 25 independently-triggered PR
  // events all resolve to a router invocation wanting to dispatch its own PR
  // while the merge train queue is non-empty. Because the router serialises
  // invocations, each event reads the updated outstandingCount; with the
  // load-aware formula this limits total dispatches to available headroom
  // (RUNNER_CEILING - VALIDATION_RESERVED_TRAIN_BUSY) rather than a static 1.
  const headroomCap = RUNNER_CEILING - VALIDATION_RESERVED_TRAIN_BUSY; // = 11
  const prNumbers = Array.from({ length: 25 }, (_, index) => index + 1);
  let outstandingCount = 0;
  let totalDispatched = 0;

  for (const prNumber of prNumbers) {
    const budget = computeDispatchBudget({
      trainQueueNonEmpty: true,
      outstandingCount,
    });
    const { dispatchable } = partitionDispatchable([prNumber], budget);
    totalDispatched += dispatchable.length;
    outstandingCount += dispatchable.length;
    // Headroom invariant: outstanding must never exceed the ceiling minus
    // the validation reservation.
    assert.ok(
      outstandingCount <= headroomCap,
      `outstanding=${outstandingCount} exceeded headroom cap=${headroomCap} after event for PR #${prNumber}`,
    );
  }

  assert.equal(
    totalDispatched,
    headroomCap,
    `exactly ${headroomCap} dispatches should escape the burst (one per free headroom slot)`,
  );

  // Once all outstanding runs complete, headroom is fully restored and the
  // next sweep round can dispatch again.
  outstandingCount = 0;
  const budgetAfterCompletion = computeDispatchBudget({
    trainQueueNonEmpty: true,
    outstandingCount,
  });
  assert.equal(budgetAfterCompletion, MAX_DISPATCH_BUDGET_TRAIN_BUSY);
});

test('25 concurrent router-trigger events are bounded by runner headroom when the train queue is empty', () => {
  // Same burst shape but with an empty train queue: validation reservation is
  // smaller so more headroom is available, enabling faster backlog drain.
  const headroomCap = RUNNER_CEILING - VALIDATION_RESERVED_TRAIN_IDLE; // = 17
  const prNumbers = Array.from({ length: 25 }, (_, index) => index + 1);
  let outstandingCount = 0;
  let totalDispatched = 0;

  for (const prNumber of prNumbers) {
    const budget = computeDispatchBudget({
      trainQueueNonEmpty: false,
      outstandingCount,
    });
    const { dispatchable } = partitionDispatchable([prNumber], budget);
    totalDispatched += dispatchable.length;
    outstandingCount += dispatchable.length;
    assert.ok(
      outstandingCount <= headroomCap,
      `outstanding=${outstandingCount} exceeded headroom cap=${headroomCap} after event for PR #${prNumber}`,
    );
  }

  assert.equal(totalDispatched, headroomCap);
});

test('25 concurrent router-trigger events are bounded by runner headroom when the merge-train feature is disabled', () => {
  // Regression: backpressure must hold during train feature maintenance/rollback
  // windows. computeDispatchBudget takes no trainEnabled flag; train disabled
  // naturally sets trainQueueNonEmpty=false (no label activity) so the idle-
  // headroom formula applies.
  const headroomCap = RUNNER_CEILING - VALIDATION_RESERVED_TRAIN_IDLE; // = 17
  const prNumbers = Array.from({ length: 25 }, (_, index) => index + 1);
  let outstandingCount = 0;
  let totalDispatched = 0;

  for (const prNumber of prNumbers) {
    const budget = computeDispatchBudget({
      trainQueueNonEmpty: false,
      outstandingCount,
    });
    const { dispatchable } = partitionDispatchable([prNumber], budget);
    totalDispatched += dispatchable.length;
    outstandingCount += dispatchable.length;
    assert.ok(
      outstandingCount <= headroomCap,
      `outstanding=${outstandingCount} exceeded headroom cap=${headroomCap} after event for PR #${prNumber} (train disabled)`,
    );
  }

  assert.equal(
    totalDispatched,
    headroomCap,
    'exactly headroomCap dispatches should escape the burst even with the train feature disabled',
  );
});

test('hydrateRecoveryOwnership stops after six dispatchable PRs in the resolved prefix', async () => {
  // Regression for Thread 8: the previous implementation loaded the full
  // comment history for every owner-labeled PR before selecting at most six
  // candidates. With a large owned backlog this scales with the queue length
  // and can exhaust the router API budget or 10-minute timeout.
  // The updated implementation stops hydrating once the fully-resolved,
  // age-ordered prefix contains enough dispatchable PRs.
  const now = new Date('2026-07-17T12:00:00Z');
  const freshProgressKey = automationProgressKey(
    'head-sha',
    blockerFingerprint([{ kind: 'ci-failure', id: 'ci', summary: 'CI failed' }]),
  );
  // Healthy: fresh progressAt, head matches.
  const makeHealthy = (number) =>
    makeState({
      prNumber: number,
      headSha: 'head-sha',
      fingerprint: blockerFingerprint([{ kind: 'ci-failure', id: 'ci', summary: 'CI failed' }]),
      owner: 'automation',
      status: 'dispatched',
      blockers: [],
      attempt: 1,
      progressKey: freshProgressKey,
      progressAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
  // Unhealthy: stale (40 min ago, past the 30-min threshold).
  const makeUnhealthy = (number) =>
    makeState({
      prNumber: number,
      headSha: 'head-sha',
      fingerprint: blockerFingerprint([]),
      owner: 'automation',
      status: 'dispatched',
      blockers: [],
      attempt: 1,
      progressKey: automationProgressKey('head-sha', blockerFingerprint([])),
      progressAt: new Date(now.getTime() - 40 * 60 * 1000).toISOString(),
      updatedAt: new Date(now.getTime() - 40 * 60 * 1000).toISOString(),
    });

  // 12 PRs with batchSize=3:
  //   Batch 1 (PRs  1-3): all healthy  → 0 dispatchable total → continue
  //   Batch 2 (PRs  4-6): all unhealthy → 3 dispatchable total → continue
  //   Batch 3 (PRs  7-9): all unhealthy → 6 dispatchable total → stop
  //   Batch 4 (PRs 10-12): healthy, must never be loaded
  const pulls = Array.from({ length: 12 }, (_, i) => ({
    number: i + 1,
    labels: [{ name: `ci-owner-pr-${i + 1}` }],
    head: { sha: 'head-sha' },
  }));

  let loadCount = 0;
  const hydrated = await hydrateRecoveryOwnership(
    pulls,
    async (number) => {
      loadCount += 1;
      const isHealthy = number <= 3 || number >= 10;
      const state = isHealthy ? makeHealthy(number) : makeUnhealthy(number);
      return [{ body: renderStateComment(state) }];
    },
    3, // batchSize — use 3 so each batch is independently healthy/unhealthy
    {
      targetDispatchable: 6,
      countDispatchable: (resolvedPulls) =>
        resolvedPulls.filter((pr) => !hasHealthyOwnerForSweep(pr, now)).length,
    },
  );

  // Batches 1–3 loaded (9 PRs). Batch 4 (PRs 10–12) skipped.
  assert.equal(loadCount, 9, 'must stop hydrating after accumulating 6 dispatchable PRs');
  // The unloaded tail must remain without a recoveryState.
  assert.equal(hydrated[9].recoveryState, undefined);
  assert.equal(hydrated[10].recoveryState, undefined);
  assert.equal(hydrated[11].recoveryState, undefined);
  // The healthy front (PRs 1–3) must be fully hydrated.
  assert.ok(hydrated[0].recoveryState !== undefined);
  assert.ok(hydrated[1].recoveryState !== undefined);
  assert.ok(hydrated[2].recoveryState !== undefined);
});
