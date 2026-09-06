import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import YAML from 'yaml';

import {
  buildDispatchLivenessIncidentBody,
  collectRecentWorkflowDispatchRuns,
  collectRecentReconcileHarvestRuns,
  DEFAULT_HARVEST_THRESHOLD_MINUTES,
  DEFAULT_DISPATCH_LIVENESS_WINDOW_HOURS,
  DEFAULT_PR_DISPATCH_GAP_HOURS,
  DEFAULT_LIVENESS_REDISPATCH_CAP,
  DISPATCH_LIVENESS_INCIDENT_LABEL,
  DISPATCH_LIVENESS_INCIDENT_MARKER,
  DISPATCH_LIVENESS_INCIDENT_TITLE,
  HARVEST_INCIDENT_LABEL,
  HARVEST_INCIDENT_MARKER,
  HARVEST_INCIDENT_TITLE,
  buildHarvestIncidentBody,
  evaluateHarvestLiveness,
  isReconcileHarvestRun,
  parseDecisionRecords,
  reconcileDispatchLivenessIncident,
  reconcileHarvestIncident,
  summarizeDispatchLiveness,
  summarizeHarvestRuns,
  selectLivenessRedispatchCandidates,
  protectedLivenessPullNumbers,
  dispatchLivenessRedispatches,
  parsePositiveIntEnv,
} from './harvest-liveness.mjs';

const NOW = new Date('2026-07-30T17:00:00Z');

function run(overrides = {}) {
  return {
    status: 'completed',
    conclusion: 'success',
    updated_at: NOW.toISOString(),
    html_url: 'https://github.com/nalfeo/Crawler/actions/runs/1',
    ...overrides,
  };
}

test('summarizeHarvestRuns picks the most recent successful run', () => {
  const summary = summarizeHarvestRuns(
    [
      run({ conclusion: 'failure', updated_at: '2026-07-30T16:50:00Z' }),
      run({ updated_at: '2026-07-30T16:30:00Z', html_url: 'https://example.test/ok' }),
      run({ updated_at: '2026-07-30T15:00:00Z' }),
    ],
    NOW,
  );

  assert.equal(summary.lastSuccessAt, '2026-07-30T16:30:00.000Z');
  assert.equal(summary.lastSuccessUrl, 'https://example.test/ok');
  assert.equal(summary.minutesSinceSuccess, 30);
  assert.equal(summary.consecutiveFailures, 1);
});

test('summarizeHarvestRuns ignores in-progress runs', () => {
  const summary = summarizeHarvestRuns(
    [run({ status: 'in_progress', conclusion: null }), run({ updated_at: '2026-07-30T16:00:00Z' })],
    NOW,
  );

  assert.equal(summary.completedCount, 1);
  assert.equal(summary.minutesSinceSuccess, 60);
});

// The reconciler's `queue: single` concurrency cancelled post-merge passes
// during the 2026-07-30 stoppage. A cancelled run is a non-completing harvest,
// not a healthy one.
test('summarizeHarvestRuns counts cancelled and timed-out runs as failures', () => {
  const summary = summarizeHarvestRuns(
    [
      run({ conclusion: 'cancelled', updated_at: '2026-07-30T16:55:00Z' }),
      run({ conclusion: 'timed_out', updated_at: '2026-07-30T16:50:00Z' }),
      run({ conclusion: 'startup_failure', updated_at: '2026-07-30T16:45:00Z' }),
      run({ updated_at: '2026-07-30T16:40:00Z' }),
      run({ conclusion: 'failure', updated_at: '2026-07-30T16:00:00Z' }),
    ],
    NOW,
  );

  // Only failures newer than the last success count; the older one does not.
  assert.equal(summary.consecutiveFailures, 3);
  assert.equal(summary.lastSuccessAt, '2026-07-30T16:40:00.000Z');
});

test('summarizeHarvestRuns tolerates empty and malformed input', () => {
  assert.equal(summarizeHarvestRuns([], NOW).completedCount, 0);
  assert.equal(summarizeHarvestRuns(undefined, NOW).completedCount, 0);
  assert.equal(summarizeHarvestRuns([run({ updated_at: 'not-a-date' })], NOW).completedCount, 0);
  assert.equal(summarizeHarvestRuns([], NOW).minutesSinceSuccess, null);
});

test('isReconcileHarvestRun matches reconcile operation display titles only', () => {
  assert.equal(
    isReconcileHarvestRun({ display_title: 'CI Recovery (reconcile) for PR #123' }),
    true,
  );
  assert.equal(
    isReconcileHarvestRun({ display_title: 'CI Recovery (lease-heartbeat) for PR #123' }),
    false,
  );
});

