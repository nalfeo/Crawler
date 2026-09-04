import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  decideGhIssue,
  normalizeGhIssue,
  normalizeGhLogin,
  selectGoobersIntakeIssues,
} from './intake-selection.mjs';

const WORKFLOW = readFileSync(path.resolve('.github/workflows/goobers-run.yml'), 'utf8');
const GAGGLE = readFileSync(
  path.resolve('.goobers/gaggles/crawler/workflows/crawler-feature-pr.yaml'),
  'utf8',
);

const GOOBERS_ENV = { LIFECYCLE_MUTATION_OWNER: 'goobers' };

/** `gh` search/view record for an issue, with sensible eligible defaults. */
function ghIssue(overrides = {}) {
  return {
    number: 4242,
    state: 'open',
    author: { login: 'nalfeo', is_bot: false },
    labels: [],
    assignees: [],
    isPullRequest: false,
    ...overrides,
  };
}

function decide(entry, env = GOOBERS_ENV) {
  return decideGhIssue(entry, { maintainerLogin: 'nalfeo', env });
}

test('gh bot logins are restored to their REST [bot] form', () => {
  assert.equal(normalizeGhLogin({ login: 'github-actions', is_bot: true }), 'github-actions[bot]');
  assert.equal(normalizeGhLogin({ login: 'Copilot', is_bot: true }), 'Copilot[bot]');
  assert.equal(
    normalizeGhLogin({ login: 'copilot-swe-agent[bot]', is_bot: true }),
    'copilot-swe-agent[bot]',
  );
  assert.equal(normalizeGhLogin({ login: 'nalfeo', is_bot: false }), 'nalfeo');
  assert.equal(normalizeGhLogin(undefined), '');
});

test('gh records normalize onto the REST issue shape the canonical library consumes', () => {
  const normalized = normalizeGhIssue(
    ghIssue({
      state: 'OPEN',
      labels: [{ name: 'automation' }, { name: 'bug' }],
      assignees: [{ login: 'Copilot', is_bot: true }],
      author: { login: 'github-actions', is_bot: true },
    }),
  );

  assert.deepEqual(normalized, {
    number: 4242,
    state: 'open',
    user: { login: 'github-actions[bot]' },
    labels: [{ name: 'automation' }, { name: 'bug' }],
    assignees: [{ login: 'Copilot[bot]' }],
  });
});

test('gh pull-request records are rejected as ineligible payloads', () => {
  const decision = decide(ghIssue({ isPullRequest: true, url: 'https://github.com/o/r/pull/1' }));
  assert.deepEqual(decision, {
    number: 4242,
    eligible: false,
    cohort: null,
    reason: 'event has no eligible issue payload',
  });
});

test('the Goobers intake cohort is the union of approval and legacy eligibility', () => {
  const cases = [
    // --- Legacy-derived automatic intake: trusted openers ---
    { name: 'maintainer', entry: {}, eligible: true, cohort: 'legacy-parity' },
    {
      name: 'maintainer case-insensitively',
      entry: { author: { login: 'NALFEO' } },
      eligible: true,
      cohort: 'legacy-parity',
    },
    {
      name: 'GitHub Actions without automation label',
      entry: { author: { login: 'github-actions', is_bot: true } },
      eligible: true,
      cohort: 'legacy-parity',
    },
    {
      name: 'GitHub Actions with automation label',
      entry: {
        author: { login: 'github-actions', is_bot: true },
        labels: [{ name: 'automation' }],
      },
      eligible: true,
      cohort: 'legacy-parity',
    },
    {
      name: 'Copilot coding agent',
      entry: { author: { login: 'copilot-swe-agent', is_bot: true } },
      eligible: true,
      cohort: 'legacy-parity',
    },
    // --- Legacy exclusions, preserved verbatim ---
    {
      name: 'untrusted opener',
      entry: { author: { login: 'dependabot', is_bot: true } },
      eligible: false,
      reason: 'opener @dependabot[bot] is not trusted',
    },
    {
      name: 'telemetry issue',
      entry: { labels: [{ name: 'telemetry' }] },
      eligible: false,
      reason: 'telemetry issues are not assigned to Copilot',
    },
    {
      name: 'automation label without Actions provenance',
      entry: { labels: [{ name: 'automation' }] },
      eligible: false,
      reason: 'issue #4242 has automation label and was not opened by GitHub Actions',
    },
    // --- Explicit approval overrides the legacy trust cohort ---
    {
      name: 'approved issue from an untrusted opener',
      entry: {
        author: { login: 'outside-contributor' },
        labels: [{ name: 'goobers:approved' }],
      },
      eligible: true,
      cohort: 'approved',
    },
    {
      name: 'approved telemetry issue',
      entry: { labels: [{ name: 'telemetry' }, { name: 'GOOBERS:APPROVED' }] },
      eligible: true,
      cohort: 'approved',
    },
    // --- State exclusions: assigned, in-review, terminal ---
    {
      name: 'already assigned',
      entry: { assignees: [{ login: 'Copilot', is_bot: true }] },
      eligible: false,
      reason: 'issue #4242 already has an assignee',
    },
    {
      name: 'claimed by an in-review run',
      entry: { labels: [{ name: 'goobers/status:in-review' }] },
      eligible: false,
      reason: 'issue #4242 is already claimed by an in-review Goobers run',
    },
    {
      name: 'completed by existing work',
      entry: { labels: [{ name: 'goobers/status:completed-existing-work' }] },
      eligible: false,
      reason: 'issue #4242 was dispositioned as completed by existing work',
    },
    {
      name: 'closed issue',
      entry: { state: 'closed' },
      eligible: false,
      reason: 'issue #4242 is not open',
    },
  ];

  for (const entry of cases) {
    const decision = decide(ghIssue(entry.entry));
    assert.equal(decision.eligible, entry.eligible, entry.name);
    if (entry.cohort) assert.equal(decision.cohort, entry.cohort, entry.name);
    if (entry.reason) assert.equal(decision.reason, entry.reason, entry.name);
  }
});

