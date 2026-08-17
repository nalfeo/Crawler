import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parse } from 'yaml';

import {
  changedFileRetryDelaysMs,
  COPILOT_CLOUD_AGENT_WORKFLOW_ID,
  COPILOT_CLOUD_AGENT_WORKFLOW_PATH,
  EMPTY_DRAFT_REPAIR_GRACE_MS,
  EMPTY_DRAFT_REPAIR_LABEL,
  EMPTY_DRAFT_REPEAT_TRIAGE_LABEL,
  inspectEmptyCopilotDraftRepair,
  listCopilotCloudWorkflowRuns,
  latestMatchingCopilotCloudRun,
  matchingCopilotCloudRunRejection,
  runPrReadyReviewerGuard,
} from './pr-ready-reviewer-guard.mjs';

const workflowPath = new URL('../workflows/pr-ready-reviewer-guard.yml', import.meta.url);
const workflow = parse(await readFile(workflowPath, 'utf8'));

test('reviewer guard does not run for new pushes or reconciler review requests', () => {
  assert.deepEqual(workflow.on.pull_request_target.types, [
    'opened',
    'reopened',
    'ready_for_review',
  ]);
});

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
    labels: [],
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
    repository: { nameWithOwner: REPOSITORY },
    ...overrides,
  };
}