test('collectRecentReconcileHarvestRuns filters to reconcile runs and paginates to threshold window', async () => {
  const calls = [];
  const pages = {
    1: [
      run({
        display_title: 'CI Recovery (lease-heartbeat) for PR #10',
        updated_at: '2026-07-30T16:59:00Z',
      }),
      run({
        display_title: 'CI Recovery (reconcile) for PR #10',
        updated_at: '2026-07-30T16:58:00Z',
      }),
    ],
    2: [
      run({
        display_title: 'CI Recovery (reconcile) for PR #11',
        updated_at: '2026-07-30T15:50:00Z',
      }),
    ],
  };
  const collected = await collectRecentReconcileHarvestRuns({
    owner: 'nalfeo',
    repo: 'Crawler',
    thresholdMinutes: 60,
    now: NOW,
    perPage: 2,
    listWorkflowRuns: async (params) => {
      calls.push(params);
      return { data: { workflow_runs: pages[params.page] || [] } };
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].event, 'workflow_dispatch');
  assert.deepEqual(
    collected.map((item) => item.display_title),
    ['CI Recovery (reconcile) for PR #10', 'CI Recovery (reconcile) for PR #11'],
  );
});

test('collectRecentWorkflowDispatchRuns paginates only until cutoff and supports filtering', async () => {
  const calls = [];
  const pages = {
    1: [
      run({
        display_title: 'CI Recovery (reconcile) for PR #10',
        updated_at: '2026-07-30T16:58:00Z',
      }),
      run({
        display_title: 'CI Recovery (lease-heartbeat) for PR #10',
        updated_at: '2026-07-30T16:57:00Z',
      }),
    ],
    2: [
      run({
        display_title: 'CI Recovery (reconcile) for PR #11',
        updated_at: '2026-07-30T07:58:00Z',
      }),
    ],
  };
  const collected = await collectRecentWorkflowDispatchRuns({
    owner: 'nalfeo',
    repo: 'Crawler',
    workflowId: 'ci-recovery.yml',
    cutoffMs: new Date('2026-07-30T08:00:00Z').getTime(),
    perPage: 2,
    filter: (item) => item.display_title.includes('(reconcile)'),
    listWorkflowRuns: async (params) => {
      calls.push(params);
      return { data: { workflow_runs: pages[params.page] || [] } };
    },
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(
    collected.map((item) => item.display_title),
    ['CI Recovery (reconcile) for PR #10', 'CI Recovery (reconcile) for PR #11'],
  );
});

test('evaluateHarvestLiveness stays quiet when there is no open backlog', () => {
  const summary = summarizeHarvestRuns([], NOW);
  const verdict = evaluateHarvestLiveness({ summary, backlogCount: 0 });

  assert.equal(verdict.stalled, false);
  assert.equal(verdict.reason, 'no-open-backlog');
});

test('evaluateHarvestLiveness is healthy when a recent success exists', () => {
  const summary = summarizeHarvestRuns([run({ updated_at: '2026-07-30T16:55:00Z' })], NOW);
  const verdict = evaluateHarvestLiveness({ summary, backlogCount: 21 });

  assert.equal(verdict.stalled, false);
  assert.equal(verdict.reason, 'healthy');
});

// The exact 2026-07-30 shape: the sweep kept dispatching, every run 403'd, and
// no successful harvest had completed for ~7 hours while 21 PRs waited.
test('evaluateHarvestLiveness alarms when every run fails with backlog waiting', () => {
  const summary = summarizeHarvestRuns(
    [
      run({ conclusion: 'failure', updated_at: '2026-07-30T16:50:00Z' }),
      run({ conclusion: 'failure', updated_at: '2026-07-30T16:40:00Z' }),
    ],
    NOW,
  );
  const verdict = evaluateHarvestLiveness({ summary, backlogCount: 21 });

  assert.equal(verdict.stalled, true);
  assert.equal(verdict.reason, 'no-successful-run-in-window');
});

test('evaluateHarvestLiveness alarms when the last success is older than the threshold', () => {
  const summary = summarizeHarvestRuns([run({ updated_at: '2026-07-30T09:42:00Z' })], NOW);
  const verdict = evaluateHarvestLiveness({ summary, backlogCount: 21 });

  assert.equal(verdict.stalled, true);
  assert.equal(verdict.reason, 'last-success-older-than-threshold');
  assert.ok(summary.minutesSinceSuccess >= DEFAULT_HARVEST_THRESHOLD_MINUTES);
});

test('evaluateHarvestLiveness alarms when no runs completed at all', () => {
  const verdict = evaluateHarvestLiveness({
    summary: summarizeHarvestRuns([], NOW),
    backlogCount: 5,
  });

  assert.equal(verdict.stalled, true);
  assert.equal(verdict.reason, 'no-completed-runs-in-window');
});

test('evaluateHarvestLiveness honours a custom threshold', () => {
  const summary = summarizeHarvestRuns([run({ updated_at: '2026-07-30T16:40:00Z' })], NOW);

  assert.equal(evaluateHarvestLiveness({ summary, backlogCount: 3 }).stalled, false);
  assert.equal(
    evaluateHarvestLiveness({ summary, backlogCount: 3, thresholdMinutes: 15 }).stalled,
    true,
  );
});

test('parseDecisionRecords extracts structured CI_RECOVERY_DECISION lines', () => {
  const records = parseDecisionRecords(
    [
      'noise line',
      'CI_RECOVERY_DECISION {"pr":2414,"ts":"2026-07-31T00:00:00.000Z","stage":"terminal","action":"skip-merge-train-owned"}',
      'CI_RECOVERY_DECISION {"pr":2415,"ts":"2026-07-31T00:05:00.000Z","stage":"terminal","action":"dispatch-copilot"}',
      'CI_RECOVERY_DECISION not-json',
    ].join('\n'),
  );
  assert.equal(records.length, 2);
  assert.equal(records[0].pr, 2414);
  assert.equal(records[1].action, 'dispatch-copilot');
});

test('parseDecisionRecords accepts timestamp-prefixed workflow log lines', () => {
  const records = parseDecisionRecords(
    [
      '2026-07-31T00:00:00.1234567Z CI_RECOVERY_DECISION {"pr":2414,"ts":"2026-07-31T00:00:00.000Z","stage":"terminal","action":"wait-admission"}',
      '2026-07-31T00:00:01.1234567Z CI_RECOVERY_DECISION {"pr":2415,"ts":"2026-07-31T00:05:00.000Z","stage":"terminal","action":"dispatch-copilot"}',
    ].join('\n'),
  );
  assert.equal(records.length, 2);
  assert.equal(records[0].action, 'wait-admission');
  assert.equal(records[1].pr, 2415);
});

test('summarizeDispatchLiveness alarms when only skip/no-op decisions exist while blocked PRs are open', () => {
  const summary = summarizeDispatchLiveness({
    now: NOW,
    windowHours: 8,
    perPrGapHours: 4,
    decisions: [
      {
        pr: 2414,
        ts: '2026-07-30T12:50:00.000Z',
        stage: 'terminal',
        action: 'skip-merge-train-owned',
      },
      {
        pr: 2414,
        ts: '2026-07-30T13:30:00.000Z',
        stage: 'terminal',
        action: 'skip-duplicate-fingerprint',
      },
    ],
    openBlockedPulls: [
      {
        number: 2414,
        html_url: 'https://github.com/nalfeo/Crawler/pull/2414',
        blocked_since: '2026-07-30T11:00:00.000Z',
      },
    ],
  });

  assert.equal(summary.stalled, true);
  assert.equal(summary.reason, 'no-dispatches-and-per-pr-gap');
  assert.equal(summary.dispatchCount, 0);
  assert.equal(summary.neverSummonedBlockedPulls.length, 1);
  assert.deepEqual(summary.nonDispatchHistogram, [
    ['skip-merge-train-owned', 1],
    ['skip-duplicate-fingerprint', 1],
  ]);
});

test('summarizeDispatchLiveness stays healthy when dispatches are present for blocked PRs', () => {
  const summary = summarizeDispatchLiveness({
    now: NOW,
    windowHours: DEFAULT_DISPATCH_LIVENESS_WINDOW_HOURS,
    perPrGapHours: DEFAULT_PR_DISPATCH_GAP_HOURS,
    decisions: [
      {
        pr: 2414,
        ts: '2026-07-30T16:30:00.000Z',
        stage: 'terminal',
        action: 'dispatch-copilot',
      },
      {
        pr: 2414,
        ts: '2026-07-30T16:40:00.000Z',
        stage: 'terminal',
        action: 'wait-admission',
      },
    ],
    openBlockedPulls: [
      {
        number: 2414,
        html_url: 'https://github.com/nalfeo/Crawler/pull/2414',
        blocked_since: '2026-07-30T15:00:00.000Z',
      },
    ],
  });

  assert.equal(summary.stalled, false);
  assert.equal(summary.reason, 'healthy');
  assert.equal(summary.dispatchCount, 1);
});

test('buildDispatchLivenessIncidentBody includes histogram and never-summoned blocked PRs', () => {
  const body = buildDispatchLivenessIncidentBody({
    now: NOW,
    summary: {
      stalled: true,
      reason: 'no-dispatches-for-blocked-backlog',
      windowHours: 8,
      perPrGapHours: 4,
      openBlockedCount: 2,
      dispatchCount: 0,
      decisionCountInWindow: 6,
      nonDispatchHistogram: [
        ['skip-merge-train-owned', 5],
        ['skip-duplicate-fingerprint', 1],
      ],
      neverSummonedBlockedPulls: [
        { number: 2193, html_url: 'https://github.com/nalfeo/Crawler/pull/2193' },
      ],
    },
    workflowRunUrl: 'https://example.test/sweep',
    repository: 'nalfeo/Crawler',
  });

  assert.ok(body.startsWith(DISPATCH_LIVENESS_INCIDENT_MARKER));
  assert.match(body, /skip-merge-train-owned/);
  assert.match(body, /#2193/);
  assert.match(body, /https:\/\/github\.com\/nalfeo\/Crawler\/pull\/2193/);
});

function blockedPull(number, overrides = {}) {
  return {
    number,
    state: 'open',
    draft: false,
    mergeable_state: 'blocked',
    blocked_since: '2026-07-30T10:00:00Z',
    head: { sha: `sha-${number}`, repo: { full_name: 'nalfeo/Crawler' } },
    base: { ref: 'main' },
    labels: [],
    ...overrides,
  };
}

test('selectLivenessRedispatchCandidates handles the incident fixture deterministically', () => {
  const candidates = selectLivenessRedispatchCandidates({
    pulls: [
      blockedPull(4217),
      blockedPull(4214),
      blockedPull(4220, { draft: true }),
      blockedPull(4221, { state: 'closed' }),
      blockedPull(4222, { head: { repo: { full_name: 'external/fork' } } }),
      blockedPull(4223, { blocked_since: '2026-07-30T16:59:00Z' }),
    ],
    owner: 'nalfeo',
    repo: 'Crawler',
    protectedPullNumbers: protectedLivenessPullNumbers([
      { pr: 4217, action: 'skip-merge-train-owned' },
    ]),
    now: NOW,
    cap: DEFAULT_LIVENESS_REDISPATCH_CAP,
  });

  assert.deepEqual(
    candidates.map((pull) => pull.number),
    [4214, 4217],
    'protected, fresh, draft, closed, and fork PRs must not be selected; stale no-op decisions no longer suppress redispatch',
  );
});

test('protectedLivenessPullNumbers excludes actively owned PRs from redispatch', () => {
  const protectedNumbers = protectedLivenessPullNumbers([
    { pr: 4217, action: 'skip-active-shepherd' },
    { pr: 4214, action: 'skip-active-copilot-progress' },
  ]);

  const candidates = selectLivenessRedispatchCandidates({
    pulls: [blockedPull(4217), blockedPull(4214), blockedPull(4224)],
    owner: 'nalfeo',
    repo: 'Crawler',
    protectedPullNumbers: protectedNumbers,
    now: NOW,
  });

  assert.deepEqual(
    candidates.map((pull) => pull.number),
    [4224],
    'active shepherd and Copilot ownership decisions must prevent redispatch',
  );
});

test('protectedLivenessPullNumbers excludes conflict-order and rebase backoff waits', () => {
  const protectedNumbers = protectedLivenessPullNumbers([
    { pr: 4225, action: 'skip-ci-conflict-order-wait' },
    { pr: 4226, action: 'wait-conflict-rebase-backoff' },
  ]);

  const candidates = selectLivenessRedispatchCandidates({
    pulls: [blockedPull(4225), blockedPull(4226), blockedPull(4227)],
    owner: 'nalfeo',
    repo: 'Crawler',
    protectedPullNumbers: protectedNumbers,
    now: NOW,
  });

  assert.deepEqual(
    candidates.map((pull) => pull.number),
    [4227],
  );
});

test('protectedLivenessPullNumbers does not fence stale no-op decisions from redispatch', () => {
  const protectedNumbers = protectedLivenessPullNumbers([
    { pr: 4251, action: 'skip-duplicate-fingerprint' },
    { pr: 4252, action: 'skip-merge-train-owned' },
    { pr: 4253, action: 'queue-merge-train' },
    { pr: 4254, action: 'wait-admission' },
    { pr: 4255, action: 'skip-active-shepherd' },
  ]);

  const candidates = selectLivenessRedispatchCandidates({
    pulls: [
      blockedPull(4251),
      blockedPull(4252),
      blockedPull(4253),
      blockedPull(4254),
      blockedPull(4255),
      blockedPull(4256),
    ],
    owner: 'nalfeo',
    repo: 'Crawler',
    protectedPullNumbers: protectedNumbers,
    now: NOW,
    cap: 10,
  });

  assert.deepEqual(candidates.map((pull) => pull.number), [4251, 4252, 4253, 4254, 4256]);
});

test('selectLivenessRedispatchCandidates excludes current ownership metadata', () => {
  const candidates = selectLivenessRedispatchCandidates({
    pulls: [
      blockedPull(4228, { labels: [{ name: 'ci-owner-pr-4228' }] }),
      blockedPull(4229, { labels: [{ name: 'ci-recovery-waiting-transition' }] }),
      blockedPull(4230),
    ],
    owner: 'nalfeo',
    repo: 'Crawler',
    now: NOW,
  });

  assert.deepEqual(
    candidates.map((pull) => pull.number),
    [4230],
  );
});

test('selectLivenessRedispatchCandidates excludes current merge-train ownership metadata', () => {
  const candidates = selectLivenessRedispatchCandidates({
    pulls: [
      blockedPull(4233, { labels: [{ name: 'merge-train' }] }),
      blockedPull(4234, { labels: [{ name: 'merge-train-blocked' }] }),
      blockedPull(4235, { labels: [{ name: 'merge-train-recovery-pending' }] }),
      blockedPull(4236, { labels: [{ name: 'merge-train-validation-failed' }] }),
      blockedPull(4237, { labels: [{ name: 'ci-conflict-order-wait' }] }),
      blockedPull(4238),
    ],
    owner: 'nalfeo',
    repo: 'Crawler',
    now: NOW,
  });

  assert.deepEqual(
    candidates.map((pull) => pull.number),
    [4238],
    'current merge-train ownership and wait labels must prevent redispatch',
  );
});

test('selectLivenessRedispatchCandidates excludes lifecycle quarantine/abandon and opt-out labels', () => {
  const candidates = selectLivenessRedispatchCandidates({
    pulls: [
      blockedPull(4241, { labels: [{ name: 'ci-lifecycle-quarantined' }] }),
      blockedPull(4242, { labels: [{ name: 'ci-lifecycle-abandoned' }] }),
      blockedPull(4243, { labels: [{ name: 'ci-recovery-opt-out' }] }),
      blockedPull(4244),
    ],
    owner: 'nalfeo',
    repo: 'Crawler',
    now: NOW,
  });

  assert.deepEqual(
    candidates.map((pull) => pull.number),
    [4244],
    'quarantined, abandoned, and opt-out PRs must mirror the router exclusions and never be dispatched',
  );
});

test('protectedLivenessPullNumbers excludes PRs whose automation budget is intentionally exhausted', () => {
  const protectedNumbers = protectedLivenessPullNumbers([
    { pr: 4245, action: 'skip-stale-automation-exhausted' },
  ]);

  const candidates = selectLivenessRedispatchCandidates({
    pulls: [blockedPull(4245), blockedPull(4246)],
    owner: 'nalfeo',
    repo: 'Crawler',
    protectedPullNumbers: protectedNumbers,
    now: NOW,
  });

  assert.deepEqual(
    candidates.map((pull) => pull.number),
    [4246],
    'a terminal exhausted decision must keep suppressing redispatch even after it ages out of the sampling window',
  );
});

test('dispatchLivenessRedispatches re-fetches state and carries current head/base guards', async () => {
  const dispatches = [];
  const result = await dispatchLivenessRedispatches({
    candidates: [blockedPull(4217), blockedPull(4217), blockedPull(4218)],
    owner: 'nalfeo',
    repo: 'Crawler',
    getPull: async (number) => ({
      data:
        number === 4217
          ? blockedPull(4217, { head: { sha: 'new-head', repo: { full_name: 'nalfeo/Crawler' } } })
          : blockedPull(4218, { state: 'closed' }),
    }),
    dispatch: async (request) => dispatches.push(request),
  });

  assert.deepEqual(result.dispatched, [{ number: 4217, headSha: 'new-head', baseRef: 'main' }]);
  assert.deepEqual(result.skipped, [{ number: 4218, reason: 'state-changed' }]);
  assert.equal(dispatches.length, 1);
  assert.deepEqual(dispatches[0].inputs, {
    operation: 'reconcile',
    pr_number: '4217',
    trigger: 'ci-liveness-sweep',
    expected_head_sha: 'new-head',
    expected_base_ref: 'main',
  });
});

test('dispatchLivenessRedispatches dispatches stale PRs targeting non-default base refs', async () => {
  const dispatches = [];
  const result = await dispatchLivenessRedispatches({
    candidates: [blockedPull(4240, { base: { ref: 'release/1.2' } })],
    owner: 'nalfeo',
    repo: 'Crawler',
    ref: 'main',
    getPull: async () => ({
      data: blockedPull(4240, {
        base: { ref: 'release/1.2' },
        head: { sha: 'release-head', repo: { full_name: 'nalfeo/Crawler' } },
      }),
    }),
    dispatch: async (request) => dispatches.push(request),
  });

  assert.deepEqual(result.dispatched, [
    { number: 4240, headSha: 'release-head', baseRef: 'release/1.2' },
  ]);
  assert.deepEqual(dispatches[0], {
    owner: 'nalfeo',
    repo: 'Crawler',
    workflow_id: 'ci-recovery.yml',
    ref: 'main',
    inputs: {
      operation: 'reconcile',
      pr_number: '4240',
      trigger: 'ci-liveness-sweep',
      expected_head_sha: 'release-head',
      expected_base_ref: 'release/1.2',
    },
  });
});

test('dispatchLivenessRedispatches skips current ownership metadata after re-fetch', async () => {
  const dispatches = [];
  const result = await dispatchLivenessRedispatches({
    candidates: [blockedPull(4231), blockedPull(4232)],
    owner: 'nalfeo',
    repo: 'Crawler',
    getPull: async (number) => ({
      data: blockedPull(number, {
        labels:
          number === 4231
            ? [{ name: 'ci-owner-pr-4231' }]
            : [{ name: 'ci-recovery-waiting-transition' }],
      }),
    }),
    dispatch: async (request) => dispatches.push(request),
  });

  assert.deepEqual(result.dispatched, []);
  assert.deepEqual(result.skipped, [
    { number: 4231, reason: 'state-changed' },
    { number: 4232, reason: 'state-changed' },
  ]);
  assert.equal(dispatches.length, 0);
});

test('dispatchLivenessRedispatches skips merge-train metadata after re-fetch', async () => {
  const dispatches = [];
  const result = await dispatchLivenessRedispatches({
    candidates: [blockedPull(4238), blockedPull(4239)],
    owner: 'nalfeo',
    repo: 'Crawler',
    getPull: async (number) => ({
      data: blockedPull(number, {
        labels: [{ name: number === 4238 ? 'merge-train' : 'merge-train-validation-failed' }],
      }),
    }),
    dispatch: async (request) => dispatches.push(request),
  });

  assert.deepEqual(result.dispatched, []);
  assert.deepEqual(result.skipped, [
    { number: 4238, reason: 'state-changed' },
    { number: 4239, reason: 'state-changed' },
  ]);
  assert.equal(dispatches.length, 0);
});

test('dispatchLivenessRedispatches continues past a transient hydration failure', async () => {
  const dispatches = [];
  const result = await dispatchLivenessRedispatches({
    candidates: [blockedPull(4247), blockedPull(4248)],
    owner: 'nalfeo',
    repo: 'Crawler',
    getPull: async (number) => {
      if (number === 4247) throw new Error('secondary rate limit');
      return { data: blockedPull(4248) };
    },
    dispatch: async (request) => dispatches.push(request),
  });

  assert.deepEqual(result.dispatched, [{ number: 4248, headSha: 'sha-4248', baseRef: 'main' }]);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].number, 4247);
  assert.equal(result.skipped[0].reason, 'hydration-failed');
  assert.equal(dispatches.length, 1);
});

test('dispatchLivenessRedispatches continues past a transient dispatch failure', async () => {
  const dispatches = [];
  const result = await dispatchLivenessRedispatches({
    candidates: [blockedPull(4249), blockedPull(4250)],
    owner: 'nalfeo',
    repo: 'Crawler',
    getPull: async (number) => ({ data: blockedPull(number) }),
    dispatch: async (request) => {
      if (request.inputs.pr_number === '4249') throw new Error('workflow dispatch failed');
      dispatches.push(request);
    },
  });

  assert.deepEqual(result.dispatched, [{ number: 4250, headSha: 'sha-4250', baseRef: 'main' }]);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].number, 4249);
  assert.equal(result.skipped[0].reason, 'dispatch-failed');
  assert.equal(dispatches.length, 1);
});

