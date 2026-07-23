import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

import {
  collectPrNumbers,
  computeBackoffDelayMs,
  computeDispatchBudget,
  countOutstandingRecoveryRuns,
  eventPrNumbers,
  GLOBAL_IDLE_TRAIN_DISPATCH_CAP,
  GLOBAL_TRAIN_DISPATCH_CAP,
  hasHealthyOwnerForSweep,
  hydrateRecoveryOwnership,
  identifyReapablePrs,
  isRepairWindowSweepEvent,
  isRetryableError,
  listRecentOutstandingRunIds,
  partitionDispatchable,
  REAPER_LANE_CAP,
  recoveryStateFromComments,
  recoveryBacklogEntries,
  requestWithBackoff,
  recoveryTriggerForPr,
  isManagedCommentEvent,
  selectReaperBatch,
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

test('recovery backlog classification is not truncated to the six-PR dispatch window', () => {
  const pulls = Array.from({ length: 12 }, (_, index) => ({
    number: index + 1,
    state: 'open',
    draft: false,
    created_at: `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
    base: { ref: 'main' },
    head: { repo: { full_name: 'nalfeo/Crawler' } },
    labels: [],
  }));

  assert.equal(recoveryBacklogEntries(pulls, 'nalfeo/Crawler').length, 12);
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

test('computeDispatchBudget caps outstanding recovery runs to GLOBAL_IDLE_TRAIN_DISPATCH_CAP when there is no active merge-train backlog', () => {
  assert.equal(GLOBAL_IDLE_TRAIN_DISPATCH_CAP, 5);
  assert.equal(computeDispatchBudget({ trainQueueNonEmpty: false, outstandingCount: 0 }), 5);
  assert.equal(computeDispatchBudget({ trainQueueNonEmpty: false, outstandingCount: 1 }), 4);
  assert.equal(computeDispatchBudget({ trainQueueNonEmpty: false, outstandingCount: 5 }), 0);
  assert.equal(
    computeDispatchBudget({ trainQueueNonEmpty: false, outstandingCount: 25 }),
    0,
    'budget never goes negative when outstanding exceeds the idle cap',
  );
});

test('computeDispatchBudget still applies the idle cap -- never Infinity -- when the merge-train feature itself is disabled or paused', () => {
  // Regression for the parent-session correction: protecting runner
  // capacity must not lapse specifically when the train is disabled --
  // that is exactly the maintenance/rollback window operators need
  // backpressure to keep working. computeDispatchBudget no longer takes a
  // trainEnabled flag at all: callers determine trainQueueNonEmpty from
  // live PR labels (see runFromEnv), which is naturally false when the
  // train feature is off, so this collapses to the same idle-cap path
  // above rather than an unbounded fallback.
  assert.equal(computeDispatchBudget({ trainQueueNonEmpty: false, outstandingCount: 0 }), 5);
  assert.equal(computeDispatchBudget({ trainQueueNonEmpty: false, outstandingCount: 5 }), 0);
});

test('computeDispatchBudget caps outstanding recovery runs to GLOBAL_TRAIN_DISPATCH_CAP whenever the merge-train backlog is non-empty, including with the train feature disabled', () => {
  assert.equal(GLOBAL_TRAIN_DISPATCH_CAP, 5);
  assert.equal(
    computeDispatchBudget({ trainQueueNonEmpty: true, outstandingCount: 0 }),
    5,
    'a fully idle recovery workflow may dispatch up to the train cap',
  );
  assert.equal(
    computeDispatchBudget({ trainQueueNonEmpty: true, outstandingCount: 1 }),
    4,
    'each outstanding run consumes one unit of the global budget',
  );
  assert.equal(
    computeDispatchBudget({ trainQueueNonEmpty: true, outstandingCount: 25 }),
    0,
    'budget never goes negative when outstanding exceeds the cap',
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
  // Models the exact race a plan reviewer flagged: invocation A dispatches
  // under the train cap, then -- per runFromEnv -- must observe its own
  // dispatch via waitForDispatchedRunsVisible before this invocation ends and
  // the router's `queue: max` concurrency group releases the slot to
  // invocation B. Without that wait, B could read a stale outstandingCount
  // of 0 and dispatch a second run, breaching GLOBAL_TRAIN_DISPATCH_CAP.
  const preexistingIds = Array.from({ length: GLOBAL_TRAIN_DISPATCH_CAP - 1 }, (_, i) => 900 + i);
  const preDispatchIds = new Set(preexistingIds); // fills all but one slot before A dispatches
  let apiVisibleIds = new Set(preexistingIds);
  const sleepFn = async () => {
    apiVisibleIds = new Set([...preexistingIds, 1001]); // A's dispatched run becomes visible during A's poll
  };

  // Invocation A: budget allows exactly one dispatch, taking the cap to its ceiling.
  const budgetA = computeDispatchBudget({
    trainQueueNonEmpty: true,
    outstandingCount: preDispatchIds.size,
  });
  assert.equal(budgetA, 1, 'A may dispatch exactly one run to reach the cap');
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
  // now reads the up-to-date, post-dispatch count.
  const outstandingForB = apiVisibleIds.size;
  const budgetB = computeDispatchBudget({
    trainQueueNonEmpty: true,
    outstandingCount: outstandingForB,
  });
  const { dispatchable: dispatchableB } = partitionDispatchable([102], budgetB);
  assert.deepEqual(dispatchableB, [], 'B must defer -- the cap is already exhausted by A');
});

test('25 concurrent router-trigger events leave at most GLOBAL_TRAIN_DISPATCH_CAP CI Recovery runs outstanding while the train queue is non-empty', () => {
  // Simulates the 2026-07-21 incident shape: 25 independently-triggered PR
  // events all resolve to a router invocation wanting to dispatch its own
  // PR while the merge train queue is non-empty. Each invocation must
  // independently respect the same global cap.
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
    // Bound must hold after every single event in the burst, not just at
    // the end -- this is the actual thundering-herd invariant.
    assert.ok(
      outstandingCount <= GLOBAL_TRAIN_DISPATCH_CAP,
      `outstanding=${outstandingCount} exceeded cap=${GLOBAL_TRAIN_DISPATCH_CAP} after event for PR #${prNumber}`,
    );
  }

  assert.equal(
    totalDispatched,
    5,
    'exactly GLOBAL_TRAIN_DISPATCH_CAP dispatches should escape the burst',
  );

  // Once the one outstanding run completes, capacity frees up and the next
  // event (or the 10-minute scheduled sweep re-evaluating the same PR list)
  // can dispatch again -- eventual processing is preserved.
  outstandingCount = 0;
  const budgetAfterCompletion = computeDispatchBudget({
    trainQueueNonEmpty: true,
    outstandingCount,
  });
  assert.equal(budgetAfterCompletion, 5);
});

test('25 concurrent router-trigger events leave at most GLOBAL_IDLE_TRAIN_DISPATCH_CAP runs outstanding while the train feature is on but its queue is empty', () => {
  // Same burst shape as the non-empty-queue case, but with no Merge Train
  // Validation run to protect: budget relaxes from GLOBAL_TRAIN_DISPATCH_CAP
  // to GLOBAL_IDLE_TRAIN_DISPATCH_CAP (both 5 as of the 2026-07-22 emergency
  // raise) instead of going fully unbounded, per
  // the measured capacity evidence (public repo, 20-job Actions concurrency
  // limit; sweep-style jobs can still be running even with an empty queue).
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
      outstandingCount <= GLOBAL_IDLE_TRAIN_DISPATCH_CAP,
      `outstanding=${outstandingCount} exceeded idle cap=${GLOBAL_IDLE_TRAIN_DISPATCH_CAP} after event for PR #${prNumber}`,
    );
  }

  assert.equal(
    totalDispatched,
    5,
    'exactly GLOBAL_IDLE_TRAIN_DISPATCH_CAP dispatches should escape the burst',
  );
});

