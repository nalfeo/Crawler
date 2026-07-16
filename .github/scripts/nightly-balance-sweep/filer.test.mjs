import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parse } from 'yaml';

import {
  APPROVAL_LABEL_METADATA,
  ISSUE_BODY,
  ISSUE_LABELS,
  ISSUE_TITLE,
  fileNightlyBalanceIssue,
} from './filer-lib.mjs';

const VALID_ENV = {
  GITHUB_REPOSITORY: 'nalfeo/Crawler',
  GITHUB_TOKEN: 'github-token',
  CRAWLER_CI_PAT: 'intake-token',
};

const EXPECTED_BODY = [
  '## Objective',
  'Examine eligible current telemetry, identify and rank up to 3 evidence-backed game-balance improvements, evaluate each independently with canonical sweeps, and ship only treatments supported by comparable aggregate evidence. Zero eligible ideas is a valid outcome and must produce no implementation PR.',
  '',
  '## Baseline eligibility — hard gate',
  '- Use only latest successful `weapon-sweep.yml` run on current `main` containing all six FINAL aggregate artifacts named `weapon-sweep-<weapon>`, 100 seeds per weapon.',
  '- Record run ID, UTC timestamp, exact head SHA, seed range/count, max frames/time budget, weapon list, and all behavior/config flags.',
  '- Never use individual/selected shards, partial artifacts, local smoke runs, hand-picked seeds, or mixed runs as baseline.',
  '- Analyze shipped/default runtime config. Default-off/experimental flags such as `weapon_personas=true` cannot justify shipped-game balance changes; an experiment-scoped run may only support explicitly experiment-scoped issue.',
  '- Verify baseline SHA still represents current main. Gameplay-affecting commits after it require fresh canonical GitHub Actions sweep; inability to dispatch/complete/download required artifacts => stop without implementation/PR.',
  '- No new eligible aggregate run since prior completed nightly analysis => stop without duplicate work.',
  '- State whether releases/tags and real-player telemetry exist. Never call headless simulations release/player telemetry or invent historical lookback.',
  '',
  '## Candidate eligibility — hard gate',
  'Propose UP TO 3 ranked ideas including zero; never fill a quota. Each at exact baseline SHA must prove exact aggregate fields/values measured symptom; causal telemetry attribution (timing/correlation/source plausibility are hypotheses); real Floor-1 headless/simulation production runtime reachability through enabling config; enabled-in-baseline feature/entity/mode/spawn table/flag; observable canonical metric expected to move. Registry entries, exports, labs/tests, empty config tables, disabled flags, dormant definitions, unreachable branches are ineligible. Never claim enemy/room/encounter/attack/damage source unless artifacts record it. Unknown/unproven rejects before ranking; missing attribution means telemetry/investigation, not tuning. Separate facts, hypotheses, source inspection.',
  '',
  '## Evaluation contract — hard gate',
  '- Evaluate each candidate independently, one code/config change at a time, identical seeds/weapons/flags/limits.',
  '- >10 runs via GitHub Actions dispatch; local/session is smoke only, cannot accept/reject.',
  '- Never bundle unmeasured ideas, infer marginal contribution from combined treatment, or substitute 10-seed indicative results.',
  '- Max 3 attempts per candidate; never tune around named seeds.',
  '- If independent canonical sweeps cannot run, no implementation/PR.',
  '- Accept/reject one before next; final accepted combination gets fresh canonical aggregate sweep.',
  '',
  '## Durable ledger',
  'Max 9 attempt rows. Each: rank/name, measured symptom, causal evidence, production runtime path, enabling config/flag, hypothesis, exact change, baseline/post metrics, sweep run/artifact URLs, verdict, accepted/rejected/blocked rationale. Rejected/blocked remain.',
  '',
  '## Mandatory human approval gate',
  'Gameplay PR contains `Closes #<this issue number>`, labels `human-approval-required` and `merge-train-blocked`, ready not draft; no merge-train, auto-merge, or merge; only exact standalone trimmed comment `APPROVED FOR CHECK-IN` by owner `nalfeo` unlocks; green CI/reviews/quoted text/substrings/others do not count; bad final treatment means close/abandon.',
  '',
  '## Acceptance evidence',
  'Up to 3 ranked eligible ideas (zero allowed/no PR), <=3 attempts each, complete ledger, aggregate comparable baseline/post artifacts, final judge, explicit approval status. Preserve normal verification/review-harness/ledger/handoff/determinism.',
  '',
  '@copilot Please execute this issue end-to-end, but obey every hard evidence gate and the mandatory human approval gate above.',
].join('\n');