test('a malformed or rolled-back selector leaves Goobers with no claim at all', () => {
  for (const owner of ['legacy', 'off', '', 'Goobers', 'goobers ', undefined]) {
    const decision = decide(ghIssue({ labels: [{ name: 'goobers:approved' }] }), {
      LIFECYCLE_MUTATION_OWNER: owner,
    });
    assert.deepEqual(
      decision,
      {
        number: 4242,
        eligible: false,
        cohort: null,
        reason: 'goobers does not own the implementation-claim lane',
      },
      `LIFECYCLE_MUTATION_OWNER=${String(owner)} must not select Goobers`,
    );
  }
});

test('selection prioritizes approved issues and otherwise preserves creation order', () => {
  const selected = selectGoobersIntakeIssues(
    [
      ghIssue({ number: 10 }),
      ghIssue({ number: 11, labels: [{ name: 'telemetry' }] }),
      ghIssue({ number: 12, labels: [{ name: 'goobers:approved' }] }),
      ghIssue({ number: 13 }),
      ghIssue({ number: 14, author: { login: 'stranger' } }),
      ghIssue({ number: 15, labels: [{ name: 'goobers:approved' }] }),
    ],
    { maintainerLogin: 'nalfeo', env: GOOBERS_ENV },
  );

  assert.deepEqual(
    selected.map((decision) => [decision.number, decision.cohort]),
    [
      [12, 'approved'],
      [15, 'approved'],
      [10, 'legacy-parity'],
      [13, 'legacy-parity'],
    ],
  );
});

test('selection drops records without a usable issue number', () => {
  assert.deepEqual(
    selectGoobersIntakeIssues([ghIssue({ number: 'not-a-number' }), ghIssue({ number: 0 })], {
      env: GOOBERS_ENV,
    }),
    [],
  );
  assert.deepEqual(selectGoobersIntakeIssues(null, { env: GOOBERS_ENV }), []);
});

test('goobers-run dispatches immediately on issue events and still sweeps hourly', () => {
  assert.match(WORKFLOW, /types:\s*\[opened,\s*reopened,\s*labeled\]/);
  assert.match(WORKFLOW, /- cron: '37 \* \* \* \*'/);
});

test('goobers-run selects candidates without a label filter and delegates the policy', () => {
  const searchBlock = WORKFLOW.slice(WORKFLOW.indexOf('gh search issues'));
  const search = searchBlock.slice(0, searchBlock.indexOf('> "${candidates_file}"'));
  assert.ok(
    !search.includes("--label 'goobers:approved'"),
    'the candidate query must not pre-filter to approved issues, or the parity cohort is lost',
  );
  assert.match(search, /--json number,state,labels,assignees,author,isPullRequest/);
  assert.match(
    WORKFLOW,
    /node \.github\/scripts\/goobers\/intake-selection\.mjs \\\n\s+--candidates/,
  );
  assert.match(WORKFLOW, /LIFECYCLE_MUTATION_OWNER: \$\{\{ vars\.LIFECYCLE_MUTATION_OWNER \}\}/);
});

test('the gaggle claim fence honors the cohort handed down by the trusted workflow', () => {
  assert.match(GAGGLE, /GOOBERS_INTAKE_COHORT/);
  assert.match(GAGGLE, /\(legacy-parity\|resume\) claimable=true ;;/);
  assert.match(WORKFLOW, /- GOOBERS_INTAKE_COHORT/);
});
