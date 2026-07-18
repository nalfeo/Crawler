import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parse } from 'yaml';

import {
  changedFileRetryDelaysMs,
  COPILOT_CLOUD_AGENT_WORKFLOW_PATH,
  EMPTY_DRAFT_REPAIR_GRACE_MS,
  inspectEmptyCopilotDraftRepair,
  listCopilotCloudWorkflowRuns,
  latestMatchingCopilotCloudRun,
  matchingCopilotCloudRunRejection,
  runPrReadyReviewerGuard,
} from './pr-ready-reviewer-guard.mjs';

const workflowPath = new URL('../workflows/pr-ready-reviewer-guard.yml', import.meta.url);
const workflow = parse(await readFile(workflowPath, 'utf8'));

const REPOSITORY = 'nalfeo/Crawler';
const HEAD_SHA = 'a'.repeat(40);
const HEAD_BRANCH = 'copilot/fix-empty-draft';
const NOW = new Date('2026-07-18T12:00:00.000Z');

function olderThanGrace(ms = 1_000) {
  return new Date(NOW.getTime() - EMPTY_DRAFT_REPAIR_GRACE_MS - ms).toISOString();
}

function newerThanGrace(ms = 1_000) {
  return new Date(NOW.getTime() - EMPTY_DRAFT_REPAIR_GRACE_MS + ms).toISOString();
}

function makePr(overrides = {}) {
  return {
    number: 42,
    node_id: 'PR_42',
    state: 'open',
    draft: true,
    user: { login: 'Copilot' },
    head: {
      sha: HEAD_SHA,
      ref: HEAD_BRANCH,
      repo: { full_name: REPOSITORY },
    },
    requested_reviewers: [],
    ...overrides,
  };
}

function makeLinkedIssue(overrides = {}) {
  return {
    id: 'ISSUE_1067',
    number: 1067,
    title: 'Repair broken automation',
    state: 'OPEN',
    labels: [],
    ...overrides,
  };
}

function makeRun(overrides = {}) {
  const completedAt = olderThanGrace();
  return {
    id: 901,
    name: 'Copilot Setup Steps',
    path: COPILOT_CLOUD_AGENT_WORKFLOW_PATH,
    status: 'completed',
    conclusion: 'success',
    created_at: completedAt,
    updated_at: completedAt,
    head_sha: HEAD_SHA,
    head_branch: HEAD_BRANCH,
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
    actor: { login: 'Copilot' },
    triggering_actor: { login: 'Copilot' },
    ...overrides,
  };
}

function makeIssueContext(overrides = {}) {
  return {
    issueId: 'ISSUE_1067',
    issueState: 'OPEN',
    copilot: { id: 'BOT_COPILOT', login: 'copilot-swe-agent' },
    assignees: [
      { id: 'USER_NALFEO', login: 'nalfeo' },
      { id: 'BOT_COPILOT', login: 'Copilot' },
    ],
    actorCatalog: {
      USER_NALFEO: 'nalfeo',
      BOT_COPILOT: 'Copilot',
      USER_HELPER: 'helper',
    },
    ...overrides,
  };
}