test('parsePositiveIntEnv rejects unset, non-numeric, zero, and negative overrides', () => {
  assert.equal(parsePositiveIntEnv(undefined, 3), 3);
  assert.equal(parsePositiveIntEnv('', 3), 3);
  assert.equal(
    parsePositiveIntEnv('3junk', 7),
    7,
    'trailing garbage must not silently truncate to a number',
  );
  assert.equal(parsePositiveIntEnv('junk3', 7), 7);
  assert.equal(parsePositiveIntEnv('0', 3), 3);
  assert.equal(
    parsePositiveIntEnv('-1', 3),
    3,
    'a negative cap must not silently disable the backstop',
  );
  assert.equal(parsePositiveIntEnv('5', 3), 5);
});

test('buildHarvestIncidentBody names the shared user-PAT bucket and carries the marker', () => {
  const body = buildHarvestIncidentBody({
    now: NOW,
    summary: summarizeHarvestRuns([], NOW),
    backlogCount: 21,
    reason: 'no-completed-runs-in-window',
    workflowRunUrl: 'https://example.test/sweep',
  });

  assert.ok(body.startsWith(HARVEST_INCIDENT_MARKER));
  assert.match(body, /CRAWLER_CI_PAT/);
  assert.match(body, /user\* level|user level|\*user\* level/);
  assert.match(body, /Do not trust `gh api rate_limit`/);
  assert.match(body, /GraphQL has a separate budget/);
  assert.match(body, /Open PRs waiting: 21/);
  assert.match(body, /https:\/\/example\.test\/sweep/);
  assert.match(body, /REPOSITORY=/);
  assert.match(body, /\$\{REPOSITORY\}/);
  assert.doesNotMatch(body, /\$\{\{ github\.repository \}\}/);
});

