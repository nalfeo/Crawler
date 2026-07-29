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
  CI_FIX_LABEL_NAMES,
  collectPrNumbers,
  computeBackoffDelayMs,
  computeDispatchBudget,
  countOutstandingRecoveryRuns,
  countOutstandingWorkflowRuns,
  DISPATCH_BLOCKED_LABEL_NAMES,
  eventPrNumbers,
  GLOBAL_IDLE_TRAIN_DISPATCH_CAP,
  GLOBAL_TRAIN_DISPATCH_CAP,
  hasHealthyOwnerForSweep,
  hydrateRecoveryOwnership,
  identifyReapablePrs,
  isCiFixPr,
  isDispatchBlocked,
  isRepairWakeEligible,
  isRepairWindowSweepEvent,
  isRetryableError,
  listRecentOutstandingRunIds,
  MAX_DISPATCH_BUDGET_TRAIN_BUSY,
  MAX_DISPATCH_BUDGET_TRAIN_IDLE,
  partitionDispatchable,
  REAPER_LANE_CAP,
  recoveryStateFromComments,
  recoveryBacklogEntries,
  requestWithBackoff,
  resolveGlobalDispatchCaps,
  recoveryTriggerForPr,
  RUNNER_CEILING,
  SWEEP_RUNNER_WEIGHT,
  SWEEP_WORKFLOW_FILES,
  VALIDATION_RESERVED_TRAIN_BUSY,
  VALIDATION_RESERVED_TRAIN_IDLE,
  VALIDATION_RUNNER_WEIGHT,
  isManagedCommentEvent,
  selectReaperBatch,
  waitForDispatchedRunsVisible,
  waitForOutstandingCount,
} from './router.mjs';
import {
  CI_INCIDENT_MARKER,
  COORDINATOR_DATA_PREFIX,
  MANAGED_COMMENT_MARKERS,
  MANAGED_COMMENT_PREFIX,
  LOOP_INCIDENT_FINGERPRINT_PREFIX,
  LOOP_INCIDENT_MARKER,
  MERGE_TRAIN_EMPTY_INCIDENT_MARKER,
  MERGE_TRAIN_LANDED_MARKER,
  STATE_DATA_PREFIX,
  TASK_COMMENT_MARKER,
  LIFECYCLE_DATA_PREFIX,
} from './markers.mjs';
import {
  automationProgressKey,
  blockerFingerprint,
  makeState,
  RECOVERY_STATUSES,
  renderStateComment,
} from './state.mjs';

const workflowPath = new URL('../../workflows/ci-recovery-router.yml', import.meta.url);
const workflow = parse(await readFile(workflowPath, 'utf8'));
const routeJob = workflow.jobs.route;

test('periodic cadence is centralized in ci-liveness-sweep', async () => {
  assert.equal(
    workflow.on?.schedule,
    undefined,
    'ci-recovery-router.yml should be event-driven + workflow_dispatch only',
  );
  const livenessWorkflow = await readFile(
    new URL('../../workflows/ci-liveness-sweep.yml', import.meta.url),
    'utf8',
  );
  assert.match(livenessWorkflow, /cron:\s*'\*\/10 \* \* \* \*'/);
  assert.match(livenessWorkflow, /workflow_id:\s*'ci-recovery-router\.yml'/);
  // Closed-fence reclaim is now routed through the router's reaper pass
  // (selectReaperBatch combined pool) rather than dispatched directly from the
  // liveness sweep. Verify the router script contains the closed-fence scan.
  const routerScript = await readFile(
    new URL('../ci-recovery/router.mjs', import.meta.url),
    'utf8',
  );
  assert.match(routerScript, /closed.*fence.*candidate|closedFenceCandidates/i);
});

function pickInvariantDispatchCaps(resolved) {
  return {
    maxBudgetTrainBusy: resolved.maxBudgetTrainBusy,
    maxBudgetTrainIdle: resolved.maxBudgetTrainIdle,
    globalTrainDispatchCap: resolved.globalTrainDispatchCap,
    maxDispatchPerRun: resolved.maxDispatchPerRun,
  };
}

function pickLegacyDispatchCaps(resolved) {
  return {
    trainCap: resolved.trainCap,
    idleCap: resolved.idleCap,
  };
}

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

test('flag-off schedule sweeps exclude blocked-labeled PRs from dispatch', () => {
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

  assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(!numbers.includes(99), 'merge-train-blocked PR must be excluded');
});