function createHarness({
  pulls = [makePr()],
  changedFilesByPull = new Map([[42, [0]]]),
  linkedIssuesByPull = new Map([[42, [makeLinkedIssue()]]]),
  runsByHead = new Map([[`${HEAD_SHA}::${HEAD_BRANCH}`, [makeRun()]]]),
  issueContextsByNumber = new Map([[1067, makeIssueContext()]]),
  replacePlan = [],
  markReadyError = null,
  updatePullStateErrors = new Map(),
} = {}) {
  const calls = [];
  const logs = [];
  const state = {
    pulls: structuredClone(pulls),
    issueContextsByNumber: new Map(
      [...issueContextsByNumber.entries()].map(([number, context]) => [
        number,
        structuredClone(context),
      ]),
    ),
    getPullCounts: new Map(),
  };

  const api = {
    listOpenPulls: async () =>
      state.pulls
        .filter((pull) => String(pull.state || 'open').toLowerCase() === 'open')
        .map((pull) => structuredClone(pull)),
    getPull: async (pullNumber) => {
      calls.push(['getPull', pullNumber]);
      const pull = state.pulls.find((entry) => entry.number === pullNumber);
      if (!pull) {
        throw new Error(`Missing PR #${pullNumber}`);
      }
      const count = state.getPullCounts.get(pullNumber) || 0;
      state.getPullCounts.set(pullNumber, count + 1);
      const sequence = changedFilesByPull.get(pullNumber) || [0];
      const changed_files = sequence[Math.min(count, sequence.length - 1)];
      return { ...structuredClone(pull), changed_files };
    },
    markReadyForReview: async (pullRequestId) => {
      calls.push(['markReadyForReview', pullRequestId]);
      if (markReadyError) {
        throw markReadyError;
      }
      const pull = state.pulls.find((entry) => entry.node_id === pullRequestId);
      if (pull) {
        pull.draft = false;
      }
    },
    removeRequestedReviewer: async (pullNumber, reviewerLogin) => {
      calls.push(['removeRequestedReviewer', pullNumber, reviewerLogin]);
      const pull = state.pulls.find((entry) => entry.number === pullNumber);
      if (pull) {
        pull.requested_reviewers = (pull.requested_reviewers || []).filter(
          (reviewer) => reviewer.login !== reviewerLogin,
        );
      }
    },
    listClosingIssues: async (pullNumber) => {
      calls.push(['listClosingIssues', pullNumber]);
      return structuredClone(linkedIssuesByPull.get(pullNumber) || []);
    },
    listWorkflowRuns: async (headSha, headBranch) => {
      calls.push(['listWorkflowRuns', headSha, headBranch]);
      return structuredClone(runsByHead.get(`${headSha}::${headBranch}`) || []);
    },
    getCopilotIssueAssignmentContext: async (issueNumber) => {
      calls.push(['getCopilotIssueAssignmentContext', issueNumber]);
      const context = state.issueContextsByNumber.get(issueNumber);
      if (!context) {
        throw new Error(`Missing issue context for #${issueNumber}`);
      }
      return structuredClone(context);
    },
    replaceIssueAssignees: async (assignableId, actorIds) => {
      calls.push(['replaceIssueAssignees', assignableId, [...actorIds]]);
      const behavior = replacePlan.shift();
      if (behavior instanceof Error) {
        throw behavior;
      }
      const context = [...state.issueContextsByNumber.values()].find(
        (entry) => entry.issueId === assignableId,
      );
      if (!context) {
        throw new Error(`Missing issue assignable ${assignableId}`);
      }
      context.assignees = actorIds.map((id) => ({
        id,
        login: context.actorCatalog[id] || `actor-${id}`,
      }));
      if (behavior && Array.isArray(behavior.logins)) {
        return behavior.logins.map((login) => String(login).toLowerCase());
      }
      return context.assignees.map((assignee) => String(assignee.login).toLowerCase());
    },
    updatePullState: async (pullNumber, nextState) => {
      calls.push(['updatePullState', pullNumber, nextState]);
      const error = updatePullStateErrors.get(`${pullNumber}:${nextState}`);
      if (error) {
        throw error;
      }
      const pull = state.pulls.find((entry) => entry.number === pullNumber);
      if (!pull) {
        throw new Error(`Missing PR #${pullNumber}`);
      }
      pull.state = nextState;
      return structuredClone(pull);
    },
  };

  const log = {
    info: (message) => logs.push(['info', message]),
    warning: (message) => logs.push(['warning', message]),
    error: (message) => logs.push(['error', message]),
  };

  return { api, calls, logs, state, log };
}