function createApi({
  initialIssues = [],
  initialLabels = [{ name: 'human-approval-required' }],
} = {}) {
  const issues = [...initialIssues];
  const labels = [...initialLabels];
  const mutations = [];
  let nextIssueNumber = 1201;

  const paginate = async (token, path) => {
    assert.equal(token, VALID_ENV.GITHUB_TOKEN);
    if (path.endsWith('/labels')) {
      return labels;
    }
    if (path.includes('/issues?state=open')) {
      return issues.filter((issue) => issue.state !== 'closed');
    }
    throw new Error(`Unexpected paginate path: ${path}`);
  };

  const request = async (token, path, options) => {
    mutations.push({ token, path, options });
    if (path.endsWith('/labels') && options.method === 'POST') {
      labels.push({ ...options.body });
      return { data: options.body };
    }
    if (path.endsWith('/issues') && options.method === 'POST') {
      const issue = {
        ...options.body,
        number: nextIssueNumber,
        node_id: `ISSUE_${nextIssueNumber}`,
        state: 'open',
      };
      nextIssueNumber += 1;
      issues.push(issue);
      return { data: issue };
    }
    if (options.method === 'PATCH') {
      const number = Number(path.split('/').at(-1));
      const issue = issues.find((candidate) => candidate.number === number);
      Object.assign(issue, options.body);
      return { data: issue };
    }
    throw new Error(`Unexpected request: ${options.method} ${path}`);
  };

  return { issues, labels, mutations, paginate, request };
}

test('exports the exact title, labels, and hard-gated static body', () => {
  assert.equal(ISSUE_TITLE, 'balance: telemetry-driven nightly improvement sweep');
  assert.deepEqual(ISSUE_LABELS, [
    'bug',
    'automation',
    'telemetry',
    'simulation',
    'ai',
    'human-approval-required',
  ]);
  assert.equal(ISSUE_BODY, EXPECTED_BODY);
  assert.equal(
    ISSUE_BODY.endsWith(
      '@copilot Please execute this issue end-to-end, but obey every hard evidence gate and the mandatory human approval gate above.',
    ),
    true,
  );

  for (const heading of [
    '## Objective',
    '## Baseline eligibility — hard gate',
    '## Candidate eligibility — hard gate',
    '## Evaluation contract — hard gate',
    '## Durable ledger',
    '## Mandatory human approval gate',
    '## Acceptance evidence',
  ]) {
    assert.match(ISSUE_BODY, new RegExp(heading));
  }

  for (const forbidden of [
    'selected shards are sufficient',
    'dormant code is eligible',
    'correlation proves causation',
    'combined sweep can establish',
    'always propose 3',
    '10-seed results can accept',
  ]) {
    assert.doesNotMatch(ISSUE_BODY.toLowerCase(), new RegExp(forbidden));
  }
});

test('validates repository and both tokens before any API operation', async () => {
  for (const env of [
    { ...VALID_ENV, GITHUB_REPOSITORY: '' },
    { ...VALID_ENV, GITHUB_REPOSITORY: 'nalfeo' },
    { ...VALID_ENV, GITHUB_TOKEN: '' },
    { ...VALID_ENV, CRAWLER_CI_PAT: '' },
  ]) {
    let calls = 0;
    await assert.rejects(
      fileNightlyBalanceIssue({
        env,
        request: async () => {
          calls += 1;
        },
        paginate: async () => {
          calls += 1;
        },
        graphql: async () => {
          calls += 1;
        },
        runIssueIntakeFn: async () => {
          calls += 1;
        },
      }),
    );
    assert.equal(calls, 0);
  }
});