function fakeApi({ existing = [] } = {}) {
  const calls = [];
  const graphqlCalls = [];
  return {
    calls,
    graphqlCalls,
    paginate: async () => existing,
    graphql: async (token, query, variables) => {
      graphqlCalls.push({ token, query, variables });
      if (query.includes('suggestedActors')) {
        return {
          repository: {
            suggestedActors: { nodes: [{ id: 'BOT_copilot', login: 'copilot' }] },
            issue: {
              id: 'ISSUE_4242',
              state: 'OPEN',
              assignees: { nodes: [] },
            },
          },
        };
      }
      if (query.includes('replaceActorsForAssignable')) {
        return {
          replaceActorsForAssignable: {
            assignable: { assignees: { nodes: [{ login: 'copilot' }] } },
          },
        };
      }
      throw new Error(`Unexpected GraphQL query: ${query}`);
    },
    request: async (_token, path, options = {}) => {
      calls.push({ path, method: options.method || 'GET', body: options.body });
      return { data: { number: 4242, node_id: 'ISSUE_4242' } };
    },
  };
}

const STALLED = { stalled: true, reason: 'no-successful-run-in-window' };
const HEALTHY = { stalled: false, reason: 'healthy' };

test('reconcileHarvestIncident creates a labelled incident when stalled', async () => {
  const api = fakeApi();
  const result = await reconcileHarvestIncident({
    ...api,
    token: 't',
    owner: 'nalfeo',
    repo: 'Crawler',
    verdict: STALLED,
    summary: summarizeHarvestRuns([], NOW),
    backlogCount: 21,
    now: NOW,
  });

  assert.equal(result.action, 'created');
  assert.equal(result.issueNumber, 4242);
  const post = api.calls.find((call) => call.method === 'POST');
  assert.equal(post.body.title, HARVEST_INCIDENT_TITLE);
  assert.deepEqual(post.body.labels, [HARVEST_INCIDENT_LABEL]);
  assert.equal(
    api.graphqlCalls.filter((call) => call.query.includes('replaceActorsForAssignable')).length,
    1,
  );
});