test('workflow runs trusted default-branch script with global serialization', () => {
  assert.equal(workflow.permissions.contents, 'read');
  assert.equal(workflow.permissions['pull-requests'], undefined);
  assert.equal(workflow.jobs['enforce-pr-state']['timeout-minutes'], 15);
  assert.equal(workflow.jobs['enforce-pr-state'].concurrency.group, 'pr-ready-reviewer-guard');
  assert.equal(workflow.jobs['enforce-pr-state'].steps[0].uses, 'actions/checkout@v4');
  assert.equal(
    workflow.jobs['enforce-pr-state'].steps[0].with.ref,
    '${{ github.event.repository.default_branch }}',
  );
  assert.equal(workflow.jobs['enforce-pr-state'].steps[0].with['persist-credentials'], false);
  assert.equal(workflow.jobs['enforce-pr-state'].steps[1].uses, 'actions/setup-node@v4');
  assert.equal(workflow.jobs['enforce-pr-state'].steps[1].with['node-version'], 22);
  assert.equal(
    workflow.jobs['enforce-pr-state'].steps[2].run,
    'node .github/scripts/pr-ready-reviewer-guard.mjs',
  );
});

test('uses bounded changed-file retries only for the synchronized pull request', () => {
  assert.deepEqual(
    changedFileRetryDelaysMs({
      eventName: 'pull_request_target',
      payloadAction: 'synchronize',
      triggeringPullNumber: 42,
      prNumber: 42,
    }),
    [0, 1000, 2000],
  );
  assert.deepEqual(
    changedFileRetryDelaysMs({
      eventName: 'pull_request_target',
      payloadAction: 'synchronize',
      triggeringPullNumber: 41,
      prNumber: 42,
    }),
    [0],
  );
});

for (const [name, mutate, expectedReason] of [
  ['non-draft', (input) => (input.pr.draft = false), 'not-draft'],
  ['fork', (input) => (input.pr.head.repo.full_name = 'attacker/Crawler'), 'fork'],
  ['non-copilot author', (input) => (input.pr.user.login = 'octocat'), 'author=octocat'],
  ['non-empty diff', (input) => (input.changedFiles = 2), 'changed-files=2'],
  ['missing linked issue', (input) => (input.linkedIssues = []), 'linked-issue-count=0'],
  [
    'multiple linked issues',
    (input) => (input.linkedIssues = [makeLinkedIssue(), makeLinkedIssue({ number: 1068 })]),
    'linked-issue-count=2',
  ],
  [
    'closed linked issue',
    (input) => (input.linkedIssues = [makeLinkedIssue({ state: 'CLOSED' })]),
    'linked-issue-state=CLOSED',
  ],
  ['missing matching run', (input) => (input.runs = []), 'no-matching-copilot-cloud-run'],
  [
    'unrelated bot run on same sha',
    (input) =>
      (input.runs = [
        makeRun({
          actor: { login: 'github-actions[bot]' },
          triggering_actor: { login: 'github-actions[bot]' },
        }),
      ]),
    'no-matching-copilot-cloud-run',
  ],
  [
    'in-progress run',
    (input) => (input.runs = [makeRun({ status: 'in_progress' })]),
    'copilot-cloud-run-status=in_progress',
  ],
  [
    'newer in-progress run outranks older completed run',
    (input) =>
      (input.runs = [
        makeRun({ id: 900, created_at: olderThanGrace(5_000), updated_at: olderThanGrace(5_000) }),
        makeRun({
          id: 901,
          status: 'in_progress',
          created_at: olderThanGrace(500),
          updated_at: olderThanGrace(500),
        }),
      ]),
    'copilot-cloud-run-status=in_progress',
  ],
  [
    'grace not elapsed',
    (input) =>
      (input.runs = [makeRun({ updated_at: newerThanGrace(), created_at: newerThanGrace() })]),
    `copilot-cloud-run-grace=${1000}`,
  ],
]) {
  test(`repair inspection fails closed for ${name}`, () => {
    const input = {
      pr: makePr(),
      changedFiles: 0,
      linkedIssues: [makeLinkedIssue()],
      runs: [makeRun()],
    };
    mutate(input);
    const result = inspectEmptyCopilotDraftRepair({
      ...input,
      repository: REPOSITORY,
      now: NOW,
    });
    assert.deepEqual(result, { eligible: false, reason: expectedReason });
  });
}