test('flag-off schedule sweeps exclude lifecycle-quarantined/abandoned PRs from dispatch', () => {
  const scheduledPulls = [
    {
      number: 1,
      draft: false,
      labels: [{ name: 'ci-lifecycle-quarantined' }],
      head: { repo: { full_name: 'nalfeo/Crawler' } },
    },
    {
      number: 2,
      draft: false,
      labels: [{ name: 'ci-lifecycle-abandoned' }],
      head: { repo: { full_name: 'nalfeo/Crawler' } },
    },
    {
      number: 3,
      draft: false,
      labels: [],
      head: { repo: { full_name: 'nalfeo/Crawler' } },
    },
  ];
  const numbers = collectPrNumbers({
    payload: { repository: { default_branch: 'main' } },
    eventName: 'schedule',
    repository: 'nalfeo/Crawler',
    scheduledPulls,
    maxDispatchPerRun: 5,
    trainEnabled: false,
    now: new Date('1970-01-01T00:00:00Z'),
  });

  assert.deepEqual(numbers, [3]);
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

test('flag-off schedule sweeps apply FIFO ordering and exclude blocked PRs within the cap', () => {
  // 10 PRs: #9 carries merge-train-blocked (excluded) and #2 carries merge-train
  // (not blocked). With oldest-first FIFO, the 5 oldest unblocked PRs are
  // selected regardless of their position in the API response.
  const scheduledPulls = [
    {
      number: 10,
      draft: false,
      created_at: '2026-07-10T00:00:00Z',
      head: { repo: { full_name: 'nalfeo/Crawler' } },
      labels: [],
    },
    {
      number: 9,
      draft: false,
      created_at: '2026-07-09T00:00:00Z',
      head: { repo: { full_name: 'nalfeo/Crawler' } },
      labels: [{ name: 'merge-train-blocked' }],
    },
    {
      number: 8,
      draft: false,
      created_at: '2026-07-08T00:00:00Z',
      head: { repo: { full_name: 'nalfeo/Crawler' } },
      labels: [],
    },
    {
      number: 7,
      draft: false,
      created_at: '2026-07-07T00:00:00Z',
      head: { repo: { full_name: 'nalfeo/Crawler' } },
      labels: [],
    },
    {
      number: 6,
      draft: false,
      created_at: '2026-07-06T00:00:00Z',
      head: { repo: { full_name: 'nalfeo/Crawler' } },
      labels: [],
    },
    {
      number: 5,
      draft: false,
      created_at: '2026-07-05T00:00:00Z',
      head: { repo: { full_name: 'nalfeo/Crawler' } },
      labels: [],
    },
    {
      number: 4,
      draft: false,
      created_at: '2026-07-04T00:00:00Z',
      head: { repo: { full_name: 'nalfeo/Crawler' } },
      labels: [],
    },
    {
      number: 3,
      draft: false,
      created_at: '2026-07-03T00:00:00Z',
      head: { repo: { full_name: 'nalfeo/Crawler' } },
      labels: [],
    },
    {
      number: 2,
      draft: false,
      created_at: '2026-07-02T00:00:00Z',
      head: { repo: { full_name: 'nalfeo/Crawler' } },
      labels: [{ name: 'merge-train' }],
    },
    {
      number: 1,
      draft: false,
      created_at: '2026-07-01T00:00:00Z',
      head: { repo: { full_name: 'nalfeo/Crawler' } },
      labels: [],
    },
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
    numbers,
    [1, 2, 3, 4, 5],
    'oldest 5 unblocked PRs selected; blocked PR #9 excluded; merge-train PR #2 is not blocked',
  );
  assert.ok(!numbers.includes(9), 'merge-train-blocked PR #9 must be excluded');
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

test('flag-off sweeps order PRs oldest-first (global FIFO) across sweeps', () => {
  // 5 PRs with distinct creation timestamps, submitted in newest-first API order.
  // Each sweep with budget=2 should pick the two oldest *remaining unowned* PRs.
  // Because the set never shrinks (we're not modelling dispatch/completion here)
  // the same two oldest PRs win every sweep — the key property is that the order
  // is deterministic oldest-first rather than rotation-dependent.
  const scheduledPulls = [
    {
      number: 5,
      draft: false,
      labels: [],
      created_at: '2026-07-05T00:00:00Z',
      head: { repo: { full_name: 'nalfeo/Crawler' } },
    },
    {
      number: 4,
      draft: false,
      labels: [],
      created_at: '2026-07-04T00:00:00Z',
      head: { repo: { full_name: 'nalfeo/Crawler' } },
    },
    {
      number: 3,
      draft: false,
      labels: [],
      created_at: '2026-07-03T00:00:00Z',
      head: { repo: { full_name: 'nalfeo/Crawler' } },
    },
    {
      number: 2,
      draft: false,
      labels: [],
      created_at: '2026-07-02T00:00:00Z',
      head: { repo: { full_name: 'nalfeo/Crawler' } },
    },
    {
      number: 1,
      draft: false,
      labels: [],
      created_at: '2026-07-01T00:00:00Z',
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

  // Oldest-first regardless of API response order.
  assert.deepEqual(ordered, [1, 2, 3, 4, 5]);

  const { dispatchable } = partitionDispatchable(ordered, 2);
  assert.deepEqual(dispatchable, [1, 2]);
});

test('flag-off sweeps sort by created_at regardless of ownership label', () => {
  // Ownership label (ci-owner-pr-N) no longer affects ordering; only age does.
  const scheduledPulls = [
    {
      number: 5,
      draft: false,
      labels: [],
      created_at: '2026-07-05T00:00:00Z',
      head: { repo: { full_name: 'nalfeo/Crawler' } },
    },
    {
      number: 4,
      draft: false,
      labels: [{ name: 'ci-owner-pr-4' }],
      created_at: '2026-07-04T00:00:00Z',
      head: { repo: { full_name: 'nalfeo/Crawler' } },
    },
    {
      number: 3,
      draft: false,
      labels: [],
      created_at: '2026-07-03T00:00:00Z',
      head: { repo: { full_name: 'nalfeo/Crawler' } },
    },
    {
      number: 2,
      draft: false,
      labels: [{ name: 'ci-owner-pr-2' }],
      created_at: '2026-07-02T00:00:00Z',
      head: { repo: { full_name: 'nalfeo/Crawler' } },
    },
    {
      number: 1,
      draft: false,
      labels: [],
      created_at: '2026-07-01T00:00:00Z',
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
  // Oldest PRs win, regardless of whether they carry an owner label.
  assert.deepEqual(dispatchable, [1, 2]);
});

// ── New acceptance-criteria tests ────────────────────────────────────────────

test('isCiFixPr returns true for ci and ci-infra labels, false otherwise', () => {
  assert.equal(isCiFixPr({ labels: [{ name: 'ci' }] }), true);
  assert.equal(isCiFixPr({ labels: [{ name: 'ci-infra' }] }), true);
  assert.equal(isCiFixPr({ labels: [{ name: 'ci' }, { name: 'bug' }] }), true);
  assert.equal(isCiFixPr({ labels: [{ name: 'bug' }] }), false);
  assert.equal(isCiFixPr({ labels: [] }), false);
  assert.equal(isCiFixPr({}), false);
  // Classification is label-based, NOT title-heuristic.
  assert.equal(isCiFixPr({ labels: [], title: 'fix(ci): improve pipeline' }), false);
});

test('CI_FIX_LABEL_NAMES contains exactly the expected labels', () => {
  assert.ok(CI_FIX_LABEL_NAMES.has('ci'));
  assert.ok(CI_FIX_LABEL_NAMES.has('ci-infra'));
  assert.equal(CI_FIX_LABEL_NAMES.size, 2);
});

test('isDispatchBlocked returns true for every blocked label, false for allowed labels', () => {
  for (const label of DISPATCH_BLOCKED_LABEL_NAMES) {
    assert.equal(
      isDispatchBlocked({ labels: [{ name: label }] }),
      true,
      `${label} must be a blocked label`,
    );
  }
  assert.equal(isDispatchBlocked({ labels: [{ name: 'ci' }] }), false);
  assert.equal(isDispatchBlocked({ labels: [{ name: 'merge-train' }] }), false);
  assert.equal(isDispatchBlocked({ labels: [{ name: 'merge-train-noop' }] }), false);
  assert.equal(isDispatchBlocked({ labels: [] }), false);
  assert.equal(isDispatchBlocked({}), false);
});

test('DISPATCH_BLOCKED_LABEL_NAMES contains all required blocked labels', () => {
  for (const required of [
    'ci-conflict-order-wait',
    'ci-conflict-escalation',
    'ci-lifecycle-quarantined',
    'ci-lifecycle-abandoned',
    'merge-train-blocked',
    'merge-train-validation-failed',
    'human-approval-required',
    'ci-recovery-waiting',
  ]) {
    assert.ok(DISPATCH_BLOCKED_LABEL_NAMES.has(required), `${required} must be in blocked set`);
  }
});

test('flag-off schedule dispatches CI-fix PRs before normal PRs, both oldest-first', () => {
  const scheduledPulls = [
    {
      number: 10,
      draft: false,
      created_at: '2026-07-10T00:00:00Z',
      labels: [],
      head: { repo: { full_name: 'nalfeo/Crawler' } },
    },
    {
      number: 9,
      draft: false,
      created_at: '2026-07-09T00:00:00Z',
      labels: [{ name: 'ci-infra' }],
      head: { repo: { full_name: 'nalfeo/Crawler' } },
    },
    {
      number: 8,
      draft: false,
      created_at: '2026-07-08T00:00:00Z',
      labels: [],
      head: { repo: { full_name: 'nalfeo/Crawler' } },
    },
    {
      number: 7,
      draft: false,
      created_at: '2026-07-07T00:00:00Z',
      labels: [{ name: 'ci' }],
      head: { repo: { full_name: 'nalfeo/Crawler' } },
    },
    {
      number: 6,
      draft: false,
      created_at: '2026-07-06T00:00:00Z',
      labels: [],
      head: { repo: { full_name: 'nalfeo/Crawler' } },
    },
  ];

  const numbers = collectPrNumbers({
    payload: {},
    eventName: 'schedule',
    repository: 'nalfeo/Crawler',
    scheduledPulls,
    maxDispatchPerRun: 8,
    now: new Date('2026-07-21T00:00:00Z'),
  });

  // CI-fix PRs (7 and 9) come before general PRs (6, 8, 10), each tier oldest-first.
  assert.deepEqual(numbers, [7, 9, 6, 8, 10]);
});

test('flag-off schedule: blocked PRs excluded even when directly triggered by event', () => {
  const blockedPr = {
    number: 42,
    draft: false,
    created_at: '2026-07-01T00:00:00Z',
    labels: [{ name: 'human-approval-required' }],
    head: { repo: { full_name: 'nalfeo/Crawler' } },
  };
  const normalPr = {
    number: 43,
    draft: false,
    created_at: '2026-07-02T00:00:00Z',
    labels: [],
    head: { repo: { full_name: 'nalfeo/Crawler' } },
  };

  // PR 42 is directly named by the event but carries human-approval-required.
  const numbers = collectPrNumbers({
    payload: { pull_request: { number: 42 } },
    eventName: 'workflow_dispatch',
    repository: 'nalfeo/Crawler',
    scheduledPulls: [blockedPr, normalPr],
    maxDispatchPerRun: 8,
  });

  assert.ok(!numbers.includes(42), 'directly-triggered blocked PR must still be excluded');
  assert.ok(numbers.includes(43), 'unblocked PR must be included');
});

test('flag-off schedule: genuine ci-recovery-waiting PR stays excluded even when directly triggered', () => {
  const waitingPr = {
    number: 55,
    draft: false,
    created_at: '2026-07-01T00:00:00Z',
    labels: [{ name: 'ci-recovery-waiting' }],
    head: { repo: { full_name: 'nalfeo/Crawler' } },
  };

  const numbers = collectPrNumbers({
    payload: { pull_request: { number: 55 } },
    eventName: 'workflow_dispatch',
    repository: 'nalfeo/Crawler',
    scheduledPulls: [waitingPr],
    maxDispatchPerRun: 8,
  });

  assert.ok(
    !numbers.includes(55),
    'genuine ci-recovery-waiting PR must stay excluded even if directly triggered',
  );
  assert.equal(isRepairWakeEligible(waitingPr), false);
});

test('flag-off schedule: idle repair waiting PR can re-enter the exact repair path', () => {
  const waitingPr = {
    number: 55,
    draft: false,
    created_at: '2026-07-01T00:00:00Z',
    labels: [{ name: 'ci-recovery-waiting' }],
    head: { repo: { full_name: 'nalfeo/Crawler' } },
    recoveryState: makeState({
      prNumber: 55,
      headSha: 'head-55',
      fingerprint: 'repair-gap-fixture',
      owner: 'none',
      status: 'idle',
      trigger: 'stale-automation',
      blockers: [{ kind: 'ci-failure', id: 'ci', summary: 'CI failed' }],
      attempt: 1,
      updatedAt: '2026-07-01T01:00:00Z',
    }),
  };

  const numbers = collectPrNumbers({
    payload: {},
    eventName: 'schedule',
    repository: 'nalfeo/Crawler',
    scheduledPulls: [waitingPr],
    maxDispatchPerRun: 8,
  });

  assert.deepEqual(numbers, [55]);
  assert.equal(isRepairWakeEligible(waitingPr), true);
});

// 2026-07-27 production stall: the admission-wait path parks ownerless PRs as
// `owner=none,status=waiting`, not `status=idle`. Accepting only `idle` made 17
// of 31 open PRs permanently unreachable by any sweep (oldest parked >2 days)
// and left the merge train empty indefinitely.
test('repair wake: ownerless admission-wait (status=waiting) PR is sweep-eligible', () => {
  const waitingPr = {
    number: 2080,
    state: 'open',
    draft: false,
    created_at: '2026-07-27T00:00:00Z',
    base: { ref: 'main' },
    labels: [{ name: 'ci-recovery-waiting' }],
    head: { repo: { full_name: 'nalfeo/Crawler' } },
    recoveryState: makeState({
      prNumber: 2080,
      headSha: 'acea0cb6',
      fingerprint: 'admission-wait-fixture',
      owner: 'none',
      status: 'waiting',
      trigger: 'admission-wait',
      blockers: [],
      attempt: 0,
      updatedAt: '2026-07-27T04:37:47Z',
    }),
  };

  assert.equal(isRepairWakeEligible(waitingPr), true);

  const numbers = collectPrNumbers({
    payload: {},
    eventName: 'schedule',
    repository: 'nalfeo/Crawler',
    scheduledPulls: [waitingPr],
    maxDispatchPerRun: 8,
    trainEnabled: true,
  });

  assert.deepEqual(numbers, [2080]);
});

test('repair wake: a waiting PR carrying an owner label stays hidden', () => {
  const ownedPr = {
    number: 2081,
    state: 'open',
    draft: false,
    created_at: '2026-07-27T00:00:00Z',
    base: { ref: 'main' },
    labels: [{ name: 'ci-recovery-waiting' }, { name: 'ci-owner-pr-2081' }],
    head: { repo: { full_name: 'nalfeo/Crawler' } },
    recoveryState: makeState({
      prNumber: 2081,
      headSha: 'head-2081',
      fingerprint: 'owned-fixture',
      owner: 'none',
      status: 'waiting',
      trigger: 'admission-wait',
      blockers: [],
      attempt: 0,
      updatedAt: '2026-07-27T04:37:47Z',
    }),
  };

  assert.equal(isRepairWakeEligible(ownedPr), false);
});

// 2026-07-27 production stall: reconcile unconditionally skips conflict-fenced
// PRs (`skip pr=#N reason=ci-conflict-order-wait`), yet they still consumed
// slots in the bounded REPAIR_WINDOW_SIZE sweep, starving healthy PRs.
test('repair window: conflict-fenced PRs do not consume sweep slots', () => {
  const fenced = (number, labelName) => ({
    number,
    state: 'open',
    draft: false,
    created_at: `2026-07-0${number - 1999}T00:00:00Z`,
    base: { ref: 'main' },
    labels: [{ name: labelName }],
    head: { repo: { full_name: 'nalfeo/Crawler' } },
  });
  const healthy = {
    number: 2096,
    state: 'open',
    draft: false,
    created_at: '2026-07-20T00:00:00Z',
    base: { ref: 'main' },
    labels: [],
    head: { repo: { full_name: 'nalfeo/Crawler' } },
  };

  const numbers = collectPrNumbers({
    payload: {},
    eventName: 'schedule',
    repository: 'nalfeo/Crawler',
    scheduledPulls: [
      fenced(2001, 'ci-conflict-order-wait'),
      fenced(2002, 'ci-conflict-escalation'),
      healthy,
    ],
    maxDispatchPerRun: 8,
    trainEnabled: true,
  });

  assert.deepEqual(numbers, [2096]);
});

test('repair window: broad sweep rotates selection instead of pinning the oldest fixed prefix', () => {
  const pulls = Array.from({ length: 8 }, (_, index) => ({
    number: 3001 + index,
    state: 'open',
    draft: false,
    created_at: `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
    base: { ref: 'main' },
    labels: [],
    head: { repo: { full_name: 'nalfeo/Crawler' } },
  }));

  const firstWindow = collectPrNumbers({
    payload: {},
    eventName: 'schedule',
    repository: 'nalfeo/Crawler',
    scheduledPulls: pulls,
    trainEnabled: true,
    now: new Date('2026-07-27T00:00:00Z'),
  });
  const secondWindow = collectPrNumbers({
    payload: {},
    eventName: 'schedule',
    repository: 'nalfeo/Crawler',
    scheduledPulls: pulls,
    trainEnabled: true,
    now: new Date('2026-07-27T00:11:00Z'),
  });

  assert.deepEqual(firstWindow, [3001, 3002, 3003, 3004, 3005, 3006]);
  assert.deepEqual(secondWindow, [3002, 3003, 3004, 3005, 3006, 3007]);
});

test('invariant: every writable recovery status is dispatch-reachable through some train path', () => {
  const nowDate = new Date(0); // rotation = 0, deterministic sweep order
  const created_at = nowDate.toISOString();

  for (const [index, status] of RECOVERY_STATUSES.entries()) {
    const prNumber = 3100 + index;
    // `waiting` needs the parking label; others must not have it so they land in
    // the plain sweep bucket, exercising the eligibility filter for each status.
    const labels = status === 'waiting' ? [{ name: 'ci-recovery-waiting' }] : [];
    const pull = {
      number: prNumber,
      state: 'open',
      draft: false,
      created_at,
      base: { ref: 'main' },
      labels,
      head: { repo: { full_name: 'nalfeo/Crawler' } },
      recoveryState: makeState({
        prNumber,
        headSha: `head-${prNumber}`,
        fingerprint: `status-${status}`,
        owner: 'none',
        status,
        trigger: status === 'waiting' ? 'admission-wait' : status,
        blockers: [],
        attempt: 0,
        updatedAt: created_at,
      }),
    };

    // Use the schedule (non-direct) path so routing logic for each status is
    // actually exercised.  If isRepairWakeEligible or the sweep filter is broken
    // for a given status, the PR is excluded and the assertion below fails.
    const numbers = collectPrNumbers({
      payload: {},
      eventName: 'schedule',
      repository: 'nalfeo/Crawler',
      scheduledPulls: [pull],
      trainEnabled: true,
      now: nowDate,
    });
    assert.ok(
      numbers.includes(prNumber),
      `status=${status} must be reachable through schedule sweep`,
    );
  }
});

test('repair wake invariant: schedule sweep reaches ownerless idle/waiting states but excludes genuine waiting blockers', () => {
  const now = '2026-07-27T00:00:00Z';
  const idle = {
    number: 3201,
    state: 'open',
    draft: false,
    created_at: now,
    base: { ref: 'main' },
    labels: [{ name: 'ci-recovery-waiting' }],
    head: { repo: { full_name: 'nalfeo/Crawler' } },
    recoveryState: makeState({
      prNumber: 3201,
      headSha: 'head-3201',
      fingerprint: 'idle',
      owner: 'none',
      status: 'idle',
      trigger: 'stale-automation',
      blockers: [{ kind: 'ci-failure', id: 'ci', summary: 'CI failed' }],
      attempt: 1,
      updatedAt: now,
    }),
  };
  const waitingNoBlockers = {
    ...idle,
    number: 3202,
    recoveryState: makeState({
      prNumber: 3202,
      headSha: 'head-3202',
      fingerprint: 'waiting-no-blockers',
      owner: 'none',
      status: 'waiting',
      trigger: 'admission-wait',
      blockers: [],
      attempt: 0,
      updatedAt: now,
    }),
  };
  const waitingBlocked = {
    ...idle,
    number: 3203,
    recoveryState: makeState({
      prNumber: 3203,
      headSha: 'head-3203',
      fingerprint: 'waiting-blocked',
      owner: 'none',
      status: 'waiting',
      trigger: 'waiting',
      blockers: [{ kind: 'ci-failure', id: 'ci', summary: 'CI failed' }],
      attempt: 1,
      updatedAt: now,
    }),
  };

  const numbers = collectPrNumbers({
    payload: {},
    eventName: 'schedule',
    repository: 'nalfeo/Crawler',
    scheduledPulls: [idle, waitingNoBlockers, waitingBlocked],
    trainEnabled: true,
    now: new Date(now),
  });

  assert.ok(numbers.includes(3201), 'idle waiting PR should be repair-sweep reachable');
  assert.ok(
    numbers.includes(3202),
    'ownerless waiting+no-blockers PR should be repair-sweep reachable',
  );
  assert.ok(!numbers.includes(3203), 'genuine waiting-with-blockers PR should remain hidden');
});

test('repair window: waiting-transition PRs stay prioritized even when sweep backlog exceeds window', () => {
  const transitionA = {
    number: 3301,
    state: 'open',
    draft: false,
    created_at: '2026-07-01T00:00:00Z',
    base: { ref: 'main' },
    labels: [{ name: 'ci-recovery-waiting-transition' }],
    head: { repo: { full_name: 'nalfeo/Crawler' } },
  };
  const transitionB = {
    number: 3302,
    state: 'open',
    draft: false,
    created_at: '2026-07-02T00:00:00Z',
    base: { ref: 'main' },
    labels: [{ name: 'ci-recovery-waiting-transition' }],
    head: { repo: { full_name: 'nalfeo/Crawler' } },
  };
  const sweep = Array.from({ length: 6 }, (_, index) => ({
    number: 3310 + index,
    state: 'open',
    draft: false,
    created_at: `2026-07-${String(3 + index).padStart(2, '0')}T00:00:00Z`,
    base: { ref: 'main' },
    labels: [],
    head: { repo: { full_name: 'nalfeo/Crawler' } },
  }));

  const earlyWindow = collectPrNumbers({
    payload: {},
    eventName: 'schedule',
    repository: 'nalfeo/Crawler',
    scheduledPulls: [transitionA, transitionB, ...sweep],
    trainEnabled: true,
    now: new Date('2026-07-27T00:00:00Z'),
  });
  const rotatedWindow = collectPrNumbers({
    payload: {},
    eventName: 'schedule',
    repository: 'nalfeo/Crawler',
    scheduledPulls: [transitionA, transitionB, ...sweep],
    trainEnabled: true,
    now: new Date('2026-07-27T00:14:00Z'),
  });

  assert.ok(earlyWindow.includes(3301) && earlyWindow.includes(3302));
  assert.ok(rotatedWindow.includes(3301) && rotatedWindow.includes(3302));
  // Transitions must appear before sweep PRs regardless of rotation so that
  // partitionDispatchable() dispatches them first under backpressure.
  assert.equal(earlyWindow.indexOf(3301), 0, 'transitionA must be at position 0');
  assert.equal(earlyWindow.indexOf(3302), 1, 'transitionB must be at position 1');
  assert.equal(rotatedWindow.indexOf(3301), 0, 'transitionA at position 0 under rotation');
  assert.equal(rotatedWindow.indexOf(3302), 1, 'transitionB at position 1 under rotation');
  assert.equal(earlyWindow.length, 6);
  assert.equal(rotatedWindow.length, 6);
});

test('repair window: an explicitly dispatched conflict-fenced PR is still honored', () => {
  const fencedPr = {
    number: 2003,
    state: 'open',
    draft: false,
    created_at: '2026-07-01T00:00:00Z',
    base: { ref: 'main' },
    labels: [{ name: 'ci-conflict-order-wait' }],
    head: { repo: { full_name: 'nalfeo/Crawler' } },
  };

  const numbers = collectPrNumbers({
    payload: { pull_request: { number: 2003 } },
    eventName: 'pull_request_target',
    repository: 'nalfeo/Crawler',
    scheduledPulls: [fencedPr],
    maxDispatchPerRun: 8,
    trainEnabled: true,
  });

  assert.deepEqual(numbers, [2003]);
});

test('repair wake: an ownerless waiting PR with real blockers stays hidden', () => {
  const genuineWait = {
    number: 2079,
    state: 'open',
    draft: false,
    created_at: '2026-07-27T00:00:00Z',
    base: { ref: 'main' },
    labels: [{ name: 'ci-recovery-waiting' }],
    head: { repo: { full_name: 'nalfeo/Crawler' } },
    recoveryState: makeState({
      prNumber: 2079,
      headSha: 'head-2079',
      fingerprint: 'genuine-wait-fixture',
      owner: 'none',
      status: 'waiting',
      trigger: 'waiting',
      blockers: [{ kind: 'ci-failure', id: 'ci', summary: 'CI failed' }],
      attempt: 1,
      updatedAt: '2026-07-27T04:37:47Z',
    }),
  };

  assert.equal(isRepairWakeEligible(genuineWait), false);
});

test('flag-off schedule: all blocked label variants are excluded', () => {
  const blockedLabels = [
    'ci-conflict-order-wait',
    'ci-conflict-escalation',
    'merge-train-blocked',
    'merge-train-validation-failed',
    'human-approval-required',
    'ci-recovery-waiting',
  ];

  for (const labelName of blockedLabels) {
    const numbers = collectPrNumbers({
      payload: {},
      eventName: 'schedule',
      repository: 'nalfeo/Crawler',
      scheduledPulls: [
        {
          number: 1,
          draft: false,
          created_at: '2026-07-01T00:00:00Z',
          labels: [{ name: labelName }],
          head: { repo: { full_name: 'nalfeo/Crawler' } },
        },
        {
          number: 2,
          draft: false,
          created_at: '2026-07-02T00:00:00Z',
          labels: [],
          head: { repo: { full_name: 'nalfeo/Crawler' } },
        },
      ],
      maxDispatchPerRun: 8,
    });

    assert.ok(!numbers.includes(1), `PR with label "${labelName}" must be excluded`);
    assert.ok(numbers.includes(2), 'normal PR must still be included');
  }
});

test('flag-off schedule: CI-fix PRs are not identified by title text', () => {
  // Verify label-based detection: a PR with a CI-sounding title but no ci/ci-infra
  // label must NOT be classified as a CI-fix PR.
  const titleOnlyPr = {
    number: 1,
    draft: false,
    created_at: '2026-07-01T00:00:00Z',
    labels: [],
    title: 'fix(ci): improve pipeline performance',
    head: { repo: { full_name: 'nalfeo/Crawler' } },
  };
  const labeledCiPr = {
    number: 2,
    draft: false,
    created_at: '2026-07-02T00:00:00Z',
    labels: [{ name: 'ci' }],
    title: 'some other change',
    head: { repo: { full_name: 'nalfeo/Crawler' } },
  };
  const generalPr = {
    number: 3,
    draft: false,
    created_at: '2026-07-03T00:00:00Z',
    labels: [],
    head: { repo: { full_name: 'nalfeo/Crawler' } },
  };

  const numbers = collectPrNumbers({
    payload: {},
    eventName: 'schedule',
    repository: 'nalfeo/Crawler',
    scheduledPulls: [titleOnlyPr, labeledCiPr, generalPr],
    maxDispatchPerRun: 8,
  });

  // labeledCiPr comes first (CI-fix tier), then title-only and general PRs oldest-first.
  assert.deepEqual(numbers, [2, 1, 3]);
});

test('flag-off pull_request_target: blocked PR excluded even when directly triggered', () => {
  // Regression test for the reviewer concern: the blocked filter must apply
  // to ALL flag-off event paths, not only schedule/workflow_dispatch.
  // Uses pull_request_target (a real direct trigger event) where the PR
  // carries a blocked label that is present in scheduledPulls.
  const blockedPr = {
    number: 42,
    draft: false,
    created_at: '2026-07-01T00:00:00Z',
    labels: [{ name: 'human-approval-required' }],
    head: { repo: { full_name: 'nalfeo/Crawler' } },
  };

  const numbers = collectPrNumbers({
    payload: { pull_request: { number: 42 } },
    eventName: 'pull_request_target',
    repository: 'nalfeo/Crawler',
    scheduledPulls: [blockedPr],
    maxDispatchPerRun: 8,
  });

  assert.ok(
    !numbers.includes(42),
    'pull_request_target: directly-triggered blocked PR must be excluded',
  );
});

test('flag-off pull_request_target: unblocked PR is still dispatched', () => {
  // Complement to the exclusion test: an unblocked directly-triggered PR on
  // a pull_request_target event must pass through the filter unchanged.
  const normalPr = {
    number: 10,
    draft: false,
    created_at: '2026-07-01T00:00:00Z',
    labels: [],
    head: { repo: { full_name: 'nalfeo/Crawler' } },
  };

  const numbers = collectPrNumbers({
    payload: { pull_request: { number: 10 } },
    eventName: 'pull_request_target',
    repository: 'nalfeo/Crawler',
    scheduledPulls: [normalPr],
    maxDispatchPerRun: 8,
  });

  assert.ok(numbers.includes(10), 'pull_request_target: unblocked PR must be dispatched');
});

test('flag-off pull_request_target: PR absent from scheduledPulls passes through as unblocked', () => {
  // Safety fallback: a PR named by the event that is not yet in scheduledPulls
  // (e.g. just opened) must still be dispatched rather than silently dropped.
  const numbers = collectPrNumbers({
    payload: { pull_request: { number: 99 } },
    eventName: 'pull_request_target',
    repository: 'nalfeo/Crawler',
    scheduledPulls: [],
    maxDispatchPerRun: 8,
  });

  assert.ok(
    numbers.includes(99),
    'pull_request_target: PR not in scheduledPulls must pass through unblocked',
  );
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
      now: new Date(0),
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
      now: new Date(0),
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

test('repair-window sweeps re-include idle repair waits without widening genuine waits', () => {
  const repairableWait = {
    number: 42,
    state: 'open',
    draft: false,
    created_at: '2026-07-01T00:00:00Z',
    base: { ref: 'main' },
    head: { repo: { full_name: 'nalfeo/Crawler' } },
    labels: [{ name: 'ci-recovery-waiting' }],
    recoveryState: makeState({
      prNumber: 42,
      headSha: 'head-42',
      fingerprint: 'repair-window-gap',
      owner: 'none',
      status: 'idle',
      trigger: 'stale-automation',
      blockers: [{ kind: 'ci-failure', id: 'ci', summary: 'CI failed' }],
      attempt: 1,
      updatedAt: '2026-07-01T01:00:00Z',
    }),
  };
  const genuineWait = {
    ...repairableWait,
    number: 43,
    recoveryState: makeState({
      prNumber: 43,
      headSha: 'head-43',
      fingerprint: 'still-waiting',
      owner: 'none',
      status: 'waiting',
      trigger: 'waiting',
      blockers: [{ kind: 'ci-failure', id: 'ci', summary: 'CI failed' }],
      attempt: 1,
      updatedAt: '2026-07-01T01:00:00Z',
    }),
  };

  for (const [payload, eventName] of [
    [{}, 'schedule'],
    [
      {
        repository: { default_branch: 'main' },
        workflow_run: { name: 'CI', head_branch: 'main', pull_requests: [] },
      },
      'workflow_run',
    ],
  ]) {
    assert.deepEqual(
      collectPrNumbers({
        payload,
        eventName,
        repository: 'nalfeo/Crawler',
        scheduledPulls: [repairableWait, genuineWait],
        trainEnabled: true,
      }),
      [42],
    );
  }
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
      now: new Date(0),
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

  const result = collectPrNumbers({
    payload: {
      repository: { default_branch: 'main' },
      workflow_run: { name: 'CI', head_branch: 'main', pull_requests: [] },
    },
    eventName: 'workflow_run',
    repository: 'nalfeo/Crawler',
    scheduledPulls: pulls,
    trainEnabled: true,
    now: new Date('2026-07-17T12:10:00.000Z'),
  });
  // Verify the healthy-owner PR is excluded; order is rotation-based so compare as a set.
  assert.deepEqual(
    [...result].sort((a, b) => a - b),
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

  // Order is rotation-based; compare as a sorted set.
  const scheduleResult = collectPrNumbers({
    payload: {},
    eventName: 'schedule',
    repository: 'nalfeo/Crawler',
    scheduledPulls: [healthy, stale, inconsistent],
    trainEnabled: true,
    now: new Date('2026-07-17T12:10:00.000Z'),
  });
  assert.deepEqual(
    [...scheduleResult].sort((a, b) => a - b),
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
    `${STATE_DATA_PREFIX}x -->\nstate-data`,
    `${TASK_COMMENT_MARKER} fingerprint=x -->\ntask`,
    `${CI_INCIDENT_MARKER}\nincident`,
    '<!-- crawler-ci-state:v1 -->\nstate',
    '<!-- crawler-merge-train:v1 -->\nstatus',
    `${MERGE_TRAIN_LANDED_MARKER}\nlanded`,
    `${MERGE_TRAIN_EMPTY_INCIDENT_MARKER}\nempty-train-incident`,
    '<!-- crawler-review-request:v1 head=x reason=ready -->',
    '<!-- crawler-review-conflict:v1 episode=x head=y base=z -->',
    `${LIFECYCLE_DATA_PREFIX}x -->\nlifecycle-data`,
    '<!-- crawler-pr-lifecycle:v1 -->\nlifecycle',
    `${COORDINATOR_DATA_PREFIX}x -->\ncoordinator-data`,
    '<!-- crawler-ci-conflict-coordinator:v1 -->\ncoordinator',
    `${LOOP_INCIDENT_MARKER}\nloop-incident`,
    `${LOOP_INCIDENT_FINGERPRINT_PREFIX}x -->\nloop-fingerprint`,
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
  // All managed-comment markers start with '<!-- crawler-' (MANAGED_COMMENT_PREFIX).
  // The YAML filter uses a single prefix check so new markers are covered
  // automatically without editing the workflow file.
  assert.ok(
    routeJob.if.includes(`!startsWith(github.event.comment.body, '${MANAGED_COMMENT_PREFIX}')`),
    `expected job guard to use the shared managed-comment prefix '${MANAGED_COMMENT_PREFIX}'`,
  );
  // Every marker in MANAGED_COMMENT_MARKERS must satisfy the shared prefix.
  for (const marker of MANAGED_COMMENT_MARKERS) {
    assert.ok(
      marker.startsWith(MANAGED_COMMENT_PREFIX),
      `marker '${marker}' does not start with MANAGED_COMMENT_PREFIX '${MANAGED_COMMENT_PREFIX}'`,
    );
  }
});

test('managed marker inventory covers every exported managed marker string exactly once', async () => {
  const markerModule = await import('./markers.mjs');
  const exportedManagedMarkers = Object.entries(markerModule)
    .filter(
      ([name, value]) =>
        name !== 'MANAGED_COMMENT_PREFIX' &&
        typeof value === 'string' &&
        value.startsWith(MANAGED_COMMENT_PREFIX),
    )
    .map(([, value]) => value)
    .sort();
  assert.deepEqual([...new Set(MANAGED_COMMENT_MARKERS)].sort(), exportedManagedMarkers);
});

test('router listens only for completed CI workflow runs', () => {
  assert.deepEqual(workflow.on.workflow_run.types, ['completed']);
});

test('router workflow exposes runtime-tunable dispatch-cap env knobs with invariant defaults', () => {
  const env =
    routeJob.steps.find((step) => step.name === 'Dispatch per-PR reconciliation')?.env ?? {};
  assert.equal(
    env.CI_RECOVERY_MAX_DISPATCH_BUDGET_TRAIN_BUSY,
    "${{ vars.CI_RECOVERY_MAX_DISPATCH_BUDGET_TRAIN_BUSY || '5' }}",
  );
  assert.equal(
    env.CI_RECOVERY_MAX_DISPATCH_BUDGET_TRAIN_IDLE,
    "${{ vars.CI_RECOVERY_MAX_DISPATCH_BUDGET_TRAIN_IDLE || '8' }}",
  );
  assert.equal(
    env.CI_RECOVERY_GLOBAL_TRAIN_DISPATCH_CAP,
    "${{ vars.CI_RECOVERY_GLOBAL_TRAIN_DISPATCH_CAP || '5' }}",
  );
  assert.equal(
    env.CI_RECOVERY_MAX_DISPATCH_PER_RUN,
    "${{ vars.CI_RECOVERY_MAX_DISPATCH_PER_RUN || '8' }}",
  );
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

test('resolveGlobalDispatchCaps enforces positive-int parsing with invariant defaults (5/8/5/8)', () => {
  assert.deepEqual(pickInvariantDispatchCaps(resolveGlobalDispatchCaps({})), {
    maxBudgetTrainBusy: 5,
    maxBudgetTrainIdle: 8,
    globalTrainDispatchCap: 5,
    maxDispatchPerRun: 8,
  });
  assert.deepEqual(
    pickInvariantDispatchCaps(
      resolveGlobalDispatchCaps({
        CI_RECOVERY_MAX_DISPATCH_BUDGET_TRAIN_BUSY: ' 7 ',
        CI_RECOVERY_MAX_DISPATCH_BUDGET_TRAIN_IDLE: '9',
        CI_RECOVERY_GLOBAL_TRAIN_DISPATCH_CAP: '3',
        CI_RECOVERY_MAX_DISPATCH_PER_RUN: '11',
      }),
    ),
    {
      maxBudgetTrainBusy: 7,
      maxBudgetTrainIdle: 9,
      globalTrainDispatchCap: 3,
      maxDispatchPerRun: 11,
    },
  );
  assert.deepEqual(
    pickInvariantDispatchCaps(
      resolveGlobalDispatchCaps({
        CI_RECOVERY_MAX_DISPATCH_BUDGET_TRAIN_BUSY: '7garbage',
        CI_RECOVERY_MAX_DISPATCH_BUDGET_TRAIN_IDLE: '1.5',
        CI_RECOVERY_GLOBAL_TRAIN_DISPATCH_CAP: '1e2',
        CI_RECOVERY_MAX_DISPATCH_PER_RUN: '9007199254740993',
      }),
    ),
    {
      maxBudgetTrainBusy: 5,
      maxBudgetTrainIdle: 8,
      globalTrainDispatchCap: 5,
      maxDispatchPerRun: 8,
    },
  );
  assert.deepEqual(
    pickInvariantDispatchCaps(
      resolveGlobalDispatchCaps({
        CI_RECOVERY_MAX_DISPATCH_BUDGET_TRAIN_BUSY: '0',
        CI_RECOVERY_MAX_DISPATCH_BUDGET_TRAIN_IDLE: '-1',
        CI_RECOVERY_GLOBAL_TRAIN_DISPATCH_CAP: 'nope',
        CI_RECOVERY_MAX_DISPATCH_PER_RUN: '',
      }),
    ),
    {
      maxBudgetTrainBusy: 5,
      maxBudgetTrainIdle: 8,
      globalTrainDispatchCap: 5,
      maxDispatchPerRun: 8,
    },
  );
});

test('computeDispatchBudget never returns Infinity -- idle cap is always finite, including when the merge-train feature is disabled', () => {
  // Regression: computeDispatchBudget must never open the budget to Infinity
  // (the old pre-backpressure behaviour). Train disabled/paused collapses to
  // trainQueueNonEmpty=false; this proves the same finite budget holds.
  const budget = computeDispatchBudget({ trainQueueNonEmpty: false, outstandingCount: 0 });
  assert.ok(Number.isFinite(budget), `budget must be finite but got ${budget}`);
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

test('computeDispatchBudget accepts explicit trainCap/idleCap overrides', () => {
  // Verifies that the env-driven override path works end-to-end: both caps can
  // be independently overridden and the function uses them rather than the
  // module-level defaults.
  // headroom=20-9-0-0=11, min(trainCap=3, 11)=3 (not default max 5)
  assert.equal(
    computeDispatchBudget({
      trainQueueNonEmpty: true,
      outstandingCount: 0,
      trainCap: 3,
      idleCap: 10,
    }),
    3,
  );
  // headroom=20-3-0-0=17, min(idleCap=10, 17)=10 (not default max 8)
  assert.equal(
    computeDispatchBudget({
      trainQueueNonEmpty: false,
      outstandingCount: 0,
      trainCap: 3,
      idleCap: 10,
    }),
    10,
  );
  // headroom=20-9-0-3=8, min(trainCap=3, 8)=3 (outstanding reduces headroom, not the cap)
  assert.equal(
    computeDispatchBudget({
      trainQueueNonEmpty: true,
      outstandingCount: 3,
      trainCap: 3,
      idleCap: 10,
    }),
    3,
  );
  // headroom=20-3-0-7=10, min(idleCap=10, 10)=10
  assert.equal(
    computeDispatchBudget({
      trainQueueNonEmpty: false,
      outstandingCount: 7,
      trainCap: 3,
      idleCap: 10,
    }),
    10,
  );
  // headroom=20-3-0-10=7, min(idleCap=10, 7)=7 (headroom-capped below idleCap)
  assert.equal(
    computeDispatchBudget({
      trainQueueNonEmpty: false,
      outstandingCount: 10,
      trainCap: 3,
      idleCap: 10,
    }),
    7,
  );
  // headroom=20-9-0-11=0, budget floors at 0
  assert.equal(
    computeDispatchBudget({
      trainQueueNonEmpty: true,
      outstandingCount: 11,
      trainCap: 3,
      idleCap: 10,
    }),
    0,
  );
});

test('resolveGlobalDispatchCaps falls back to hardcoded defaults when env vars are absent', () => {
  assert.deepEqual(pickLegacyDispatchCaps(resolveGlobalDispatchCaps({})), {
    trainCap: GLOBAL_TRAIN_DISPATCH_CAP,
    idleCap: GLOBAL_IDLE_TRAIN_DISPATCH_CAP,
  });
});

test('resolveGlobalDispatchCaps reads CI_GLOBAL_TRAIN_DISPATCH_CAP from env', () => {
  assert.deepEqual(
    pickLegacyDispatchCaps(resolveGlobalDispatchCaps({ CI_GLOBAL_TRAIN_DISPATCH_CAP: '10' })),
    {
      trainCap: 10,
      idleCap: GLOBAL_IDLE_TRAIN_DISPATCH_CAP,
    },
  );
});

test('resolveGlobalDispatchCaps reads CI_GLOBAL_IDLE_TRAIN_DISPATCH_CAP from env', () => {
  assert.deepEqual(
    pickLegacyDispatchCaps(resolveGlobalDispatchCaps({ CI_GLOBAL_IDLE_TRAIN_DISPATCH_CAP: '7' })),
    {
      trainCap: GLOBAL_TRAIN_DISPATCH_CAP,
      idleCap: 7,
    },
  );
});

test('resolveGlobalDispatchCaps reads both caps independently from env', () => {
  assert.deepEqual(
    pickLegacyDispatchCaps(
      resolveGlobalDispatchCaps({
        CI_GLOBAL_TRAIN_DISPATCH_CAP: '8',
        CI_GLOBAL_IDLE_TRAIN_DISPATCH_CAP: '12',
      }),
    ),
    { trainCap: 8, idleCap: 12 },
  );
});

test('resolveGlobalDispatchCaps ignores non-positive and non-numeric env values', () => {
  assert.deepEqual(
    pickLegacyDispatchCaps(resolveGlobalDispatchCaps({ CI_GLOBAL_TRAIN_DISPATCH_CAP: 'bad' })),
    {
      trainCap: GLOBAL_TRAIN_DISPATCH_CAP,
      idleCap: GLOBAL_IDLE_TRAIN_DISPATCH_CAP,
    },
  );
  assert.deepEqual(
    pickLegacyDispatchCaps(resolveGlobalDispatchCaps({ CI_GLOBAL_TRAIN_DISPATCH_CAP: '0' })),
    {
      trainCap: GLOBAL_TRAIN_DISPATCH_CAP,
      idleCap: GLOBAL_IDLE_TRAIN_DISPATCH_CAP,
    },
  );
  assert.deepEqual(
    pickLegacyDispatchCaps(resolveGlobalDispatchCaps({ CI_GLOBAL_IDLE_TRAIN_DISPATCH_CAP: '-1' })),
    {
      trainCap: GLOBAL_TRAIN_DISPATCH_CAP,
      idleCap: GLOBAL_IDLE_TRAIN_DISPATCH_CAP,
    },
  );
});

test('resolveGlobalDispatchCaps: strict parse rejects trailing non-digit chars (e.g. "10oops")', () => {
  // Number.parseInt("10oops") = 10, which would silently accept a malformed value.
  // parseClampedPositiveInt requires purely-digit strings to prevent operator typos
  // from silently accepting a partial value.
  assert.deepEqual(
    pickLegacyDispatchCaps(resolveGlobalDispatchCaps({ CI_GLOBAL_TRAIN_DISPATCH_CAP: '10oops' })),
    {
      trainCap: GLOBAL_TRAIN_DISPATCH_CAP,
      idleCap: GLOBAL_IDLE_TRAIN_DISPATCH_CAP,
    },
  );
  assert.deepEqual(
    pickLegacyDispatchCaps(
      resolveGlobalDispatchCaps({ CI_GLOBAL_IDLE_TRAIN_DISPATCH_CAP: '5bad' }),
    ),
    {
      trainCap: GLOBAL_TRAIN_DISPATCH_CAP,
      idleCap: GLOBAL_IDLE_TRAIN_DISPATCH_CAP,
    },
  );
});

test('resolveGlobalDispatchCaps: out-of-range values are clamped to runner-safety ceilings', () => {
  // Train cap documented safe max = 10 (ci-config-knobs.md).
  // Values above are clamped rather than rejected so the operator gets bounded
  // protection instead of a silent fallback that could be lower than intended.
  assert.deepEqual(
    pickLegacyDispatchCaps(resolveGlobalDispatchCaps({ CI_GLOBAL_TRAIN_DISPATCH_CAP: '999' })),
    {
      trainCap: 10,
      idleCap: GLOBAL_IDLE_TRAIN_DISPATCH_CAP,
    },
  );
  assert.deepEqual(
    pickLegacyDispatchCaps(resolveGlobalDispatchCaps({ CI_GLOBAL_TRAIN_DISPATCH_CAP: '11' })),
    {
      trainCap: 10,
      idleCap: GLOBAL_IDLE_TRAIN_DISPATCH_CAP,
    },
  );
  // Idle cap documented safe max = 20 (ci-config-knobs.md).
  assert.deepEqual(
    pickLegacyDispatchCaps(resolveGlobalDispatchCaps({ CI_GLOBAL_IDLE_TRAIN_DISPATCH_CAP: '999' })),
    {
      trainCap: GLOBAL_TRAIN_DISPATCH_CAP,
      idleCap: 20,
    },
  );
  assert.deepEqual(
    pickLegacyDispatchCaps(resolveGlobalDispatchCaps({ CI_GLOBAL_IDLE_TRAIN_DISPATCH_CAP: '21' })),
    {
      trainCap: GLOBAL_TRAIN_DISPATCH_CAP,
      idleCap: 20,
    },
  );
  // Values at the max boundary pass through unchanged.
  assert.deepEqual(
    pickLegacyDispatchCaps(resolveGlobalDispatchCaps({ CI_GLOBAL_TRAIN_DISPATCH_CAP: '10' })),
    {
      trainCap: 10,
      idleCap: GLOBAL_IDLE_TRAIN_DISPATCH_CAP,
    },
  );
  assert.deepEqual(
    pickLegacyDispatchCaps(resolveGlobalDispatchCaps({ CI_GLOBAL_IDLE_TRAIN_DISPATCH_CAP: '20' })),
    {
      trainCap: GLOBAL_TRAIN_DISPATCH_CAP,
      idleCap: 20,
    },
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

test('SWEEP_WORKFLOW_FILES counts every runner-saturating sweep workflow', () => {
  // Regression guard for the weapon-sweep pressure gap: weapon-sweep.yml runs on
  // the shared standard-hosted pool and fans its weapon×shard matrix to ~24
  // concurrent jobs, so it must contribute to sweep pressure exactly like the AI
  // sweeps. Omitting it lets an in-progress weapon sweep report zero sweep
  // pressure and re-open the dispatch headroom this budget exists to reserve.
  assert.ok(
    SWEEP_WORKFLOW_FILES.includes('ai-sweep.yml'),
    'ai-sweep.yml must be a measured sweep-pressure source',
  );
  assert.ok(
    SWEEP_WORKFLOW_FILES.includes('ai-sweep-recover.yml'),
    'ai-sweep-recover.yml must be a measured sweep-pressure source',
  );
  assert.ok(
    SWEEP_WORKFLOW_FILES.includes('weapon-sweep.yml'),
    'weapon-sweep.yml must be a measured sweep-pressure source',
  );
});

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

test('runFromEnv respects runtime busy/global caps under a simulated schedule burst', async (t) => {
  const OWNER = 'test-owner';
  const REPO = 'test-repo';
  const TOKEN = 'x-test-token';
  const dispatches = [];
  const scheduledPulls = Array.from({ length: 10 }, (_, i) => ({
    number: i + 1,
    state: 'open',
    draft: false,
    base: { ref: 'main' },
    created_at: `2026-07-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    labels: i === 0 ? [{ name: 'merge-train' }] : [],
    head: { sha: `head-${i + 1}`, repo: { full_name: `${OWNER}/${REPO}` } },
  }));
  let visibleRuns = 0;

  const { server, port } = await startRouterMockServer({
    [`GET /repos/${OWNER}/${REPO}/pulls`]: () => ({ body: scheduledPulls }),
    [`GET /repos/${OWNER}/${REPO}/actions/workflows/ci-recovery.yml/runs`]: (url) => {
      const parsed = new URL(`http://127.0.0.1${url}`);
      const status = parsed.searchParams.get('status');
      if (status) {
        return { body: { total_count: 0, workflow_runs: [] } };
      }
      return {
        body: {
          total_count: visibleRuns,
          workflow_runs: Array.from({ length: visibleRuns }, (_, index) => ({
            id: index + 1,
            status: 'in_progress',
          })),
        },
      };
    },
    [`POST /repos/${OWNER}/${REPO}/actions/workflows/ci-recovery.yml/dispatches`]: (_url, body) => {
      dispatches.push(body?.inputs ?? {});
      visibleRuns = dispatches.length;
      return { status: 204 };
    },
  });
  t.after(() => server.close());

  const eventDir = await mkdtemp(join(tmpdir(), 'router-burst-'));
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
    CI_RECOVERY_MAX_DISPATCH_BUDGET_TRAIN_BUSY: '7',
    CI_RECOVERY_GLOBAL_TRAIN_DISPATCH_CAP: '3',
    CI_RECOVERY_MAX_DISPATCH_PER_RUN: '8',
  });
  if (!assertRouterExit(t, code, stderr)) return;

  assert.equal(
    dispatches.length,
    3,
    `busy budget must be clamped by global cap; stdout: ${stdout}`,
  );
  assert.match(
    stdout,
    /dispatch cap applied sent=3 total_eligible=10 cap=8 budget=3 outstanding=0/,
    `expected run output to show the bounded budget; stdout: ${stdout}`,
  );
});

test('runFromEnv hydrates waiting/no-owner candidates and dispatches repair wake via schedule', async (t) => {
  // Exercises the waiting-candidate hydration pass added in runFromEnv:
  // a PR that carries only ci-recovery-waiting (no owner label, no
  // waiting-transition) with a persisted idle/no-owner recovery state must be
  // loaded from comments and re-surfaced by the repair-window sweep so the
  // existing reconcile path can reacquire it.  This is the end-to-end
  // production subprocess path that pure unit tests cannot cover because they
  // inject recoveryState manually and skip the HTTP hydration step.
  const OWNER = 'test-owner';
  const REPO = 'test-repo';
  const TOKEN = 'x-test-token';
  const updatedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  // PR #20: ci-recovery-waiting, no owner label, no waiting-transition label.
  // Its state comment records owner=none,status=idle → should become
  // repair-wake-eligible after the new hydration pass loads the comment.
  const pr20 = {
    number: 20,
    state: 'open',
    draft: false,
    base: { ref: 'main' },
    created_at: '2026-07-01T00:00:00Z',
    labels: [{ name: 'ci-recovery-waiting' }],
    head: { sha: 'head-20', repo: { full_name: `${OWNER}/${REPO}` } },
  };

  const idleStateComment = {
    id: 1,
    body: renderStateComment(
      makeState({
        prNumber: 20,
        headSha: 'head-20',
        fingerprint: 'repair-gap-fixture',
        owner: 'none',
        status: 'idle',
        trigger: 'stale-automation',
        blockers: [{ kind: 'ci-failure', id: 'ci', summary: 'CI failed' }],
        attempt: 1,
        updatedAt,
      }),
    ),
  };

  const dispatches = [];
  const commentRequestsFor20 = [];
  let visibleRuns = 0;

  const { server, port } = await startRouterMockServer({
    [`GET /repos/${OWNER}/${REPO}/pulls`]: () => ({ body: [pr20] }),
    [`GET /repos/${OWNER}/${REPO}/issues/20/comments`]: () => {
      commentRequestsFor20.push(1);
      return { body: [idleStateComment] };
    },
    [`GET /repos/${OWNER}/${REPO}/actions/workflows/ci-recovery.yml/runs`]: (url) => {
      const parsed = new URL(`http://127.0.0.1${url}`);
      if (parsed.searchParams.get('status')) {
        // countOutstandingWorkflowRuns: 0 outstanding → positive dispatch budget
        return { body: { total_count: 0, workflow_runs: [] } };
      }
      // listRecentOutstandingRunIds (per_page=100): return newly visible runs
      // after dispatch so waitForDispatchedRunsVisible converges immediately.
      return {
        body: {
          workflow_runs: Array.from({ length: visibleRuns }, (_, index) => ({
            id: index + 1,
            status: 'queued',
          })),
        },
      };
    },
    [`POST /repos/${OWNER}/${REPO}/actions/workflows/ci-recovery.yml/dispatches`]: (_url, body) => {
      dispatches.push(body?.inputs ?? {});
      visibleRuns = dispatches.length;
      return { status: 204 };
    },
  });
  t.after(() => server.close());

  const eventDir = await mkdtemp(join(tmpdir(), 'router-repair-wake-'));
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

  // (a) The router fetched PR #20's comments to evaluate isRepairWakeEligible.
  assert.ok(
    commentRequestsFor20.length >= 1,
    `comments for PR #20 must be fetched during the waiting-candidate hydration pass; stdout: ${stdout}`,
  );

  // (b) PR #20 must be dispatched by the normal repair loop (not the reaper,
  // which only targets owner-labeled PRs).
  const repairDispatches = dispatches.filter((inputs) => inputs.trigger !== 'lease-reaper');
  assert.equal(
    repairDispatches.length,
    1,
    `exactly one repair dispatch expected for idle waiting PR #20; stdout: ${stdout}`,
  );
  assert.equal(repairDispatches[0].pr_number, '20', 'repair-wake PR #20 must be dispatched');
  assert.match(
    stdout,
    /dispatched pr=#20/,
    `dispatch log line expected for PR #20; stdout: ${stdout}`,
  );
});