test('reconcileHarvestIncident updates rather than duplicating an existing incident', async () => {
  const api = fakeApi({
    existing: [{ number: 77, title: HARVEST_INCIDENT_TITLE, body: HARVEST_INCIDENT_MARKER }],
  });
  const result = await reconcileHarvestIncident({
    ...api,
    token: 't',
    owner: 'nalfeo',
    repo: 'Crawler',
    verdict: STALLED,
    summary: summarizeHarvestRuns([], NOW),
    backlogCount: 21,
    now: NOW,
  });

  assert.equal(result.action, 'updated');
  assert.equal(result.issueNumber, 77);
  assert.equal(api.calls.filter((call) => call.method === 'POST').length, 0);
});

test('reconcileHarvestIncident ignores unmanaged and PR-shaped ci-incident issues', async () => {
  const api = fakeApi({
    existing: [
      { number: 5, title: HARVEST_INCIDENT_TITLE, body: 'hand-written, no marker' },
      { number: 6, title: 'CI incident: Merge train empty', body: HARVEST_INCIDENT_MARKER },
      {
        number: 7,
        title: HARVEST_INCIDENT_TITLE,
        body: HARVEST_INCIDENT_MARKER,
        pull_request: {},
      },
    ],
  });
  const result = await reconcileHarvestIncident({
    ...api,
    token: 't',
    owner: 'nalfeo',
    repo: 'Crawler',
    verdict: STALLED,
    summary: summarizeHarvestRuns([], NOW),
    backlogCount: 21,
    now: NOW,
  });

  assert.equal(result.action, 'created');
});