test('latestMatchingCopilotCloudRun picks run with newest updated_at even when another has newer created_at', () => {
  // Run A: created earlier but updated (completed) later
  const runA = makeRun({
    id: 900,
    created_at: olderThanGrace(10_000),
    updated_at: olderThanGrace(1_000),
  });
  // Run B: created later but updated (completed) earlier
  const runB = makeRun({
    id: 901,
    created_at: olderThanGrace(5_000),
    updated_at: olderThanGrace(8_000),
  });
  const result = latestMatchingCopilotCloudRun({
    runs: [runB, runA],
    repository: REPOSITORY,
    headSha: HEAD_SHA,
    headBranch: HEAD_BRANCH,
  });
  assert.equal(result?.id, 900, 'should pick run A which has the newer updated_at');
});

test('matchingCopilotCloudRunRejection accepts run when optional API fields are absent', () => {
  // The GitHub REST endpoint may omit path/repository/head_repository in some contexts;
  // the check must degrade gracefully so repairs are not blocked by missing API fields.
  const minimalRun = {
    id: 999,
    head_sha: HEAD_SHA,
    head_branch: HEAD_BRANCH,
    actor: { login: 'Copilot' },
    // path, repository, head_repository intentionally absent
  };
  assert.equal(
    matchingCopilotCloudRunRejection({
      run: minimalRun,
      repository: REPOSITORY,
      headSha: HEAD_SHA,
      headBranch: HEAD_BRANCH,
    }),
    null,
    'should not reject when optional fields are absent',
  );
});

test('matchingCopilotCloudRunRejection still rejects run with wrong path when path is present', () => {
  const wrongPathRun = makeRun({ path: '.github/workflows/other.yml' });
  assert.equal(
    matchingCopilotCloudRunRejection({
      run: wrongPathRun,
      repository: REPOSITORY,
      headSha: HEAD_SHA,
      headBranch: HEAD_BRANCH,
    }),
    'workflow-path',
  );
});

test('listCopilotCloudWorkflowRuns uses workflow-specific endpoint and paginates', async () => {
  const seenPaths = [];
  const requestFn = async (_token, path) => {
    seenPaths.push(path);
    if (path.endsWith('page=1')) {
      return {
        data: { workflow_runs: Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })) },
      };
    }
    return { data: { workflow_runs: [{ id: 200 }] } };
  };
  const runs = await listCopilotCloudWorkflowRuns({
    requestFn,
    token: 'token',
    owner: 'nalfeo',
    repo: 'Crawler',
    headBranch: HEAD_BRANCH,
  });

  assert.equal(seenPaths.length, 2);
  assert.match(
    seenPaths[0],
    /\/actions\/workflows\/\.github%2Fworkflows%2Fcopilot-setup-steps\.yml\/runs\?branch=/,
  );
  assert.ok(!seenPaths[0].includes('head_sha='));
  assert.equal(runs.length, 101);
});

test('skips local-ineligible empty-draft repairs before linked-issue or workflow-run reads', async () => {
  const harness = createHarness({
    pulls: [makePr({ user: { login: 'octocat' } })],
  });
  const summary = await runPrReadyReviewerGuard({
    repository: REPOSITORY,
    reviewerLoginRaw: 'nalfeo',
    eventName: 'pull_request_target',
    payloadAction: 'opened',
    triggeringPullNumber: 42,
    api: harness.api,
    log: harness.log,
    now: NOW,
  });

  assert.deepEqual(summary, {
    draftsPublished: 0,
    emptyDraftRepairs: 0,
    reviewerRemovals: 0,
  });
  assert.equal(
    harness.calls.some(([name]) => name === 'listClosingIssues' || name === 'listWorkflowRuns'),
    false,
  );
});