test('first run creates and intakes once; consecutive run is a strict mutation no-op', async () => {
  const api = createApi();
  const intakeCalls = [];
  const runIssueIntakeFn = async (args) => {
    intakeCalls.push(args);
    return { assignee: 'copilot-swe-agent', comment: 'posted' };
  };

  const first = await fileNightlyBalanceIssue({
    env: VALID_ENV,
    request: api.request,
    paginate: api.paginate,
    graphql: async () => {},
    runIssueIntakeFn,
  });
  assert.deepEqual(first, {
    status: 'created',
    issueNumber: 1201,
    intake: { assignee: 'copilot-swe-agent', comment: 'posted' },
  });
  assert.equal(api.mutations.length, 1);
  assert.deepEqual(api.mutations[0], {
    token: VALID_ENV.GITHUB_TOKEN,
    path: '/repos/nalfeo/Crawler/issues',
    options: {
      method: 'POST',
      body: { title: ISSUE_TITLE, body: ISSUE_BODY, labels: ISSUE_LABELS },
    },
  });
  assert.equal(intakeCalls.length, 1);
  assert.equal(intakeCalls[0].token, VALID_ENV.CRAWLER_CI_PAT);

  const mutationCount = api.mutations.length;
  const second = await fileNightlyBalanceIssue({
    env: VALID_ENV,
    request: api.request,
    paginate: api.paginate,
    graphql: async () => {},
    runIssueIntakeFn,
  });
  assert.deepEqual(second, { status: 'existing', issueNumber: 1201 });
  assert.equal(api.mutations.length, mutationCount);
  assert.equal(intakeCalls.length, 1);
});

test('ignores same-title pull requests and case-mismatched issue titles', async () => {
  const api = createApi({
    initialIssues: [
      { number: 8, title: ISSUE_TITLE, pull_request: { url: 'https://example.test/pr/8' } },
      { number: 9, title: ISSUE_TITLE.toUpperCase() },
    ],
  });

  const result = await fileNightlyBalanceIssue({
    env: VALID_ENV,
    request: api.request,
    paginate: api.paginate,
    graphql: async () => {},
    runIssueIntakeFn: async () => ({ assignee: 'copilot', comment: 'posted' }),
  });
  assert.equal(result.status, 'created');
  assert.equal(api.mutations.filter((call) => call.path.endsWith('/issues')).length, 1);
});

test('creates the approval label with repository metadata when absent', async () => {
  const api = createApi({ initialLabels: [] });

  await fileNightlyBalanceIssue({
    env: VALID_ENV,
    request: api.request,
    paginate: api.paginate,
    graphql: async () => {},
    runIssueIntakeFn: async () => ({ assignee: 'copilot', comment: 'posted' }),
  });

  assert.deepEqual(api.mutations[0], {
    token: VALID_ENV.GITHUB_TOKEN,
    path: '/repos/nalfeo/Crawler/labels',
    options: { method: 'POST', body: APPROVAL_LABEL_METADATA },
  });
});

test('continues when concurrent label creation returns 422', async () => {
  const api = createApi({ initialLabels: [] });
  const request = async (token, path, options) => {
    if (path.endsWith('/labels') && options.method === 'POST') {
      const error = new Error('already exists');
      error.status = 422;
      throw error;
    }
    return api.request(token, path, options);
  };

  const result = await fileNightlyBalanceIssue({
    env: VALID_ENV,
    request,
    paginate: api.paginate,
    graphql: async () => {},
    runIssueIntakeFn: async () => ({ assignee: 'copilot', comment: 'posted' }),
  });

  assert.equal(result.status, 'created');
  assert.equal(api.issues.length, 1);
});