test('reconcileHarvestIncident closes the incident once the harvest recovers', async () => {
  const api = fakeApi({
    existing: [{ number: 77, title: HARVEST_INCIDENT_TITLE, body: HARVEST_INCIDENT_MARKER }],
  });
  const result = await reconcileHarvestIncident({
    ...api,
    token: 't',
    owner: 'nalfeo',
    repo: 'Crawler',
    verdict: HEALTHY,
    summary: summarizeHarvestRuns([run()], NOW),
    backlogCount: 21,
    now: NOW,
  });

  assert.equal(result.action, 'closed');
  const patch = api.calls.find((call) => call.method === 'PATCH');
  assert.equal(patch.body.state, 'closed');
  assert.match(patch.body.body, /Auto-resolved/);
});

test('reconcileHarvestIncident is a no-op when healthy with no open incident', async () => {
  const api = fakeApi();
  const result = await reconcileHarvestIncident({
    ...api,
    token: 't',
    owner: 'nalfeo',
    repo: 'Crawler',
    verdict: HEALTHY,
    summary: summarizeHarvestRuns([run()], NOW),
    backlogCount: 21,
    now: NOW,
  });

  assert.equal(result.action, 'noop');
  assert.equal(api.calls.length, 0);
});

test('reconcileDispatchLivenessIncident creates a managed incident when dispatch liveness stalls', async () => {
  const api = fakeApi();
  const result = await reconcileDispatchLivenessIncident({
    ...api,
    token: 't',
    owner: 'nalfeo',
    repo: 'Crawler',
    summary: {
      stalled: true,
      reason: 'no-dispatches-for-blocked-backlog',
      windowHours: 8,
      perPrGapHours: 4,
      openBlockedCount: 1,
      dispatchCount: 0,
      decisionCountInWindow: 2,
      nonDispatchHistogram: [['skip-merge-train-owned', 2]],
      neverSummonedBlockedPulls: [
        { number: 2414, html_url: 'https://github.com/nalfeo/Crawler/pull/2414' },
      ],
    },
    now: NOW,
  });
  assert.equal(result.action, 'created');
  const post = api.calls.find((call) => call.method === 'POST');
  assert.equal(post.body.title, DISPATCH_LIVENESS_INCIDENT_TITLE);
  assert.deepEqual(post.body.labels, [DISPATCH_LIVENESS_INCIDENT_LABEL]);
  assert.match(post.body.body, /skip-merge-train-owned/);
});