test('repairs the exact eligible empty Copilot draft fixture', async () => {
  const harness = createHarness();
  const summary = await runPrReadyReviewerGuard({
    repository: REPOSITORY,
    reviewerLoginRaw: 'nalfeo',
    eventName: 'pull_request_target',
    payloadAction: 'opened',
    triggeringPullNumber: 42,
    api: harness.api,
    log: {
      info: (message) => harness.logs.push(['info', message]),
      warning: (message) => harness.logs.push(['warning', message]),
      error: (message) => harness.logs.push(['error', message]),
    },
    now: NOW,
  });

  assert.deepEqual(summary, {
    draftsPublished: 0,
    emptyDraftRepairs: 1,
    reviewerRemovals: 0,
  });
  assert.equal(harness.calls.filter(([name]) => name === 'replaceIssueAssignees').length, 2);
  assert.deepEqual(
    harness.calls
      .filter(([name]) => name === 'replaceIssueAssignees')
      .map(([, assignableId, actorIds]) => [assignableId, actorIds]),
    [
      ['ISSUE_1067', ['USER_NALFEO']],
      ['ISSUE_1067', ['USER_NALFEO', 'BOT_COPILOT']],
    ],
  );
  assert.ok(
    harness.logs.some(
      ([level, message]) =>
        level === 'info' &&
        message.includes('Repaired empty Copilot draft PR #42') &&
        message.includes('linked issue #1067'),
    ),
  );
});

test('a successful repair is not repeated on the next scan because the PR is closed', async () => {
  const harness = createHarness();
  await runPrReadyReviewerGuard({
    repository: REPOSITORY,
    reviewerLoginRaw: 'nalfeo',
    eventName: 'schedule',
    payloadAction: undefined,
    triggeringPullNumber: undefined,
    api: harness.api,
    log: harness.log,
    now: NOW,
  });
  const firstReplaceCount = harness.calls.filter(
    ([name]) => name === 'replaceIssueAssignees',
  ).length;

  const summary = await runPrReadyReviewerGuard({
    repository: REPOSITORY,
    reviewerLoginRaw: 'nalfeo',
    eventName: 'schedule',
    payloadAction: undefined,
    triggeringPullNumber: undefined,
    api: harness.api,
    log: {
      info: (message) => harness.logs.push(['info', message]),
      warning: (message) => harness.logs.push(['warning', message]),
      error: (message) => harness.logs.push(['error', message]),
    },
    now: NOW,
  });

  assert.equal(firstReplaceCount, 2);
  assert.deepEqual(summary, {
    draftsPublished: 0,
    emptyDraftRepairs: 0,
    reviewerRemovals: 0,
  });
  assert.equal(
    harness.calls.filter(([name]) => name === 'replaceIssueAssignees').length,
    firstReplaceCount,
  );
});

test('head drift after initial eligibility skips before any write', async () => {
  const pr = makePr();
  const drifted = makePr({
    head: {
      sha: 'b'.repeat(40),
      ref: HEAD_BRANCH,
      repo: { full_name: REPOSITORY },
    },
  });
  const harness = createHarness({
    pulls: [pr],
    changedFilesByPull: new Map([[42, [0, 0]]]),
  });
  harness.api.getPull = async (pullNumber) => {
    harness.calls.push(['getPull', pullNumber]);
    const count = harness.state.getPullCounts.get(pullNumber) || 0;
    harness.state.getPullCounts.set(pullNumber, count + 1);
    return count === 0
      ? { ...structuredClone(pr), changed_files: 0 }
      : { ...structuredClone(drifted), changed_files: 0 };
  };

  const summary = await runPrReadyReviewerGuard({
    repository: REPOSITORY,
    reviewerLoginRaw: 'nalfeo',
    eventName: 'schedule',
    payloadAction: undefined,
    triggeringPullNumber: undefined,
    api: harness.api,
    log: {
      info: (message) => harness.logs.push(['info', message]),
      warning: (message) => harness.logs.push(['warning', message]),
      error: (message) => harness.logs.push(['error', message]),
    },
    now: NOW,
  });

  assert.deepEqual(summary, {
    draftsPublished: 0,
    emptyDraftRepairs: 0,
    reviewerRemovals: 0,
  });
  assert.equal(
    harness.calls.some(([name]) => name === 'updatePullState'),
    false,
  );
  assert.ok(
    harness.logs.some(
      ([level, message]) => level === 'info' && message.includes('head-sha-changed='),
    ),
  );
});