function makeRun(overrides = {}) {
  const completedAt = olderThanGrace();
  return {
    id: 901,
    name: 'Copilot Setup Steps',
    path: COPILOT_CLOUD_AGENT_WORKFLOW_PATH,
    workflow_id: COPILOT_CLOUD_AGENT_WORKFLOW_ID,
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
  updatePullStatePostApplyErrors = new Map(),
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
    listOpenPulls: async () => {
      calls.push(['listOpenPulls']);
      return state.pulls
        .filter((pull) => String(pull.state || 'open').toLowerCase() === 'open')
        .map((pull) => structuredClone(pull));
    },
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
    requestReviewer: async (pullNumber, reviewerLogin) => {
      calls.push(['requestReviewer', pullNumber, reviewerLogin]);
      const pull = state.pulls.find((entry) => entry.number === pullNumber);
      if (pull) {
        pull.requested_reviewers = [...(pull.requested_reviewers || []), { login: reviewerLogin }];
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
    consumeAssigneeBehavior: () => {
      const behavior = replacePlan.shift();
      if (behavior instanceof Error) {
        throw behavior;
      }
      return behavior;
    },
    removeIssueAssignees: async (assignableId, actorIds) => {
      calls.push(['removeIssueAssignees', assignableId, [...actorIds]]);
      const behavior = api.consumeAssigneeBehavior();
      const context = [...state.issueContextsByNumber.values()].find(
        (entry) => entry.issueId === assignableId,
      );
      if (!context) {
        throw new Error(`Missing issue assignable ${assignableId}`);
      }
      const removalIds = new Set(actorIds);
      context.assignees = context.assignees.filter((assignee) => !removalIds.has(assignee.id));
      if (behavior && Array.isArray(behavior.logins)) {
        return behavior.logins.map((login) => String(login).toLowerCase());
      }
      return context.assignees.map((assignee) => String(assignee.login).toLowerCase());
    },
    addIssueAssignees: async (assignableId, actorIds) => {
      calls.push(['addIssueAssignees', assignableId, [...actorIds]]);
      const behavior = api.consumeAssigneeBehavior();
      const context = [...state.issueContextsByNumber.values()].find(
        (entry) => entry.issueId === assignableId,
      );
      if (!context) {
        throw new Error(`Missing issue assignable ${assignableId}`);
      }
      const existingIds = new Set(context.assignees.map((assignee) => assignee.id));
      for (const actorId of actorIds) {
        if (!existingIds.has(actorId)) {
          context.assignees.push({
            id: actorId,
            login: context.actorCatalog[actorId] || `actor-${actorId}`,
          });
          existingIds.add(actorId);
        }
      }
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
      const postApplyError = updatePullStatePostApplyErrors.get(`${pullNumber}:${nextState}`);
      if (postApplyError) {
        throw postApplyError;
      }
      return structuredClone(pull);
    },
    addPrLabel: async (pullNumber, labelName) => {
      calls.push(['addPrLabel', pullNumber, labelName]);
      const pull = state.pulls.find((entry) => entry.number === pullNumber);
      if (pull) {
        if (!Array.isArray(pull.labels)) pull.labels = [];
        if (!pull.labels.some((l) => l.name === labelName)) {
          pull.labels.push({ name: labelName });
        }
      }
    },
    removePrLabel: async (pullNumber, labelName) => {
      calls.push(['removePrLabel', pullNumber, labelName]);
      const pull = state.pulls.find((entry) => entry.number === pullNumber);
      if (pull && Array.isArray(pull.labels)) {
        pull.labels = pull.labels.filter((l) => l.name !== labelName);
      }
    },
    addIssueLabel: async (issueNumber, labelName) => {
      calls.push(['addIssueLabel', issueNumber, labelName]);
      const issue = [...linkedIssuesByPull.values()]
        .flat()
        .find((entry) => entry.number === issueNumber);
      if (issue) {
        if (Array.isArray(issue.labels)) {
          if (!issue.labels.some((label) => label.name === labelName)) {
            issue.labels.push({ name: labelName });
          }
        } else {
          issue.labels = { nodes: [...(issue.labels?.nodes || []), { name: labelName }] };
        }
      }
    },
    addIssueComment: async (issueNumber, body) => {
      calls.push(['addIssueComment', issueNumber, body]);
    },
  };

  const log = {
    info: (message) => logs.push(['info', message]),
    warning: (message) => logs.push(['warning', message]),
    error: (message) => logs.push(['error', message]),
  };

  return { api, calls, logs, state, log };
}

test('workflow runs trusted default-branch script with single global concurrency group', () => {
  assert.equal(workflow.permissions.contents, 'read');
  assert.equal(workflow.permissions['pull-requests'], undefined);
  assert.equal(workflow.jobs['enforce-pr-state']['timeout-minutes'], 15);
  assert.equal(workflow.jobs['enforce-pr-state'].concurrency.group, 'pr-ready-reviewer-guard');
  assert.equal(workflow.jobs['enforce-pr-state'].concurrency['cancel-in-progress'], false);
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

test('event-triggered runs inspect only the triggering pull request', async () => {
  const secondPr = makePr({
    number: 43,
    node_id: 'PR_43',
    head: {
      sha: 'b'.repeat(40),
      ref: 'copilot/other-pr',
      repo: { full_name: REPOSITORY },
    },
  });
  const harness = createHarness({
    pulls: [makePr(), secondPr],
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
    emptyDraftRepairs: 1,
    humanReviewerRequests: 0,
  });
  assert.equal(
    harness.calls.some(([name]) => name === 'listOpenPulls'),
    false,
  );
  assert.equal(
    harness.calls.some(([, pullNumber]) => pullNumber === 43),
    false,
  );
});

test('scheduled sweeps still enumerate all open pull requests', async () => {
  const secondPr = makePr({
    number: 43,
    node_id: 'PR_43',
    draft: false,
    head: {
      sha: 'b'.repeat(40),
      ref: 'copilot/other-pr',
      repo: { full_name: REPOSITORY },
    },
  });
  const harness = createHarness({
    pulls: [makePr({ draft: false }), secondPr],
  });

  const summary = await runPrReadyReviewerGuard({
    repository: REPOSITORY,
    reviewerLoginRaw: 'nalfeo',
    eventName: 'schedule',
    payloadAction: undefined,
    triggeringPullNumber: undefined,
    api: harness.api,
    log: harness.log,
    now: NOW,
  });

  assert.deepEqual(summary, {
    draftsPublished: 0,
    emptyDraftRepairs: 0,
    humanReviewerRequests: 0,
  });
  assert.deepEqual(
    harness.calls.filter(([name]) => name === 'listOpenPulls'),
    [['listOpenPulls']],
  );
});

test('event-triggered runs fail closed when the triggering pull request number is missing', async () => {
  const harness = createHarness();

  const summary = await runPrReadyReviewerGuard({
    repository: REPOSITORY,
    reviewerLoginRaw: 'nalfeo',
    eventName: 'pull_request_target',
    payloadAction: 'opened',
    triggeringPullNumber: undefined,
    api: harness.api,
    log: harness.log,
    now: NOW,
  });

  assert.deepEqual(summary, {
    draftsPublished: 0,
    emptyDraftRepairs: 0,
    humanReviewerRequests: 0,
  });
  assert.deepEqual(harness.calls, []);
  assert.ok(
    harness.logs.some(
      ([level, message]) =>
        level === 'warning' && message.includes('invalid triggering pull request number'),
    ),
  );
});

for (const [name, mutate, expectedReason] of [
  ['non-draft', (input) => (input.pr.draft = false), 'not-draft'],
  ['fork', (input) => (input.pr.head.repo.full_name = 'attacker/Crawler'), 'fork'],
  [
    'repair label present',
    (input) => (input.pr.labels = [{ name: EMPTY_DRAFT_REPAIR_LABEL }]),
    'already-repaired',
  ],
  ['non-copilot author', (input) => (input.pr.user.login = 'octocat'), 'author=octocat'],
  ['non-empty diff', (input) => (input.changedFiles = 2), 'changed-files=2'],
  ['missing linked issue', (input) => (input.linkedIssues = []), 'linked-issue-count=0'],
  [
    'cross-repo linked issue only (no same-repo issues)',
    (input) =>
      (input.linkedIssues = [
        makeLinkedIssue({ repository: { nameWithOwner: 'nalfeo/OtherRepo' } }),
      ]),
    'linked-issue-count=0',
  ],
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

test('repair inspection rejects cross-repo issue with same number, passes if only same-repo issue present', () => {
  // A cross-repo issue with same number as the expected local issue must be filtered out
  const crossRepoIssue = makeLinkedIssue({
    id: 'CROSS_REPO_ISSUE_1067',
    number: 1067,
    repository: { nameWithOwner: 'nalfeo/OtherRepo' },
  });
  const sameRepoIssue = makeLinkedIssue({
    id: 'ISSUE_1067',
    number: 1067,
    repository: { nameWithOwner: REPOSITORY },
  });

  // Only cross-repo issue → filtered out → count=0
  const crossOnly = inspectEmptyCopilotDraftRepair({
    pr: makePr(),
    changedFiles: 0,
    linkedIssues: [crossRepoIssue],
    runs: [makeRun()],
    repository: REPOSITORY,
    now: NOW,
  });
  assert.deepEqual(crossOnly, { eligible: false, reason: 'linked-issue-count=0' });

  // Cross-repo + same-repo → only same-repo counts → count=1, eligible
  const mixed = inspectEmptyCopilotDraftRepair({
    pr: makePr(),
    changedFiles: 0,
    linkedIssues: [crossRepoIssue, sameRepoIssue],
    runs: [makeRun()],
    repository: REPOSITORY,
    now: NOW,
  });
  assert.equal(mixed.eligible, true);
  assert.equal(mixed.linkedIssue.id, 'ISSUE_1067');
});

test('repair inspection confirmation rejects by node id drift, not just number change', () => {
  // Even if the number matches, a different node id (e.g. cross-repo swap) is rejected
  const original = inspectEmptyCopilotDraftRepair({
    pr: makePr(),
    changedFiles: 0,
    linkedIssues: [makeLinkedIssue()],
    runs: [makeRun()],
    repository: REPOSITORY,
    now: NOW,
  });
  assert.equal(original.eligible, true);

  // Confirmation with same number but different node id → rejected
  const confirmed = inspectEmptyCopilotDraftRepair({
    pr: makePr(),
    changedFiles: 0,
    linkedIssues: [makeLinkedIssue({ id: 'DIFFERENT_NODE_ID' })],
    runs: [makeRun()],
    repository: REPOSITORY,
    now: NOW,
    expectedIssueId: original.linkedIssue.id,
  });
  assert.deepEqual(confirmed, { eligible: false, reason: 'linked-issue-changed=1067' });
});

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

test('matchingCopilotCloudRunRejection skips absent workflow identity fields (graceful degradation)', () => {
  const minimalRun = {
    id: 999,
    head_sha: HEAD_SHA,
    head_branch: HEAD_BRANCH,
    actor: { login: 'Copilot' },
    // path/workflow_id/repository identity intentionally absent — endpoint already constrains by
    // workflow id, so absent fields should not hard-reject a run
  };
  assert.equal(
    matchingCopilotCloudRunRejection({
      run: minimalRun,
      repository: REPOSITORY,
      headSha: HEAD_SHA,
      headBranch: HEAD_BRANCH,
    }),
    null,
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

test('matchingCopilotCloudRunRejection rejects run with wrong workflow id', () => {
  const wrongWorkflowIdRun = makeRun({ workflow_id: COPILOT_CLOUD_AGENT_WORKFLOW_ID + 1 });
  assert.equal(
    matchingCopilotCloudRunRejection({
      run: wrongWorkflowIdRun,
      repository: REPOSITORY,
      headSha: HEAD_SHA,
      headBranch: HEAD_BRANCH,
    }),
    'workflow-id',
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
    new RegExp(`/actions/workflows/${COPILOT_CLOUD_AGENT_WORKFLOW_ID}/runs\\?branch=`),
  );
  assert.ok(!seenPaths[0].includes('dynamic%2Fcopilot-swe-agent%2Fcopilot'));
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
    humanReviewerRequests: 0,
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
    humanReviewerRequests: 0,
  });
  assert.equal(
    harness.calls.filter(
      ([name]) => name === 'removeIssueAssignees' || name === 'addIssueAssignees',
    ).length,
    2,
  );
  assert.deepEqual(
    harness.calls
      .filter(([name]) => name === 'removeIssueAssignees' || name === 'addIssueAssignees')
      .map(([, assignableId, actorIds]) => [assignableId, actorIds]),
    [
      ['ISSUE_1067', ['BOT_COPILOT']],
      ['ISSUE_1067', ['BOT_COPILOT']],
    ],
  );
  assert.ok(
    harness.calls.some(
      ([name, issueNumber, labelName]) =>
        name === 'addIssueLabel' && issueNumber === 1067 && labelName === EMPTY_DRAFT_REPAIR_LABEL,
    ),
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

test('repeat empty-draft repair closes the shell and escalates without reassigning Copilot', async () => {
  const harness = createHarness({
    linkedIssuesByPull: new Map([
      [
        42,
        [
          makeLinkedIssue({
            labels: { nodes: [{ name: EMPTY_DRAFT_REPAIR_LABEL }] },
          }),
        ],
      ],
    ]),
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
    draftsPublished: 0,
    emptyDraftRepairs: 1,
    humanReviewerRequests: 0,
  });
  assert.deepEqual(
    harness.calls
      .filter(([name]) => name === 'removeIssueAssignees' || name === 'addIssueAssignees')
      .map(([, assignableId, actorIds]) => [assignableId, actorIds]),
    [['ISSUE_1067', ['BOT_COPILOT']]],
  );
  assert.ok(
    harness.calls.some(
      ([name, issueNumber, labelName]) =>
        name === 'addIssueLabel' &&
        issueNumber === 1067 &&
        labelName === EMPTY_DRAFT_REPEAT_TRIAGE_LABEL,
    ),
  );
  assert.ok(
    harness.calls.some(
      ([name, issueNumber, body]) =>
        name === 'addIssueComment' &&
        issueNumber === 1067 &&
        body.includes('closed without reassigning Copilot again'),
    ),
  );
  assert.ok(
    harness.logs.some(
      ([level, message]) =>
        level === 'info' &&
        message.includes('Escalated repeat empty Copilot draft PR #42') &&
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
    ([name]) => name === 'removeIssueAssignees' || name === 'addIssueAssignees',
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
    humanReviewerRequests: 0,
  });
  assert.equal(
    harness.calls.filter(
      ([name]) => name === 'removeIssueAssignees' || name === 'addIssueAssignees',
    ).length,
    firstReplaceCount,
  );
});

test('a successful repair does not remove a requested human reviewer', async () => {
  const harness = createHarness({
    pulls: [
      makePr({
        requested_reviewers: [{ login: 'helper' }, { login: 'NalFeO' }],
      }),
    ],
  });

  const summary = await runPrReadyReviewerGuard({
    repository: REPOSITORY,
    reviewerLoginRaw: 'NALFEO',
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
    emptyDraftRepairs: 1,
    humanReviewerRequests: 0,
  });
  assert.equal(
    harness.calls.some(([name]) => name === 'requestReviewer'),
    false,
  );
  assert.deepEqual(harness.state.pulls[0].requested_reviewers, [
    { login: 'helper' },
    { login: 'NalFeO' },
  ]);
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
    humanReviewerRequests: 0,
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
    humanReviewerRequests: 0,
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
    humanReviewerRequests: 0,
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
      .filter(
        ([name]) =>
          name === 'updatePullState' ||
          name === 'removeIssueAssignees' ||
          name === 'addIssueAssignees',
      )
      .map(([name, a, b]) => [name, a, b]),
    [
      ['updatePullState', 42, 'closed'],
      ['removeIssueAssignees', 'ISSUE_1067', ['BOT_COPILOT']],
      ['addIssueAssignees', 'ISSUE_1067', ['BOT_COPILOT']],
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
    harness.calls.filter(
      ([name]) => name === 'removeIssueAssignees' || name === 'addIssueAssignees',
    ),
    [],
  );
  assert.deepEqual(
    harness.calls.filter(([name]) => name === 'updatePullState'),
    [['updatePullState', 42, 'closed']],
  );
});

test('ambiguous close write is treated as closed and included in rollback path', async () => {
  const harness = createHarness({
    updatePullStatePostApplyErrors: new Map([['42:closed', new Error('response body truncated')]]),
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
      log: harness.log,
      now: NOW,
    }),
    /Failed to repair 1 empty Copilot draft PR shell\(s\)/,
  );
  assert.equal(
    harness.calls.some(([name]) => name === 'getPull'),
    true,
    'should re-read PR state when close request throws',
  );
  assert.deepEqual(
    harness.calls
      .filter(
        ([name]) =>
          name === 'updatePullState' ||
          name === 'removeIssueAssignees' ||
          name === 'addIssueAssignees',
      )
      .map(([name, a, b]) => [name, a, b]),
    [
      ['updatePullState', 42, 'closed'],
      ['removeIssueAssignees', 'ISSUE_1067', ['BOT_COPILOT']],
      ['addIssueAssignees', 'ISSUE_1067', ['BOT_COPILOT']],
      ['updatePullState', 42, 'open'],
    ],
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
      .filter(
        ([name]) =>
          name === 'updatePullState' ||
          name === 'removeIssueAssignees' ||
          name === 'addIssueAssignees',
      )
      .map(([name, a, b]) => [name, a, b]),
    [
      ['updatePullState', 42, 'closed'],
      ['removeIssueAssignees', 'ISSUE_1067', ['BOT_COPILOT']],
      ['addIssueAssignees', 'ISSUE_1067', ['BOT_COPILOT']],
      ['addIssueAssignees', 'ISSUE_1067', ['BOT_COPILOT']],
      ['updatePullState', 42, 'open'],
    ],
  );
});

test('rollback surfaces issue-restore failure while preserving the original repair error', async () => {
  const harness = createHarness({
    replacePlan: [new Error('remove failed'), new Error('restore failed')],
  });
  await assert.rejects(
    runPrReadyReviewerGuard({
      repository: REPOSITORY,
      reviewerLoginRaw: 'nalfeo',
      eventName: 'schedule',
      payloadAction: undefined,
      triggeringPullNumber: undefined,
      api: harness.api,
      log: harness.log,
      now: NOW,
    }),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal(error.errors.length, 1);
      const nested = error.errors[0]?.cause;
      assert.equal(nested instanceof AggregateError, true);
      assert.equal(nested.errors.length, 2);
      assert.match(String(nested.errors[0]?.message || ''), /remove failed/);
      assert.match(
        String(nested.errors[1]?.message || ''),
        /issue rollback failed: restore failed/,
      );
      return true;
    },
  );
  assert.deepEqual(
    harness.calls
      .filter(
        ([name]) =>
          name === 'updatePullState' ||
          name === 'removeIssueAssignees' ||
          name === 'addIssueAssignees',
      )
      .map(([name, a, b]) => [name, a, b]),
    [
      ['updatePullState', 42, 'closed'],
      ['removeIssueAssignees', 'ISSUE_1067', ['BOT_COPILOT']],
      ['addIssueAssignees', 'ISSUE_1067', ['BOT_COPILOT']],
      ['updatePullState', 42, 'open'],
    ],
  );
});

test('rollback surfaces PR-reopen failure while preserving the original repair error', async () => {
  const harness = createHarness({
    replacePlan: [new Error('remove failed')],
    updatePullStateErrors: new Map([['42:open', new Error('reopen failed')]]),
  });
  await assert.rejects(
    runPrReadyReviewerGuard({
      repository: REPOSITORY,
      reviewerLoginRaw: 'nalfeo',
      eventName: 'schedule',
      payloadAction: undefined,
      triggeringPullNumber: undefined,
      api: harness.api,
      log: harness.log,
      now: NOW,
    }),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal(error.errors.length, 1);
      const nested = error.errors[0]?.cause;
      assert.equal(nested instanceof AggregateError, true);
      assert.equal(nested.errors.length, 2);
      assert.match(String(nested.errors[0]?.message || ''), /remove failed/);
      assert.match(String(nested.errors[1]?.message || ''), /PR reopen failed: reopen failed/);
      return true;
    },
  );
  assert.deepEqual(
    harness.calls
      .filter(
        ([name]) =>
          name === 'updatePullState' ||
          name === 'removeIssueAssignees' ||
          name === 'addIssueAssignees',
      )
      .map(([name, a, b]) => [name, a, b]),
    [
      ['updatePullState', 42, 'closed'],
      ['removeIssueAssignees', 'ISSUE_1067', ['BOT_COPILOT']],
      ['addIssueAssignees', 'ISSUE_1067', ['BOT_COPILOT']],
      ['updatePullState', 42, 'open'],
    ],
  );
});

test('rollback surfaces both issue-restore and PR-reopen failures', async () => {
  const harness = createHarness({
    replacePlan: [new Error('remove failed'), new Error('restore failed')],
    updatePullStateErrors: new Map([['42:open', new Error('reopen failed')]]),
  });
  await assert.rejects(
    runPrReadyReviewerGuard({
      repository: REPOSITORY,
      reviewerLoginRaw: 'nalfeo',
      eventName: 'schedule',
      payloadAction: undefined,
      triggeringPullNumber: undefined,
      api: harness.api,
      log: harness.log,
      now: NOW,
    }),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal(error.errors.length, 1);
      const nested = error.errors[0]?.cause;
      assert.equal(nested instanceof AggregateError, true);
      assert.equal(nested.errors.length, 3);
      assert.match(String(nested.errors[0]?.message || ''), /remove failed/);
      assert.match(
        String(nested.errors[1]?.message || ''),
        /issue rollback failed: restore failed/,
      );
      assert.match(String(nested.errors[2]?.message || ''), /PR reopen failed: reopen failed/);
      return true;
    },
  );
  assert.deepEqual(
    harness.calls
      .filter(
        ([name]) =>
          name === 'updatePullState' ||
          name === 'removeIssueAssignees' ||
          name === 'addIssueAssignees',
      )
      .map(([name, a, b]) => [name, a, b]),
    [
      ['updatePullState', 42, 'closed'],
      ['removeIssueAssignees', 'ISSUE_1067', ['BOT_COPILOT']],
      ['addIssueAssignees', 'ISSUE_1067', ['BOT_COPILOT']],
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
    humanReviewerRequests: 0,
  });
  assert.equal(
    harness.calls.some(([name]) => name === 'markReadyForReview'),
    true,
  );
  assert.equal(
    harness.calls.some(([name]) => name === 'removeIssueAssignees' || name === 'addIssueAssignees'),
    false,
  );
});

test('a human-gated PR preserves an existing nalfeo review request', async () => {
  const harness = createHarness({
    pulls: [
      makePr({
        draft: false,
        requested_reviewers: [{ login: 'nalfeo' }],
        labels: [{ name: 'human-approval-required' }],
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
    humanReviewerRequests: 0,
  });
  assert.equal(
    harness.calls.some(([name]) => name === 'requestReviewer'),
    false,
  );
  assert.deepEqual(harness.state.pulls[0].requested_reviewers, [{ login: 'nalfeo' }]);
});

test('requests nalfeo only for every canonical human-approval gate', async () => {
  const branchGated = makePr({
    number: 43,
    node_id: 'PR_43',
    draft: false,
    head: {
      sha: 'b'.repeat(40),
      ref: 'copilot/balance-telemetry-smoke',
      repo: { full_name: REPOSITORY },
    },
  });
  const closingIssueGated = makePr({
    number: 44,
    node_id: 'PR_44',
    draft: false,
    head: {
      sha: 'c'.repeat(40),
      ref: 'copilot/closing-issue-gate',
      repo: { full_name: REPOSITORY },
    },
  });
  const ungated = makePr({
    number: 45,
    node_id: 'PR_45',
    draft: false,
    head: {
      sha: 'd'.repeat(40),
      ref: 'copilot/ungated',
      repo: { full_name: REPOSITORY },
    },
  });
  const harness = createHarness({
    pulls: [
      makePr({ draft: false, labels: [{ name: 'human-approval-required' }] }),
      branchGated,
      closingIssueGated,
      ungated,
    ],
    linkedIssuesByPull: new Map([
      [42, []],
      [43, []],
      [44, [makeLinkedIssue({ labels: [{ name: 'human-approval-required' }] })]],
      [45, []],
    ]),
  });

  const summary = await runPrReadyReviewerGuard({
    repository: REPOSITORY,
    reviewerLoginRaw: 'nalfeo',
    eventName: 'schedule',
    api: harness.api,
    log: harness.log,
    now: NOW,
  });

  assert.deepEqual(summary, {
    draftsPublished: 0,
    emptyDraftRepairs: 0,
    humanReviewerRequests: 3,
  });
  assert.deepEqual(
    harness.calls.filter(([name]) => name === 'requestReviewer'),
    [
      ['requestReviewer', 42, 'nalfeo'],
      ['requestReviewer', 43, 'nalfeo'],
      ['requestReviewer', 44, 'nalfeo'],
    ],
  );
  assert.deepEqual(harness.state.pulls[3].requested_reviewers, []);
});

test('skips a human-reviewer request when the reviewer authored the PR', async () => {
  const harness = createHarness({
    pulls: [
      makePr({
        draft: false,
        user: { login: 'NALFEO' },
        labels: [{ name: 'human-approval-required' }],
      }),
    ],
  });

  const summary = await runPrReadyReviewerGuard({
    repository: REPOSITORY,
    reviewerLoginRaw: 'nalfeo',
    eventName: 'schedule',
    api: harness.api,
    log: harness.log,
    now: NOW,
  });

  assert.deepEqual(summary, {
    draftsPublished: 0,
    emptyDraftRepairs: 0,
    humanReviewerRequests: 0,
  });
  assert.equal(
    harness.calls.some(([name]) => name === 'requestReviewer'),
    false,
  );
});

test('human-reviewer request failures fail the guard without removing reviewers', async () => {
  const harness = createHarness({
    pulls: [
      makePr({
        draft: false,
        labels: [{ name: 'human-approval-required' }],
      }),
    ],
  });
  harness.api.requestReviewer = async () => {
    throw new Error('request failed');
  };
  await assert.rejects(
    runPrReadyReviewerGuard({
      repository: REPOSITORY,
      reviewerLoginRaw: 'nalfeo',
      eventName: 'pull_request_target',
      payloadAction: 'review_requested',
      triggeringPullNumber: 42,
      api: harness.api,
      log: harness.log,
      now: NOW,
    }),
    /Failed to request a human reviewer for 1 PR\(s\)/,
  );
  assert.deepEqual(harness.state.pulls[0].requested_reviewers, []);
});

test('a repair failure does not suppress unchanged publication for other PRs', async () => {
  const failingPr = makePr();
  const publishPr = makePr({
    number: 43,
    node_id: 'PR_43',
    head: {
      sha: 'b'.repeat(40),
      ref: 'copilot/fix-real-work',
      repo: { full_name: REPOSITORY },
    },
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
});

test('a repair failure does not remove the requested human reviewer', async () => {
  const harness = createHarness({
    pulls: [
      makePr({
        requested_reviewers: [{ login: 'nalfeo' }],
      }),
    ],
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
    harness.calls.some(([name]) => name === 'requestReviewer'),
    false,
  );
});

test('repair is skipped and not repeated when PR has the repair marker label after a reopen', async () => {
  // Simulate a previously repaired PR that was reopened: it has the repair label,
  // state=open, draft=true, and zero changed files — everything else is eligible.
  // The guard must skip without making any writes.
  const harness = createHarness({
    pulls: [
      makePr({
        labels: [{ name: EMPTY_DRAFT_REPAIR_LABEL }],
      }),
    ],
  });

  const summary = await runPrReadyReviewerGuard({
    repository: REPOSITORY,
    reviewerLoginRaw: 'nalfeo',
    eventName: 'reopened',
    payloadAction: 'reopened',
    triggeringPullNumber: 42,
    api: harness.api,
    log: harness.log,
    now: NOW,
  });

  assert.deepEqual(summary, {
    draftsPublished: 0,
    emptyDraftRepairs: 0,
    humanReviewerRequests: 0,
  });
  assert.equal(
    harness.calls.some(
      ([name]) =>
        name === 'updatePullState' ||
        name === 'removeIssueAssignees' ||
        name === 'addIssueAssignees' ||
        name === 'removePrLabel',
    ),
    false,
    'no writes must be made for an already-repaired PR',
  );
  // Confirm PR state is unchanged: still open, still draft, still has the repair label
  const prAfter = harness.state.pulls[0];
  assert.equal(prAfter.state, 'open');
  assert.equal(prAfter.draft, true);
  assert.ok(prAfter.labels.some((l) => l.name === EMPTY_DRAFT_REPAIR_LABEL));
  assert.ok(
    harness.logs.some(
      ([level, message]) => level === 'info' && message.includes('already-repaired'),
    ),
  );
});

test('repair label is added before close and removed on rollback', async () => {
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
      log: harness.log,
      now: NOW,
    }),
    /Failed to repair 1 empty Copilot draft PR shell\(s\)/,
  );

  // Label must have been added before close
  const labelAddIdx = harness.calls.findIndex(([name]) => name === 'addPrLabel');
  const closeIdx = harness.calls.findIndex(
    ([name, _num, state]) => name === 'updatePullState' && state === 'closed',
  );
  assert.ok(labelAddIdx >= 0, 'addPrLabel must be called');
  assert.ok(closeIdx >= 0, 'close must be called');
  assert.ok(labelAddIdx < closeIdx, 'addPrLabel must precede close');

  // Label must have been removed during rollback
  assert.ok(
    harness.calls.some(([name]) => name === 'removePrLabel'),
    'removePrLabel must be called during rollback',
  );

  // PR was also reopened in rollback
  assert.ok(
    harness.calls.some(([name, _num, state]) => name === 'updatePullState' && state === 'open'),
  );
});

test('close failure removes the repair label before throwing so the PR is not permanently stuck', async () => {
  // Default harness: close throws and the ambiguity check sees the PR is still open → definite failure.
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
      log: harness.log,
      now: NOW,
    }),
    /Failed to repair 1 empty Copilot draft PR shell/,
  );

  assert.ok(
    harness.calls.some(
      ([name, , label]) => name === 'addPrLabel' && label === EMPTY_DRAFT_REPAIR_LABEL,
    ),
    'addPrLabel must have been called before the close attempt',
  );
  assert.ok(
    harness.calls.some(
      ([name, , label]) => name === 'removePrLabel' && label === EMPTY_DRAFT_REPAIR_LABEL,
    ),
    'removePrLabel must be called on definite close failure to unstick the PR',
  );
  // PR must not retain the label so a future scan can retry
  const prAfterClose = harness.state.pulls.find((p) => p.number === 42);
  assert.ok(
    !prAfterClose.labels?.some((l) => l.name === EMPTY_DRAFT_REPAIR_LABEL),
    'PR must not retain the repair label after a definite close failure',
  );
});

test('non-404 label removal failure during issue-mutation rollback is aggregated in the AggregateError', async () => {
  // removeIssueAssignees fails → rollback path runs → removePrLabel fails with non-404
  const harness = createHarness({
    replacePlan: [new Error('remove failed')],
  });
  const labelError = Object.assign(new Error('label API 500'), { status: 500 });
  harness.api.removePrLabel = async (pullNumber, labelName) => {
    harness.calls.push(['removePrLabel', pullNumber, labelName]);
    throw labelError;
  };

  await assert.rejects(
    runPrReadyReviewerGuard({
      repository: REPOSITORY,
      reviewerLoginRaw: 'nalfeo',
      eventName: 'schedule',
      payloadAction: undefined,
      triggeringPullNumber: undefined,
      api: harness.api,
      log: harness.log,
      now: NOW,
    }),
    (err) => {
      // Outer wrapper
      assert.match(err.message, /Failed to repair 1 empty Copilot draft PR shell/);
      // The AggregateError causes chain must include the label cleanup failure
      const causes = [err, ...(err.errors ?? [])];
      const causeMessages = causes.flatMap((e) => [
        e?.message ?? '',
        ...(e?.errors ?? []).map((ie) => ie?.message ?? ''),
      ]);
      assert.ok(
        causeMessages.some((m) => m.includes('label cleanup failed')),
        `expected "label cleanup failed" in cause chain; found: ${JSON.stringify(causeMessages)}`,
      );
      return true;
    },
  );

  assert.ok(
    harness.calls.some(([name]) => name === 'removePrLabel'),
    'removePrLabel must be attempted during rollback',
  );
});

test('non-404 label removal failure during post-close drift rollback surfaces as repair failure not silent skip', async () => {
  // Post-close drift: initial+confirmation reads show 0 files, post-close read shows 3 (drift).
  // removePrLabel throws a non-404 error → rollbackClose propagates → repair fails.
  const harness = createHarness({
    changedFilesByPull: new Map([[42, [0, 0, 3]]]),
  });
  const labelError = Object.assign(new Error('label API 500'), { status: 500 });
  harness.api.removePrLabel = async (pullNumber, labelName) => {
    harness.calls.push(['removePrLabel', pullNumber, labelName]);
    throw labelError;
  };

  await assert.rejects(
    runPrReadyReviewerGuard({
      repository: REPOSITORY,
      reviewerLoginRaw: 'nalfeo',
      eventName: 'schedule',
      payloadAction: undefined,
      triggeringPullNumber: undefined,
      api: harness.api,
      log: harness.log,
      now: NOW,
    }),
    /Failed to repair 1 empty Copilot draft PR shell/,
    'non-404 label removal failure must propagate as a repair failure rather than a silent skip',
  );

  assert.ok(
    harness.calls.some(([name]) => name === 'removePrLabel'),
    'removePrLabel must have been attempted during drift rollback',
  );
});

test('post-close drift rollback surfaces reopen failure while still attempting label cleanup', async () => {
  const harness = createHarness({
    changedFilesByPull: new Map([[42, [0, 0, 3]]]),
    updatePullStateErrors: new Map([['42:open', new Error('reopen failed')]]),
  });

  await assert.rejects(
    runPrReadyReviewerGuard({
      repository: REPOSITORY,
      reviewerLoginRaw: 'nalfeo',
      eventName: 'schedule',
      payloadAction: undefined,
      triggeringPullNumber: undefined,
      api: harness.api,
      log: harness.log,
      now: NOW,
    }),
    (err) => {
      assert.match(err.message, /Failed to repair 1 empty Copilot draft PR shell/);
      const causeMessages = [
        err.message,
        err.cause?.message,
        ...(err.errors ?? []).map((e) => e?.message),
      ]
        .filter(Boolean)
        .join('\n');
      assert.match(causeMessages, /PR reopen failed/);
      return true;
    },
  );

  assert.ok(
    harness.calls.some(
      ([name, num, state]) => name === 'updatePullState' && num === 42 && state === 'open',
    ),
    'rollback must attempt reopen',
  );
  assert.ok(
    harness.calls.some(([name]) => name === 'removePrLabel'),
    'rollback must still attempt repair-label cleanup even when reopen fails',
  );
});

test('post-close changed-files drift causes reopen and skip without issue writes', async () => {
  // Simulate: initial read = 0 files, confirmation = 0 files, then after close a
  // concurrent push lands and the post-close read shows 3 changed files.
  const harness = createHarness({
    changedFilesByPull: new Map([[42, [0, 0, 3]]]),
  });

  const summary = await runPrReadyReviewerGuard({
    repository: REPOSITORY,
    reviewerLoginRaw: 'nalfeo',
    eventName: 'schedule',
    payloadAction: undefined,
    triggeringPullNumber: undefined,
    api: harness.api,
    log: harness.log,
    now: NOW,
  });

  assert.deepEqual(summary, {
    draftsPublished: 0,
    emptyDraftRepairs: 0,
    humanReviewerRequests: 0,
  });
  // close was attempted
  assert.ok(
    harness.calls.some(
      ([name, num, st]) => name === 'updatePullState' && num === 42 && st === 'closed',
    ),
  );
  // PR was reopened after drift was detected
  assert.ok(
    harness.calls.some(
      ([name, num, st]) => name === 'updatePullState' && num === 42 && st === 'open',
    ),
  );
  // no issue mutation must have been made
  assert.equal(
    harness.calls.some(([name]) => name === 'removeIssueAssignees' || name === 'addIssueAssignees'),
    false,
  );
  // repair label must have been removed
  assert.ok(harness.calls.some(([name]) => name === 'removePrLabel'));
  // log mentions drift
  assert.ok(
    harness.logs.some(
      ([level, message]) => level === 'info' && message.includes('post-close-drift-files=3'),
    ),
  );
});

test('absent changed_files in initial PR read surfaces as a repair/publish error', async () => {
  const harness = createHarness();
  // Override getPull to return absent changed_files on the first call
  let callCount = 0;
  const originalGetPull = harness.api.getPull;
  harness.api.getPull = async (pullNumber) => {
    callCount += 1;
    if (callCount === 1) {
      harness.calls.push(['getPull', pullNumber]);
      const pull = harness.state.pulls.find((entry) => entry.number === pullNumber);
      return { ...structuredClone(pull) }; // no changed_files field
    }
    return originalGetPull(pullNumber);
  };

  await assert.rejects(
    runPrReadyReviewerGuard({
      repository: REPOSITORY,
      reviewerLoginRaw: 'nalfeo',
      eventName: 'schedule',
      payloadAction: undefined,
      triggeringPullNumber: undefined,
      api: harness.api,
      log: harness.log,
      now: NOW,
    }),
    /changed_files absent/,
  );
  assert.equal(
    harness.calls.some(([name]) => name === 'updatePullState' || name === 'removeIssueAssignees'),
    false,
    'no writes should be made when changed_files is absent',
  );
});

test('absent changed_files in confirmation read skips without close', async () => {
  // changedFilesForDraft succeeds (returns 0), but the re-read for confirmation
  // returns a PR without changed_files.
  const harness = createHarness();
  let callCount = 0;
  const originalGetPull = harness.api.getPull;
  harness.api.getPull = async (pullNumber) => {
    callCount += 1;
    const pull = harness.state.pulls.find((entry) => entry.number === pullNumber);
    if (callCount === 2) {
      // confirmation read — return PR without changed_files
      harness.calls.push(['getPull', pullNumber]);
      return { ...structuredClone(pull) };
    }
    return originalGetPull(pullNumber);
  };

  const summary = await runPrReadyReviewerGuard({
    repository: REPOSITORY,
    reviewerLoginRaw: 'nalfeo',
    eventName: 'schedule',
    payloadAction: undefined,
    triggeringPullNumber: undefined,
    api: harness.api,
    log: harness.log,
    now: NOW,
  });

  assert.deepEqual(summary, {
    draftsPublished: 0,
    emptyDraftRepairs: 0,
    humanReviewerRequests: 0,
  });
  assert.equal(
    harness.calls.some(([name]) => name === 'updatePullState'),
    false,
    'close must not be attempted when changed_files is absent in confirmation',
  );
  assert.ok(
    harness.logs.some(
      ([level, message]) => level === 'info' && message.includes('confirmed-changed-files-absent'),
    ),
  );
});

test('event-scoped run uses getPull and skips listOpenPulls', async () => {
  const pr42 = makePr({
    number: 42,
    node_id: 'PR_42',
    draft: false,
    requested_reviewers: [{ login: 'nalfeo' }],
  });
  const pr99 = makePr({
    number: 99,
    node_id: 'PR_99',
    draft: false,
    requested_reviewers: [{ login: 'nalfeo' }],
  });
  const harness = createHarness({
    pulls: [pr42, pr99],
    changedFilesByPull: new Map([
      [42, [0]],
      [99, [0]],
    ]),
    linkedIssuesByPull: new Map([
      [42, []],
      [99, []],
    ]),
    runsByHead: new Map(),
    issueContextsByNumber: new Map(),
  });

  const summary = await runPrReadyReviewerGuard({
    repository: REPOSITORY,
    reviewerLoginRaw: 'nalfeo',
    eventName: 'pull_request_target',
    payloadAction: 'review_requested',
    triggeringPullNumber: 42,
    api: harness.api,
    log: harness.log,
    now: NOW,
  });

  assert.deepEqual(summary, {
    draftsPublished: 0,
    emptyDraftRepairs: 0,
    humanReviewerRequests: 0,
  });
  // Must use getPull (single-PR fetch), not listOpenPulls
  assert.ok(
    harness.calls.some(([name, num]) => name === 'getPull' && num === 42),
    'getPull must be called with the triggering PR number',
  );
  assert.equal(
    harness.calls.some(([name]) => name === 'listOpenPulls'),
    false,
    'listOpenPulls must not be called',
  );
  // Only PR #42 was processed; PR #99 must not be touched
  assert.equal(
    harness.calls.some(([name, num]) => name === 'requestReviewer' && num === 99),
    false,
    'PR #99 must not be processed in event-scoped run',
  );
  assert.equal(
    harness.calls.some(([name]) => name === 'requestReviewer'),
    false,
  );
});

test('scheduled run uses listOpenPulls for full sweep, not single-PR fetch', async () => {
  const harness = createHarness({
    pulls: [makePr({ draft: false, requested_reviewers: [] })],
  });

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

  assert.ok(
    harness.calls.some(([name]) => name === 'listOpenPulls'),
    'listOpenPulls must be called for sweep',
  );
  assert.equal(
    harness.calls.some(([name]) => name === 'getPull'),
    false,
    'getPull must not be called for scheduled sweep',
  );
});

test('workflow_dispatch run uses listOpenPulls for full sweep', async () => {
  const harness = createHarness({
    pulls: [makePr({ draft: false, requested_reviewers: [] })],
  });

  await runPrReadyReviewerGuard({
    repository: REPOSITORY,
    reviewerLoginRaw: 'nalfeo',
    eventName: 'workflow_dispatch',
    payloadAction: undefined,
    triggeringPullNumber: undefined,
    api: harness.api,
    log: harness.log,
    now: NOW,
  });

  assert.ok(
    harness.calls.some(([name]) => name === 'listOpenPulls'),
    'listOpenPulls must be called for workflow_dispatch sweep',
  );
  assert.equal(
    harness.calls.some(([name]) => name === 'getPull'),
    false,
    'getPull must not be called for workflow_dispatch sweep',
  );
});

test('event-scoped run skips immediately when triggering PR is not open', async () => {
  const harness = createHarness({
    pulls: [makePr({ state: 'closed', draft: false })],
  });

  const summary = await runPrReadyReviewerGuard({
    repository: REPOSITORY,
    reviewerLoginRaw: 'nalfeo',
    eventName: 'pull_request_target',
    payloadAction: 'synchronize',
    triggeringPullNumber: 42,
    api: harness.api,
    log: harness.log,
    now: NOW,
  });

  assert.deepEqual(summary, {
    draftsPublished: 0,
    emptyDraftRepairs: 0,
    humanReviewerRequests: 0,
  });
  assert.ok(
    harness.calls.some(([name, num]) => name === 'getPull' && num === 42),
    'getPull must be called to inspect the triggering PR',
  );
  assert.equal(
    harness.calls.some(([name]) => name === 'markReadyForReview'),
    false,
  );
  assert.equal(
    harness.calls.some(([name]) => name === 'requestReviewer'),
    false,
  );
  assert.ok(harness.logs.some(([, msg]) => msg.includes('No open PRs found')));
});

test('all runs share a single global concurrency group to prevent sweep/event race conditions', () => {
  const group = String(workflow.jobs['enforce-pr-state'].concurrency.group || '');
  assert.equal(
    group,
    'pr-ready-reviewer-guard',
    'concurrency group must be a single global key to ensure mutual exclusion between sweeps and per-PR runs',
  );
  assert.equal(
    workflow.jobs['enforce-pr-state'].concurrency['cancel-in-progress'],
    false,
    'cancel-in-progress must be false to prevent mid-repair cancellation',
  );
});