// ---------------------------------------------------------------------------
// Workflow wiring. The alarm is only useful if it actually runs, and only
// trustworthy if it runs on a token bucket independent of the one that failed.
// ---------------------------------------------------------------------------

const SWEEP = YAML.parse(readFileSync('.github/workflows/ci-liveness-sweep.yml', 'utf8'));
const SWEEP_STEPS = SWEEP.jobs['reconcile-liveness'].steps;
const ALARM_STEP = SWEEP_STEPS.find(
  (step) => step.name === 'Verify stale-session harvest liveness',
);
const RECOVERY_WORKFLOW = YAML.parse(readFileSync('.github/workflows/ci-recovery.yml', 'utf8'));

test('CI Liveness Sweep runs the harvest liveness alarm', () => {
  assert.ok(ALARM_STEP, 'sweep must contain the harvest liveness alarm step');
  assert.match(ALARM_STEP.with.script, /harvest-liveness\.mjs/);
  assert.match(ALARM_STEP.with.script, /collectRecentReconcileHarvestRuns/);
  assert.match(ALARM_STEP.with.script, /collectRecentWorkflowDispatchRuns/);
  assert.match(ALARM_STEP.with.script, /summarizeDispatchLiveness/);
  assert.match(ALARM_STEP.with.script, /reconcileDispatchLivenessIncident/);
  assert.ok(
    SWEEP_STEPS.some((step) => String(step.uses || '').startsWith('actions/checkout')),
    'alarm imports a repo file, so the sweep must check out the repository',
  );
});

test('CI Liveness Sweep can file the incident it detects', () => {
  assert.equal(SWEEP.permissions.issues, 'write');
});

// The alarm itself must run on GITHUB_TOKEN for liveness and REST issue ops.
// Only the GraphQL assignment helper should consume CRAWLER_CI_PAT.
test('harvest liveness alarm keeps GITHUB_TOKEN for liveness while PAT is assignment-only', () => {
  assert.match(ALARM_STEP.with.script, /token:\s*null/);
  assert.match(ALARM_STEP.with.script, /assignmentToken:\s*process\.env\.CRAWLER_CI_PAT/);
  assert.doesNotMatch(ALARM_STEP.with.script, /create-github-app-token/);
});

test('CI Liveness Sweep still runs on a schedule', () => {
  const schedule = SWEEP.on?.schedule ?? SWEEP[true]?.schedule;
  assert.ok(Array.isArray(schedule) && schedule.length > 0, 'sweep must stay scheduled');
});

test('CI Recovery workflow exposes operation in run-name for liveness filtering', () => {
  assert.match(String(RECOVERY_WORKFLOW['run-name'] || ''), /inputs\.operation/);
});