test('skip without writes when linked issue no longer has Copilot assigned', async () => {
  const harness = createHarness({
    issueContextsByNumber: new Map([
      [
        1067,
        makeIssueContext({
          assignees: [{ id: 'USER_NALFEO', login: 'nalfeo' }],
          actorCatalog: { USER_NALFEO: 'nalfeo', BOT_COPILOT: 'Copilot' },
        }),
      ],
    ]),
  });
  const summary = await runPrReadyReviewerGuard({
    repository: REPOSITORY,
    reviewerLoginRaw: 'nalfeo',
    eventName: 'schedule',
    payloadAction: undefined,
    triggeringPullNumber: undefined,
    api: harness.api,
    log: {
      info: (message) => harness.logs.push(['info', message]),
      warning: (message) => harness.logs.push(['warning', message]),
      error: (message) => harness.logs.push(['error', message]),
    },
    now: NOW,
  });

  assert.deepEqual(summary, {
    draftsPublished: 0,
    emptyDraftRepairs: 0,
    reviewerRemovals: 0,
  });
  assert.equal(
    harness.calls.some(([name]) => name === 'updatePullState'),
    false,
  );
  assert.ok(
    harness.logs.some(
      ([level, message]) =>
        level === 'info' && message.includes('linked-issue-copilot-assignee-missing'),
    ),
  );
});

test('skip without writes when linked issue closed after confirmation but before issue assignment fetch', async () => {
  const harness = createHarness({
    issueContextsByNumber: new Map([
      [
        1067,
        makeIssueContext({
          issueState: 'CLOSED',
        }),
      ],
    ]),
  });
  const summary = await runPrReadyReviewerGuard({
    repository: REPOSITORY,
    reviewerLoginRaw: 'nalfeo',
    eventName: 'schedule',
    payloadAction: undefined,
    triggeringPullNumber: undefined,
    api: harness.api,
    log: {
      info: (message) => harness.logs.push(['info', message]),
      warning: (message) => harness.logs.push(['warning', message]),
      error: (message) => harness.logs.push(['error', message]),
    },
    now: NOW,
  });

  assert.deepEqual(summary, {
    draftsPublished: 0,
    emptyDraftRepairs: 0,
    reviewerRemovals: 0,
  });
  assert.equal(
    harness.calls.some(([name]) => name === 'updatePullState'),
    false,
  );
  assert.ok(
    harness.logs.some(
      ([level, message]) =>
        level === 'info' && message.includes('linked-issue-state-changed=CLOSED'),
    ),
  );
});

test('remove failure rolls back by reopening the PR and restoring the original assignees', async () => {
  const harness = createHarness({
    replacePlan: [new Error('remove failed')],
  });
  await assert.rejects(
    runPrReadyReviewerGuard({
      repository: REPOSITORY,
      reviewerLoginRaw: 'nalfeo',
      eventName: 'schedule',
      payloadAction: undefined,
      triggeringPullNumber: undefined,
      api: harness.api,
      log: {
        info: (message) => harness.logs.push(['info', message]),
        warning: (message) => harness.logs.push(['warning', message]),
        error: (message) => harness.logs.push(['error', message]),
      },
      now: NOW,
    }),
    /Failed to repair 1 empty Copilot draft PR shell\(s\)/,
  );
  assert.deepEqual(
    harness.calls
      .filter(([name]) => name === 'updatePullState' || name === 'replaceIssueAssignees')
      .map(([name, a, b]) => [name, a, b]),
    [
      ['updatePullState', 42, 'closed'],
      ['replaceIssueAssignees', 'ISSUE_1067', ['USER_NALFEO']],
      ['replaceIssueAssignees', 'ISSUE_1067', ['USER_NALFEO', 'BOT_COPILOT']],
      ['updatePullState', 42, 'open'],
    ],
  );
});