test('closes its new issue instead of intaking when an earlier duplicate wins a race', async () => {
  const api = createApi();
  let intakeCalls = 0;
  const request = async (token, path, options) => {
    const response = await api.request(token, path, options);
    if (path.endsWith('/issues') && options.method === 'POST') {
      api.issues.unshift({ number: 1200, node_id: 'ISSUE_1200', title: ISSUE_TITLE });
    }
    return response;
  };

  const result = await fileNightlyBalanceIssue({
    env: VALID_ENV,
    request,
    paginate: api.paginate,
    graphql: async () => {},
    runIssueIntakeFn: async () => {
      intakeCalls += 1;
    },
  });

  assert.deepEqual(result, { status: 'race-duplicate-closed', issueNumber: 1200 });
  assert.equal(intakeCalls, 0);
  assert.equal(api.issues.find((issue) => issue.number === 1201).state, 'closed');
});

test('closes a newly created issue when intake fails and preserves the intake error', async () => {
  const api = createApi();
  const intakeError = new Error('intake failed');
  let thrown;

  try {
    await fileNightlyBalanceIssue({
      env: VALID_ENV,
      request: api.request,
      paginate: api.paginate,
      graphql: async () => {},
      runIssueIntakeFn: async () => {
        throw intakeError;
      },
    });
  } catch (error) {
    thrown = error;
  }

  assert.equal(thrown, intakeError);
  assert.deepEqual(api.mutations.at(-1), {
    token: VALID_ENV.GITHUB_TOKEN,
    path: '/repos/nalfeo/Crawler/issues/1201',
    options: {
      method: 'PATCH',
      body: { state: 'closed', state_reason: 'not_planned' },
    },
  });
  assert.equal(api.issues[0].state, 'closed');
});

test('reports cleanup failure without replacing the intake error', async () => {
  const api = createApi();
  const intakeError = new Error('intake failed');
  const cleanupError = new Error('cleanup failed');
  const reports = [];
  const request = async (token, path, options) => {
    if (options.method === 'PATCH') {
      throw cleanupError;
    }
    return api.request(token, path, options);
  };
  let thrown;

  try {
    await fileNightlyBalanceIssue({
      env: VALID_ENV,
      request,
      paginate: api.paginate,
      graphql: async () => {},
      runIssueIntakeFn: async () => {
        throw intakeError;
      },
      reportError: (message) => reports.push(message),
    });
  } catch (error) {
    thrown = error;
  }

  assert.equal(thrown, intakeError);
  assert.equal(thrown.cleanupError, cleanupError);
  assert.deepEqual(reports, ['Failed to close issue #1201 after intake failure: cleanup failed']);
});

test('workflow has the exact schedule, permissions, serialization, checkout, and secret scope', async () => {
  const workflowPath = new URL('../../workflows/nightly-balance-sweep.yml', import.meta.url);
  const workflow = parse(await readFile(workflowPath, 'utf8'));
  assert.deepEqual(workflow.on.schedule, [{ cron: '0 8 * * *' }]);
  assert.deepEqual(workflow.on.workflow_dispatch, {});
  assert.deepEqual(workflow.permissions, { contents: 'read', issues: 'write' });
  assert.deepEqual(workflow.concurrency, {
    group: 'nightly-balance-improvement-sweep',
    'cancel-in-progress': false,
  });
  assert.equal(workflow.env, undefined);

  const job = workflow.jobs['file-balance-sweep'];
  assert.equal(job['timeout-minutes'], 10);
  assert.equal(job.env, undefined);
  const checkout = job.steps.find((step) => step.uses === 'actions/checkout@v4');
  assert.deepEqual(checkout.with, {
    ref: '${{ github.event.repository.default_branch }}',
    'persist-credentials': false,
  });
  const execute = job.steps.find((step) => step.run);
  assert.equal(execute.run, 'node .github/scripts/nightly-balance-sweep/filer.mjs');
  assert.deepEqual(execute.env, {
    GITHUB_REPOSITORY: '${{ github.repository }}',
    GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
    CRAWLER_CI_PAT: '${{ secrets.CRAWLER_CI_PAT }}',
  });
});