test('25 concurrent router-trigger events leave at most GLOBAL_IDLE_TRAIN_DISPATCH_CAP runs outstanding when the merge-train feature is disabled', () => {
  // Regression for the parent-session correction: the 2026-07-21 herd could
  // just as easily recur while the train feature is paused/disabled for
  // maintenance -- exactly the incident-response window an operator sets
  // MERGE_TRAIN_ENABLED=false or leans on ci-recovery-opt-out. Backpressure
  // must not lapse there. computeDispatchBudget takes no trainEnabled input
  // at all: this burst is driven purely by trainQueueNonEmpty=false (the
  // natural state once the train feature is off -- no PR is being actively
  // queued through it) and proves the same idle cap of 2 holds regardless.
  //
  // This sequential loop is now also an accurate model of real router
  // behavior, not just a JS-level budget check: the workflow's concurrency
  // group (see ci-recovery-router.yml and the 'router concurrency serializes
  // every event into one unconditional global group' test) is a single
  // static group applied to every event in every mode, so all 25 events in
  // this burst would in practice run one invocation at a time, each reading
  // the previous invocation's committed outstandingCount -- there is no
  // window in which two of these 25 invocations observe the same stale
  // count concurrently. The idle cap is 5 as of the 2026-07-22 emergency raise.
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
      outstandingCount <= GLOBAL_IDLE_TRAIN_DISPATCH_CAP,
      `outstanding=${outstandingCount} exceeded idle cap=${GLOBAL_IDLE_TRAIN_DISPATCH_CAP} after event for PR #${prNumber} with the train feature disabled`,
    );
  }

  assert.equal(
    totalDispatched,
    5,
    'exactly GLOBAL_IDLE_TRAIN_DISPATCH_CAP dispatches should escape the burst even with the train feature disabled',
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

// ---------------------------------------------------------------------------
// identifyReapablePrs (Fix A + C: lease-reaper GC, issue #1783)
// ---------------------------------------------------------------------------

test('identifyReapablePrs returns stale automation-owned PR numbers', () => {
  // PR #10 is owned, hydrated, and automation state is 35 min old (past 30-min threshold).
  const staleAt = new Date(Date.now() - 35 * 60 * 1000).toISOString();
  const stalePr = {
    number: 10,
    labels: [{ name: 'ci-owner-pr-10' }],
    recoveryState: automationOwnerState(10, staleAt, 1),
  };
  // PR #11 is owned but fresh (5 min old — within threshold).
  const freshAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const freshPr = {
    number: 11,
    labels: [{ name: 'ci-owner-pr-11' }],
    recoveryState: automationOwnerState(11, freshAt, 1),
  };
  // PR #12 has no owner label at all.
  const unownedPr = { number: 12, labels: [] };

  const reapable = identifyReapablePrs([stalePr, freshPr, unownedPr]);
  assert.deepEqual(reapable, [10], 'only the stale owned PR should be reapable');
});

test('identifyReapablePrs excludes shepherd-owned PRs', () => {
  const staleAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const shepherdPr = {
    number: 20,
    labels: [{ name: 'ci-owner-pr-20' }],
    recoveryState: makeState({
      prNumber: 20,
      headSha: 'head-20',
      fingerprint: blockerFingerprint([]),
      owner: 'shepherd',
      status: 'active',
      leaseId: 'test-lease-id',
      blockers: [],
      attempt: 0,
      updatedAt: staleAt,
    }),
  };
  const reapable = identifyReapablePrs([shepherdPr]);
  assert.deepEqual(
    reapable,
    [],
    'shepherd-owned PRs must never be reaped by the automation reaper',
  );
});

test('identifyReapablePrs excludes unhydrated (no recoveryState and no recoveryStateUnreadable) PRs', () => {
  // An owned PR whose state comment was not loaded (recoveryState is undefined
  // and recoveryStateUnreadable is undefined).
  const unhydratedPr = {
    number: 30,
    labels: [{ name: 'ci-owner-pr-30' }],
    // recoveryState and recoveryStateUnreadable are intentionally absent.
  };
  const reapable = identifyReapablePrs([unhydratedPr]);
  assert.deepEqual(reapable, [], 'unhydrated PRs must be skipped (state age is unknown)');
});

test('identifyReapablePrs includes PRs with unreadable recovery state', () => {
  // An owned PR whose state comment could not be parsed (recoveryStateUnreadable is set).
  // These hold a ci-owner lock but the reconciler can never make progress unless dispatched;
  // they must be included in the reaper batch so the orphan cleanup path can run.
  const unreadablePr = {
    number: 31,
    labels: [{ name: 'ci-owner-pr-31' }],
    recoveryState: null,
    recoveryStateUnreadable: 'HTTP 503: Service Unavailable',
  };
  const reapable = identifyReapablePrs([unreadablePr]);
  assert.deepEqual(reapable, [31], 'PRs with unreadable state must be included in reaper batch');
});

test('identifyReapablePrs respects REAPER_LANE_CAP when callers slice the result', () => {
  // 5 stale PRs — the caller should slice to REAPER_LANE_CAP before dispatching.
  const staleAt = new Date(Date.now() - 40 * 60 * 1000).toISOString();
  const stalePrs = Array.from({ length: 5 }, (_, i) => ({
    number: 100 + i,
    labels: [{ name: `ci-owner-pr-${100 + i}` }],
    recoveryState: automationOwnerState(100 + i, staleAt, 2),
  }));
  const reapable = identifyReapablePrs(stalePrs);
  assert.equal(reapable.length, 5, 'all 5 stale PRs are eligible');
  const dispatched = reapable.slice(0, REAPER_LANE_CAP);
  assert.equal(
    dispatched.length,
    REAPER_LANE_CAP,
    'caller must cap at REAPER_LANE_CAP to avoid overloading the runner pool',
  );
});

test('identifyReapablePrs uses progressAt over updatedAt for age check when progressAt is present', () => {
  // updatedAt is old (40 min) but progressAt is fresh (5 min).
  // The reaper must use progressAt, so this PR should NOT be reapable.
  const oldUpdatedAt = new Date(Date.now() - 40 * 60 * 1000).toISOString();
  const freshProgressAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const fp = blockerFingerprint([{ kind: 'ci-failure', id: 'ci', summary: 'CI failed' }]);
  const pr = {
    number: 50,
    labels: [{ name: 'ci-owner-pr-50' }],
    recoveryState: makeState({
      prNumber: 50,
      headSha: 'head-50',
      fingerprint: fp,
      owner: 'automation',
      status: 'dispatched',
      blockers: [{ kind: 'ci-failure', id: 'ci', summary: 'CI failed' }],
      attempt: 1,
      progressKey: automationProgressKey('head-50', fp),
      progressAt: freshProgressAt,
      updatedAt: oldUpdatedAt,
    }),
  };
  const reapable = identifyReapablePrs([pr]);
  assert.deepEqual(reapable, [], 'fresh progressAt must prevent reaping even if updatedAt is old');
});

// ---------------------------------------------------------------------------
// Reaper-lane hardening (issue #1783 follow-up): finding #2 (hydrated-null
// reapable), finding #3 (rotation-before-cap fairness), finding #5 (runFromEnv
// zero-budget reaper dispatch + reaped-PR exclusion from the normal loop).
// ---------------------------------------------------------------------------

test('identifyReapablePrs distinguishes hydrated-null (reap) from unhydrated-undefined (skip)', () => {
  // Distinct from the recoveryStateUnreadable case: here hydration SUCCEEDED
  // but produced no parseable automation state (recoveryStateFromComments
  // returned null), while recoveryStateUnreadable is absent. The PR still holds
  // a ci-owner lock the reconciler must clean up, so it must be reaped. This
  // exercises the `state === null` branch, which the unreadable-marker test
  // short-circuits before reaching.
  const nullStatePr = {
    number: 40,
    labels: [{ name: 'ci-owner-pr-40' }],
    recoveryState: null,
    // recoveryStateUnreadable intentionally absent (undefined).
  };
  // Owned but never hydrated (both fields absent) → age unknown → must be skipped.
  const undefinedStatePr = {
    number: 41,
    labels: [{ name: 'ci-owner-pr-41' }],
  };
  const reapable = identifyReapablePrs([nullStatePr, undefinedStatePr]);
  assert.deepEqual(
    reapable,
    [40],
    'hydrated-null owned PR is reaped; unhydrated-undefined PR is skipped',
  );
});

test('selectReaperBatch rotates eligible reapable PRs across sweep windows so none starve past the cap', () => {
  // Two independent properties guarantee no stale lock starves past the cap:
  //
  // (1) ORDER-INDEPENDENCE (the load-bearing invariant): the caller derives the
  //     reapable list from the updated-desc pull feed, whose order churns as
  //     reaping bumps a PR's updated_at. If the batch depended on input order, a
  //     freshly-reaped PR jumping to the front could keep getting re-picked
  //     while the tail starves. selectReaperBatch sorts to a sweep-invariant
  //     order first, so the same window always yields the same batch regardless
  //     of how the input is ordered.
  const now0 = new Date('2026-07-21T00:00:00Z');
  const ascending = selectReaperBatch([1, 2, 3, 4, 5], now0);
  const shuffled = selectReaperBatch([4, 1, 5, 3, 2], now0);
  const descending = selectReaperBatch([5, 4, 3, 2, 1], now0);
  assert.deepEqual(shuffled, ascending, 'batch must not depend on input ordering (churn-proof)');
  assert.deepEqual(descending, ascending, 'batch must not depend on input ordering (churn-proof)');

  // (2) CROSS-WINDOW COVERAGE: rotating once per 10-minute window before the cap
  //     slice means every eligible lock enters the dispatched prefix within at
  //     most `length` windows. Successive hours land in distinct windows.
  const seen = new Set();
  for (let sweep = 0; sweep < 5; sweep += 1) {
    const now = new Date(`2026-07-21T0${sweep}:00:00Z`);
    const batch = selectReaperBatch([1, 2, 3, 4, 5], now);
    assert.equal(batch.length, REAPER_LANE_CAP, 'each sweep dispatches at most the cap');
    for (const n of batch) seen.add(n);
  }
  assert.deepEqual(
    seen,
    new Set([1, 2, 3, 4, 5]),
    'every stale lock is eventually reaped across successive windows (no starvation)',
  );
});

const ROUTER_SCRIPT = fileURLToPath(new URL('./router.mjs', import.meta.url));

// Minimal mock server for the runFromEnv subprocess integration test. Maps
// "METHOD /path-without-query" (exact, else longest startsWith) to a handler
// returning { status?, body? }. Unmatched routes return 200 {}.
function startRouterMockServer(routes) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const method = req.method.toUpperCase();
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const parsed = raw ? JSON.parse(raw) : undefined;
        const pathOnly = req.url.split('?')[0];
        let handler = routes[`${method} ${pathOnly}`];
        if (!handler) {
          const entry = Object.entries(routes).find(([key]) => {
            const space = key.indexOf(' ');
            return key.slice(0, space) === method && pathOnly.startsWith(key.slice(space + 1));
          });
          handler = entry?.[1];
        }
        const result = (handler ? handler(req.url, parsed) : {}) ?? {};
        res.writeHead(result.status ?? 200, { 'Content-Type': 'application/json' });
        res.end(result.body !== undefined ? JSON.stringify(result.body) : '{}');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function runRouterScript(port, env) {
  const child = spawn(process.execPath, [ROUTER_SCRIPT], {
    env: {
      GITHUB_API_URL: `http://127.0.0.1:${port}`,
      GITHUB_GRAPHQL_URL: `http://127.0.0.1:${port}/graphql`,
      ...env,
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d) => {
    stdout += d;
  });
  child.stderr?.on('data', (d) => {
    stderr += d;
  });
  const [code] = await once(child, 'close');
  return { code, stdout, stderr };
}

// Mirrors reconcile.test.mjs's assertSuccessfulExit: the shared spawn+HTTP mock
// teardown trips a native libuv assertion on some Windows hosts (exit
// 3221226505 + UV_HANDLE_CLOSING), unrelated to script logic. Real CI is Linux,
// so this branch never applies there.
function assertRouterExit(t, code, stderr) {
  if (process.platform === 'win32' && code === 3221226505 && /UV_HANDLE_CLOSING/.test(stderr)) {
    t.skip('known Windows UV_HANDLE_CLOSING subprocess shutdown assertion');
    return false;
  }
  assert.equal(code, 0, `expected exit 0; stderr: ${stderr}`);
  return true;
}

test('runFromEnv dispatches the lease-reaper at zero budget and excludes the reaped PR from the normal loop', async (t) => {
  const OWNER = 'test-owner';
  const REPO = 'test-repo';
  const TOKEN = 'x-test-token';
  const staleAt = new Date(Date.now() - 35 * 60 * 1000).toISOString();

  // PR #10: owner-labeled with a stale automation lock. It is unhydrated in the
  // list response, so the reaper hydrates it from its comments below; the state
  // is 35 min old → reapable. It is ALSO normally eligible (owner-labeled), so
  // without the reaperDispatchedSet exclusion the normal loop would target it.
  const pr10 = {
    number: 10,
    draft: false,
    labels: [{ name: 'ci-owner-pr-10' }],
    head: { sha: 'head-10', repo: { full_name: `${OWNER}/${REPO}` } },
  };
  // PR #11: no owner label, normally eligible — proves the normal loop ran.
  const pr11 = {
    number: 11,
    draft: false,
    labels: [],
    head: { sha: 'head-11', repo: { full_name: `${OWNER}/${REPO}` } },
  };
  const staleStateComment = {
    id: 1,
    body: renderStateComment(automationOwnerState(10, staleAt, 1)),
  };

  const dispatches = [];
  const { server, port } = await startRouterMockServer({
    [`GET /repos/${OWNER}/${REPO}/pulls`]: () => ({ body: [pr10, pr11] }),
    [`GET /repos/${OWNER}/${REPO}/issues/10/comments`]: () => ({ body: [staleStateComment] }),
    // High outstanding count → computeDispatchBudget === 0, so the normal loop
    // dispatches nothing (all deferred). The reaper runs OUTSIDE this budget.
    [`GET /repos/${OWNER}/${REPO}/actions/workflows/ci-recovery.yml/runs`]: () => ({
      body: { total_count: 999, workflow_runs: [] },
    }),
    [`POST /repos/${OWNER}/${REPO}/actions/workflows/ci-recovery.yml/dispatches`]: (_url, body) => {
      dispatches.push(body?.inputs ?? {});
      return { status: 204 };
    },
  });
  t.after(() => server.close());

  const eventDir = await mkdtemp(join(tmpdir(), 'router-runfromenv-'));
  const eventPath = join(eventDir, 'event.json');
  await writeFile(
    eventPath,
    JSON.stringify({ repository: { full_name: `${OWNER}/${REPO}`, default_branch: 'main' } }),
  );
  t.after(() => rm(eventDir, { recursive: true, force: true }));

  const { code, stdout, stderr } = await runRouterScript(port, {
    GITHUB_TOKEN: TOKEN,
    GITHUB_REPOSITORY: `${OWNER}/${REPO}`,
    GITHUB_EVENT_NAME: 'schedule',
    GITHUB_EVENT_PATH: eventPath,
  });

  if (!assertRouterExit(t, code, stderr)) return;

  // (a) The reaper dispatched PR #10 despite the dispatch budget being 0.
  const reaperDispatches = dispatches.filter((inputs) => inputs.trigger === 'lease-reaper');
  assert.equal(
    reaperDispatches.length,
    1,
    `exactly one zero-budget lease-reaper dispatch expected; stdout: ${stdout}`,
  );
  assert.equal(reaperDispatches[0].pr_number, '10', 'the stale owned PR is the reaped one');
  assert.match(stdout, /reaper-dispatch pr=#10 trigger=lease-reaper/);

  // (b) The reaped PR is excluded from the normal loop: no normal (non
  // lease-reaper) dispatch targets #10, and the normal loop still considered
  // #11 (deferred under the zero budget), proving reaperDispatchedSet removed
  // only the reaped PR from the normal set.
  const normalDispatchesFor10 = dispatches.filter(
    (inputs) => inputs.pr_number === '10' && inputs.trigger !== 'lease-reaper',
  );
  assert.equal(
    normalDispatchesFor10.length,
    0,
    'reaped PR must never be re-dispatched by the normal loop',
  );
  assert.match(
    stdout,
    /global backpressure applied deferred=1 pr_numbers=11 /,
    `#11 must be deferred by the normal loop while #10 is excluded; stdout: ${stdout}`,
  );
});