test('close failure surfaces immediately and makes no issue writes', async () => {
  const harness = createHarness({
    updatePullStateErrors: new Map([['42:closed', new Error('close rejected')]]),
  });
  await assert.rejects(
    runPrReadyReviewerGuard({
      repository: REPOSITORY,
      reviewerLoginRaw: 'nalfeo',
      eventName: 'schedule',
      payloadAction: undefined,
      triggeringPullNumber: undefined,
      api: harness.api,
      log: {
        info: (message) => harness.logs.push(['info', message]),
        warning: (message) => harness.logs.push(['warning', message]),
        error: (message) => harness.logs.push(['error', message]),
      },
      now: NOW,
    }),
    /Failed to repair 1 empty Copilot draft PR shell\(s\)/,
  );
  assert.deepEqual(
    harness.calls.filter(([name]) => name === 'replaceIssueAssignees'),
    [],
  );
  assert.deepEqual(
    harness.calls.filter(([name]) => name === 'updatePullState'),
    [['updatePullState', 42, 'closed']],
  );
});

test('reassignment failure rolls back by restoring the original assignees and reopening the PR', async () => {
  const harness = createHarness({
    replacePlan: [null, new Error('reassign failed')],
  });
  await assert.rejects(
    runPrReadyReviewerGuard({
      repository: REPOSITORY,
      reviewerLoginRaw: 'nalfeo',
      eventName: 'schedule',
      payloadAction: undefined,
      triggeringPullNumber: undefined,
      api: harness.api,
      log: {
        info: (message) => harness.logs.push(['info', message]),
        warning: (message) => harness.logs.push(['warning', message]),
        error: (message) => harness.logs.push(['error', message]),
      },
      now: NOW,
    }),
    /Failed to repair 1 empty Copilot draft PR shell\(s\)/,
  );
  assert.deepEqual(
    harness.calls
      .filter(([name]) => name === 'updatePullState' || name === 'replaceIssueAssignees')
      .map(([name, a, b]) => [name, a, b]),
    [
      ['updatePullState', 42, 'closed'],
      ['replaceIssueAssignees', 'ISSUE_1067', ['USER_NALFEO']],
      ['replaceIssueAssignees', 'ISSUE_1067', ['USER_NALFEO', 'BOT_COPILOT']],
      ['replaceIssueAssignees', 'ISSUE_1067', ['USER_NALFEO', 'BOT_COPILOT']],
      ['updatePullState', 42, 'open'],
    ],
  );
});

test('changed-file draft publication stays unchanged', async () => {
  const harness = createHarness({
    changedFilesByPull: new Map([[42, [2]]]),
  });
  const summary = await runPrReadyReviewerGuard({
    repository: REPOSITORY,
    reviewerLoginRaw: 'nalfeo',
    eventName: 'pull_request_target',
    payloadAction: 'opened',
    triggeringPullNumber: 42,
    api: harness.api,
    log: {
      info: (message) => harness.logs.push(['info', message]),
      warning: (message) => harness.logs.push(['warning', message]),
      error: (message) => harness.logs.push(['error', message]),
    },
    now: NOW,
  });

  assert.deepEqual(summary, {
    draftsPublished: 1,
    emptyDraftRepairs: 0,
    reviewerRemovals: 0,
  });
  assert.equal(
    harness.calls.some(([name]) => name === 'markReadyForReview'),
    true,
  );
  assert.equal(
    harness.calls.some(([name]) => name === 'replaceIssueAssignees'),
    false,
  );
});

