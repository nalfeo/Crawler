import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  decideGhIssue,
  normalizeGhIssue,
  normalizeGhLogin,
  readAllSync,
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
  assert.equal(
    normalizeGhLogin({ login: 'app/github-actions', is_bot: true }),
    'github-actions[bot]',
  );
  assert.equal(normalizeGhLogin({ login: 'Copilot', is_bot: true }), 'Copilot[bot]');
  assert.equal(
    normalizeGhLogin({ login: 'copilot-swe-agent[bot]', is_bot: true }),
    'copilot-swe-agent[bot]',
  );
  assert.equal(normalizeGhLogin({ login: 'nalfeo', is_bot: false }), 'nalfeo');
  assert.equal(normalizeGhLogin(undefined), '');
});

test('search and issue-view aliases produce the same canonical Actions eligibility', () => {
  const searchDecision = decide(
    ghIssue({ number: 4248, author: { login: 'github-actions[bot]', is_bot: false } }),
  );
  const issueViewDecision = decide(
    ghIssue({ number: 4248, author: { login: 'app/github-actions', is_bot: true } }),
  );

  assert.deepEqual(issueViewDecision, searchDecision);
  assert.equal(issueViewDecision.eligible, true);
  assert.equal(issueViewDecision.cohort, 'legacy-parity');
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

test('selection excludes an untrusted bot ahead of valid legacy-parity candidates', () => {
  const selected = selectGoobersIntakeIssues(
    [
      ghIssue({ number: 9, author: { login: 'untrusted-automation', is_bot: true } }),
      ghIssue({ number: 10 }),
      ghIssue({ number: 11, author: { login: 'github-actions[bot]', is_bot: false } }),
    ],
    { maintainerLogin: 'nalfeo', env: GOOBERS_ENV },
  );

  assert.deepEqual(
    selected.map((decision) => [decision.number, decision.cohort]),
    [
      [10, 'legacy-parity'],
      [11, 'legacy-parity'],
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

test('selection de-duplicates the approved/parity query overlap by issue number', () => {
  // The workflow runs a narrow approved query AND a broad parity query, so the
  // approved queue can never fall off the far side of the Search API's 1000
  // result cap. The same issue therefore appears twice.
  const approved = ghIssue({ number: 12, labels: [{ name: 'goobers:approved' }] });
  const selected = selectGoobersIntakeIssues(
    [approved, ghIssue({ number: 10 }), approved, ghIssue({ number: 10 })],
    { maintainerLogin: 'nalfeo', env: GOOBERS_ENV },
  );

  assert.deepEqual(
    selected.map((decision) => [decision.number, decision.cohort]),
    [
      [12, 'approved'],
      [10, 'legacy-parity'],
    ],
  );
});

test('goobers-run dispatches immediately on issue events and still sweeps hourly', () => {
  assert.match(WORKFLOW, /types:\s*\[opened,\s*reopened,\s*labeled\]/);
  assert.match(WORKFLOW, /- cron: '37 \* \* \* \*'/);
});

test('goobers-run selects candidates without a label filter and delegates the policy', () => {
  const searchBlock = WORKFLOW.slice(WORKFLOW.indexOf('search_open_unassigned() {'));
  const search = searchBlock.slice(0, searchBlock.indexOf('search_open_unassigned --label'));
  assert.ok(
    !search.includes("--label 'goobers:approved'"),
    'the shared candidate query must not pre-filter to approved issues, or the parity cohort is lost',
  );
  assert.match(search, /--json number,state,labels,assignees,author,isPullRequest/);
  // Approved issues are ALSO fetched by a narrow query so they can never fall
  // off the far side of GitHub Search's 1000-result cap behind older noise.
  assert.match(
    WORKFLOW,
    /search_open_unassigned --label 'goobers:approved' > "\$\{approved_file\}"/,
  );
  assert.match(WORKFLOW, /search_open_unassigned > "\$\{parity_file\}"/);
  assert.match(WORKFLOW, /jq -s 'add' "\$\{approved_file\}" "\$\{parity_file\}"/);
  assert.match(
    WORKFLOW,
    /node \.github\/scripts\/goobers\/intake-selection\.mjs \\\n\s+--candidates/,
  );
  assert.match(WORKFLOW, /LIFECYCLE_MUTATION_OWNER: \$\{\{ vars\.LIFECYCLE_MUTATION_OWNER \}\}/);
});

test('every legacy Copilot-assigning workflow reads the lane selector', () => {
  // A legacy assigner that cannot see the selector always concludes legacy owns
  // intake, and reassigns an issue Goobers is concurrently claiming.
  for (const file of ['issue-copilot-intake.yml', 'epic-reprocess.yml']) {
    const workflow = readFileSync(path.resolve('.github/workflows', file), 'utf8');
    assert.match(
      workflow,
      /LIFECYCLE_MUTATION_OWNER: \$\{\{ vars\.LIFECYCLE_MUTATION_OWNER \}\}/,
      `${file} must pass the implementation-claim lane selector to the intake library`,
    );
  }
});

test('the gaggle claim fence honors the cohort handed down by the trusted workflow', () => {
  assert.match(GAGGLE, /GOOBERS_INTAKE_COHORT/);
  assert.match(GAGGLE, /\(approved\|legacy-parity\|resume\) claimable=true ;;/);
  assert.doesNotMatch(GAGGLE, /index\("goobers:approved"\) != null/);
  assert.match(WORKFLOW, /- GOOBERS_INTAKE_COHORT/);
});

// --- stdin robustness -------------------------------------------------------
//
// Production incident: Goobers runs 33925493716 (#4252) and 33926202682 (#4253)
// both died in "Resolve Goobers recovery target" with
// `intake-selection: could not parse issue JSON from '-': EAGAIN: resource
// temporarily unavailable, read`. `gh ... | node ...` on the Actions runner
// handed the selector a NON-BLOCKING pipe, and a synchronous read of a
// non-blocking pipe reports EAGAIN whenever the writer has not produced the
// next bytes yet. The reader must wait, not fail.

/** A `read` implementation that replays a scripted sequence of pipe events. */
function scriptedReader(events) {
  const queue = [...events];
  return (buffer) => {
    const next = queue.shift();
    if (next === undefined) return 0;
    if (next === 0) return 0;
    if (next === 'EAGAIN') {
      const error = new Error('EAGAIN: resource temporarily unavailable, read');
      error.code = 'EAGAIN';
      throw error;
    }
    if (next === 'EOF') {
      const error = new Error('EOF: end of file, read');
      error.code = 'EOF';
      throw error;
    }
    return Buffer.from(next, 'utf8').copy(buffer);
  };
}

test('readAllSync waits through EAGAIN on a non-blocking pipe instead of failing', () => {
  const slept = [];
  const payload = '{"number":4252,"state":"open"}';

  // What the old `fs.readFileSync(0, 'utf8')` did on that same pipe: one
  // single-shot read, so the very first EAGAIN aborted the whole run.
  assert.throws(() => scriptedReader(['EAGAIN', payload])(Buffer.alloc(64)), { code: 'EAGAIN' });

  const text = readAllSync(0, {
    read: scriptedReader(['EAGAIN', 'EAGAIN', payload, 'EAGAIN', 0]),
    sleep: (ms) => slept.push(ms),
    now: () => 0,
  });

  assert.equal(text, payload);
  assert.equal(JSON.parse(text).number, 4252);
  assert.equal(slept.length, 3, 'each EAGAIN must yield before retrying, not spin');
});

test('readAllSync reassembles a payload split across pipe chunks', () => {
  const text = readAllSync(0, {
    read: scriptedReader(['{"number":', '4253,', '"state":"open"}', 'EOF']),
    sleep: () => {},
    now: () => 0,
  });

  assert.deepEqual(JSON.parse(text), { number: 4253, state: 'open' });
});

test('readAllSync gives up with an actionable message instead of hanging forever', () => {
  let clock = 0;
  assert.throws(
    () =>
      readAllSync(0, {
        read: scriptedReader(Array.from({ length: 100 }, () => 'EAGAIN')),
        sleep: () => {
          clock += 1000;
        },
        now: () => clock,
        timeoutMs: 50,
      }),
    /timed out after 50ms waiting for data/,
  );
});

test('the CLI parses real piped `gh` JSON and an explicit file path identically', () => {
  const script = path.resolve('.github/scripts/goobers/intake-selection.mjs');
  const issue = JSON.stringify({
    number: 4252,
    state: 'OPEN',
    author: { login: 'nalfeo', is_bot: false },
    labels: [{ name: 'goobers:approved' }],
    assignees: [],
  });
  const env = { ...process.env, LIFECYCLE_MUTATION_OWNER: 'goobers', ISSUE_OWNER: 'nalfeo' };

  const piped = execFileSync(process.execPath, [script, '--issue', '-'], {
    input: issue,
    encoding: 'utf8',
    env,
  });

  const directory = mkdtempSync(path.join(os.tmpdir(), 'goobers-intake-'));
  try {
    const file = path.join(directory, 'issue.json');
    writeFileSync(file, issue, 'utf8');
    const fromFile = execFileSync(process.execPath, [script, '--issue', file], {
      encoding: 'utf8',
      env,
    });
    assert.equal(fromFile, piped);
    assert.equal(JSON.parse(fromFile).eligible, true);
    assert.equal(JSON.parse(fromFile).number, 4252);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the CLI only recommends a file path when stdin could not be read', () => {
  const script = path.resolve('.github/scripts/goobers/intake-selection.mjs');
  const missing = path.join(os.tmpdir(), 'goobers-intake-file-that-does-not-exist.json');
  const result = spawnSync(process.execPath, [script, '--issue', missing], { encoding: 'utf8' });

  assert.equal(result.status, 2);
  assert.ok(result.stderr.includes(`could not read issue JSON from '${missing}'`));
  assert.doesNotMatch(result.stderr, /pass an explicit file path instead of '-'/);
});

test('goobers-run hands the selector a file, never a pipe on stdin', () => {
  // A file path is the only wiring that cannot lose the payload to a transient
  // pipe read error, so the workflow must never reintroduce `--issue -`.
  assert.doesNotMatch(
    WORKFLOW,
    /intake-selection\.mjs --issue -/,
    'piping into the selector is what EAGAIN killed in production; pass a file path',
  );
  const fileBacked = WORKFLOW.match(/intake-selection\.mjs --issue "\$\{?issue_file\}?"/g) ?? [];
  assert.equal(fileBacked.length, 2, 'both decide_issue and the run-start race guard read a file');
  assert.match(
    WORKFLOW,
    /--json number,state,labels,assignees,author > "\$\{issue_file\}"/,
    'decide_issue must capture `gh issue view` output to a file before selecting',
  );
  assert.match(
    WORKFLOW,
    /printf '%s' "\$issue_json" > "\$issue_file"/,
    'the run-start race guard must materialize its payload before selecting',
  );
});