test('requested-reviewer cleanup stays unchanged for non-draft pull requests', async () => {
  const harness = createHarness({
    pulls: [
      makePr({
        draft: false,
        requested_reviewers: [{ login: 'nalfeo' }],
      }),
    ],
  });

  const summary = await runPrReadyReviewerGuard({
    repository: REPOSITORY,
    reviewerLoginRaw: 'nalfeo',
    eventName: 'pull_request_target',
    payloadAction: 'review_requested',
    triggeringPullNumber: 42,
    api: harness.api,
    log: {
      info: (message) => harness.logs.push(['info', message]),
      warning: (message) => harness.logs.push(['warning', message]),
      error: (message) => harness.logs.push(['error', message]),
    },
    now: NOW,
  });

  assert.deepEqual(summary, {
    draftsPublished: 0,
    emptyDraftRepairs: 0,
    reviewerRemovals: 1,
  });
  assert.deepEqual(
    harness.calls.filter(([name]) => name === 'removeRequestedReviewer'),
    [['removeRequestedReviewer', 42, 'nalfeo']],
  );
});

test('reviewer-removal failures fall back to warn-capable loggers', async () => {
  const harness = createHarness({
    pulls: [
      makePr({
        draft: false,
        requested_reviewers: [{ login: 'nalfeo' }],
      }),
    ],
  });
  harness.api.removeRequestedReviewer = async () => {
    throw new Error('remove failed');
  };
  const warnings = [];
  const summary = await runPrReadyReviewerGuard({
    repository: REPOSITORY,
    reviewerLoginRaw: 'nalfeo',
    eventName: 'pull_request_target',
    payloadAction: 'review_requested',
    triggeringPullNumber: 42,
    api: harness.api,
    log: {
      info: () => {},
      warn: (message) => warnings.push(message),
      error: () => {},
    },
    now: NOW,
  });

  assert.deepEqual(summary, {
    draftsPublished: 0,
    emptyDraftRepairs: 0,
    reviewerRemovals: 0,
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Could not process reviewers for PR #42/);
});

test('a repair failure does not suppress unchanged publication and reviewer cleanup for other PRs', async () => {
  const failingPr = makePr();
  const publishPr = makePr({
    number: 43,
    node_id: 'PR_43',
    head: {
      sha: 'b'.repeat(40),
      ref: 'copilot/fix-real-work',
      repo: { full_name: REPOSITORY },
    },
    requested_reviewers: [{ login: 'nalfeo' }],
  });
  const harness = createHarness({
    pulls: [failingPr, publishPr],
    changedFilesByPull: new Map([
      [42, [0]],
      [43, [3]],
    ]),
    linkedIssuesByPull: new Map([
      [42, [makeLinkedIssue()]],
      [43, [makeLinkedIssue({ number: 1068, id: 'ISSUE_1068' })]],
    ]),
    runsByHead: new Map([
      [`${HEAD_SHA}::${HEAD_BRANCH}`, [makeRun()]],
      [
        `${'b'.repeat(40)}::copilot/fix-real-work`,
        [makeRun({ id: 902, head_sha: 'b'.repeat(40), head_branch: 'copilot/fix-real-work' })],
      ],
    ]),
    replacePlan: [null, new Error('reassign failed')],
  });

  await assert.rejects(
    runPrReadyReviewerGuard({
      repository: REPOSITORY,
      reviewerLoginRaw: 'nalfeo',
      eventName: 'schedule',
      payloadAction: undefined,
      triggeringPullNumber: undefined,
      api: harness.api,
      log: {
        info: (message) => harness.logs.push(['info', message]),
        warning: (message) => harness.logs.push(['warning', message]),
        error: (message) => harness.logs.push(['error', message]),
      },
      now: NOW,
    }),
    /Failed to repair 1 empty Copilot draft PR shell\(s\)/,
  );

  assert.equal(
    harness.calls.some(([name, value]) => name === 'markReadyForReview' && value === 'PR_43'),
    true,
  );
  assert.equal(
    harness.calls.some(
      ([name, pullNumber, reviewer]) =>
        name === 'removeRequestedReviewer' && pullNumber === 43 && reviewer === 'nalfeo',
    ),
    true,
  );
});
