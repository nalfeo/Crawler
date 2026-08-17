/**
 * Subprocess regression tests for incident.mjs's auto-close decision.
 *
 * Each test writes a workflow_run event payload to a temp file, runs
 * incident.mjs as a child process against a local mock HTTP server, and
 * inspects which mutating calls (POST/PATCH) it issued.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./incident.mjs', import.meta.url));
const OWNER = 'test-owner';
const REPO = 'test-repo';
const TOKEN = 'x-test-token';
const TRUSTED_APP_ID = 987654;
const HEAD_SHA = 'abc1234def5678901234567890abcdef12345678';

/** A fully-trusted, completed, successful "merge-train" check-run for HEAD_SHA. */
function trustedTrainCheck(overrides = {}) {
  return {
    id: 1,
    name: 'merge-train',
    status: 'completed',
    conclusion: 'success',
    app: { id: TRUSTED_APP_ID },
    external_id: 'a'.repeat(64),
    output: { summary: 'promoted via merge train' },
    ...overrides,
  };
}

function startServer(routes) {
  const mutatingCalls = [];
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
        if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) {
          mutatingCalls.push({ method, url: req.url, body: parsed });
        }
        const exactKey = `${method} ${pathOnly}`;
        let handler = routes[exactKey];
        if (!handler) {
          const entry = Object.entries(routes).find(([k]) => {
            const space = k.indexOf(' ');
            const m = k.slice(0, space);
            const p = k.slice(space + 1);
            return (m === method || m === '*') && pathOnly.startsWith(p);
          });
          handler = entry?.[1];
        }
        if (handler) {
          const result = handler(req.url, parsed) ?? {};
          const status = result.status ?? 200;
          const bodyStr = result.body !== undefined ? JSON.stringify(result.body) : '{}';
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(bodyStr);
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, mutatingCalls });
    });
  });
}

async function runScript(port, workflowRun, env = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'incident-test-'));
  const eventPath = path.join(dir, 'event.json');
  writeFileSync(eventPath, JSON.stringify({ workflow_run: workflowRun }));

  const child = spawn(process.execPath, [SCRIPT], {
    env: {
      GITHUB_REPOSITORY: `${OWNER}/${REPO}`,
      GITHUB_API_URL: `http://127.0.0.1:${port}`,
      GITHUB_GRAPHQL_URL: `http://127.0.0.1:${port}/graphql`,
      GITHUB_EVENT_PATH: eventPath,
      CRAWLER_CI_PAT: TOKEN,
      MERGE_TRAIN_APP_ID: String(TRUSTED_APP_ID),
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

function isWindowsAsyncCloseCrash(code, stderr) {
  return process.platform === 'win32' && code === 3221226505 && /UV_HANDLE_CLOSING/.test(stderr);
}

// See reconcile.test.mjs for the full rationale: this subprocess+mock-server
// harness trips a known libuv teardown assertion on some Windows hosts,
// unrelated to incident.mjs's own logic. Real CI runs on Linux, where this
// never applies.
function assertSuccessfulExit(t, code, stderr, context = '', allowKnownWindowsFlake = false) {
  if (allowKnownWindowsFlake && isWindowsAsyncCloseCrash(code, stderr)) {
    t.skip('Node subprocess hit the known Windows UV_HANDLE_CLOSING shutdown assertion');
    return false;
  }
  assert.equal(code, 0, `${context ? `${context} ` : ''}expected exit 0; stderr: ${stderr}`);
  return true;
}

function pushRun(overrides = {}) {
  return {
    id: 555,
    name: 'CI',
    event: 'push',
    conclusion: 'success',
    status: 'completed',
    head_sha: HEAD_SHA,
    head_branch: 'main',
    html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/555`,
    actor: { login: 'octocat' },
    pull_requests: [],
    ...overrides,
  };
}

const OPEN_INCIDENT = {
  number: 101,
  title: 'CI incident: CI',
  pull_request: undefined,
};

const OPEN_DEPLOY_INCIDENT = {
  number: 202,
  title: 'CI incident: Deploy to GitHub Pages',
  pull_request: undefined,
};

test('does not auto-close an open incident on a train-fast-path (docs_only) push success', async (t) => {
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/issues`]: () => ({ body: [OPEN_INCIDENT] }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [trustedTrainCheck()] },
    }),
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, pushRun(), {
    MERGE_TRAIN_ENABLED: 'true',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.match(stdout, /skip auto-close .*reason=train-fast-path-success/);
  assert.deepEqual(mutatingCalls, [], 'must not PATCH/close the incident issue');
});

test('does NOT misclassify a stale trusted train check as fast-path once MERGE_TRAIN_ENABLED is false (post-rollback)', async (t) => {
  // Regression: after a flag-off rollback, a SHA can still carry an old
  // trusted "merge-train" check-run (check-runs persist forever on the
  // commit). A later genuine full-CI rerun on that same SHA must still be
  // able to auto-close a real open incident -- the fast-path shortcut must
  // require the exact rollout flag, not just the check's presence.
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/issues`]: () => ({ body: [OPEN_INCIDENT] }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [trustedTrainCheck()] },
    }),
    [`PATCH /repos/${OWNER}/${REPO}/issues/101`]: () => ({ body: { number: 101 } }),
    [`POST /repos/${OWNER}/${REPO}/issues/101/comments`]: () => ({ body: { id: 1 } }),
  });
  t.after(() => server.close());

  // MERGE_TRAIN_ENABLED intentionally omitted: parseEnabledFlag defaults an
  // unset/rolled-back flag to false.
  const { code, stdout, stderr } = await runScript(port, pushRun());

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.match(stdout, /closed incident issue=#101/);
  assert.equal(
    mutatingCalls.filter(
      (call) => call.method === 'PATCH' && call.url === `/repos/${OWNER}/${REPO}/issues/101`,
    ).length,
    1,
    'a stale trusted train check must not block auto-close once the flag is off',
  );
});

test('rejects a malformed MERGE_TRAIN_ENABLED value instead of silently defaulting', async (t) => {
  const { server, port } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/issues`]: () => ({ body: [OPEN_INCIDENT] }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [] },
    }),
  });
  t.after(() => server.close());

  const { code, stderr } = await runScript(port, pushRun(), { MERGE_TRAIN_ENABLED: 'True' });

  assert.notEqual(code, 0, 'a non-exact flag value must fail fast, not be coerced');
  assert.match(stderr, /MERGE_TRAIN_ENABLED must be true or false/);
});

test('auto-closes an open incident on a genuine (non-train) push success', async (t) => {
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/issues`]: () => ({ body: [OPEN_INCIDENT] }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [] },
    }),
    [`PATCH /repos/${OWNER}/${REPO}/issues/101`]: () => ({ body: { number: 101 } }),
    [`POST /repos/${OWNER}/${REPO}/issues/101/comments`]: () => ({ body: { id: 1 } }),
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, pushRun());

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.match(stdout, /closed incident issue=#101/);
  assert.equal(
    mutatingCalls.filter(
      (call) => call.method === 'PATCH' && call.url === `/repos/${OWNER}/${REPO}/issues/101`,
    ).length,
    1,
  );
});

test('does not auto-close a Pages incident on a stale successful run that skipped deploy', async (t) => {
  const runId = 777;
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/issues`]: () => ({ body: [OPEN_DEPLOY_INCIDENT] }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [] },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs/${runId}/jobs`]: () => ({
      body: {
        jobs: [
          { name: 'release-gate', conclusion: 'success' },
          { name: 'deploy', conclusion: 'skipped' },
          { name: 'Baseline win-rate sweep (100 seeds)', conclusion: 'skipped' },
        ],
      },
    }),
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(
    port,
    pushRun({
      id: runId,
      name: 'Deploy to GitHub Pages',
      event: 'workflow_run',
      html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/${runId}`,
    }),
  );

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.match(stdout, /skip auto-close .*reason=pages-deploy-not-success job-conclusion=skipped/);
  assert.deepEqual(mutatingCalls, [], 'a stale skipped deploy must not close the incident');
});

test('does not auto-close a Pages incident when the final-tip guard skips deployment steps', async (t) => {
  const runId = 779;
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/issues`]: () => ({ body: [OPEN_DEPLOY_INCIDENT] }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [] },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs/${runId}/jobs`]: () => ({
      body: {
        jobs: [
          {
            name: 'deploy',
            conclusion: 'success',
            steps: [
              { name: 'Final latest-tip guard', conclusion: 'success' },
              { name: 'Upload artifact', conclusion: 'skipped' },
              { name: 'Deploy to GitHub Pages', conclusion: 'skipped' },
              { name: 'Deploy to GitHub Pages (retry)', conclusion: 'skipped' },
            ],
          },
        ],
      },
    }),
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(
    port,
    pushRun({
      id: runId,
      name: 'Deploy to GitHub Pages',
      event: 'workflow_run',
      html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/${runId}`,
    }),
  );

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.match(
    stdout,
    /skip auto-close .*reason=pages-deploy-not-success job-conclusion=success deployment-step-succeeded=false/,
  );
  assert.deepEqual(mutatingCalls, [], 'a final-tip no-op must not close the incident');
});

test('auto-closes a Pages incident after a successful deploy job', async (t) => {
  const runId = 778;
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/issues`]: () => ({ body: [OPEN_DEPLOY_INCIDENT] }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [] },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs/${runId}/jobs`]: () => ({
      body: {
        jobs: [
          { name: 'release-gate', conclusion: 'success' },
          {
            name: 'deploy',
            conclusion: 'success',
            steps: [{ name: 'Deploy to GitHub Pages', conclusion: 'success' }],
          },
          { name: 'Baseline win-rate sweep (100 seeds)', conclusion: 'success' },
        ],
      },
    }),
    [`PATCH /repos/${OWNER}/${REPO}/issues/202`]: () => ({ body: { number: 202 } }),
    [`POST /repos/${OWNER}/${REPO}/issues/202/comments`]: () => ({ body: { id: 2 } }),
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(
    port,
    pushRun({
      id: runId,
      name: 'Deploy to GitHub Pages',
      event: 'workflow_run',
      html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/${runId}`,
    }),
  );

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.match(stdout, /closed incident issue=#202/);
  assert.equal(
    mutatingCalls.filter(
      (call) => call.method === 'PATCH' && call.url === `/repos/${OWNER}/${REPO}/issues/202`,
    ).length,
    1,
  );
});

test('routes a genuine push failure to a new/updated incident even with an unrelated trusted train check present', async (t) => {
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/issues`]: () => ({ body: [] }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [trustedTrainCheck()] },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs/555/jobs`]: () => ({
      body: {
        jobs: [
          {
            name: 'check-format-and-labs',
            conclusion: 'failure',
            html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/555/job/1`,
          },
        ],
      },
    }),
    [`POST /repos/${OWNER}/${REPO}/labels`]: () => ({ body: {} }),
    [`POST /repos/${OWNER}/${REPO}/issues`]: () => ({
      body: { number: 202, node_id: 'ISSUE_202' },
    }),
    [`POST /graphql`]: (url, parsed) => {
      const doc = String(parsed?.query ?? '');
      if (doc.includes('suggestedActors')) {
        return {
          body: {
            data: {
              repository: {
                suggestedActors: {
                  nodes: [{ login: 'copilot-swe-agent', __typename: 'Bot', id: 'BOT_1' }],
                },
              },
            },
          },
        };
      }
      return {
        body: {
          data: { replaceActorsForAssignable: { assignable: { assignees: { nodes: [] } } } },
        },
      };
    },
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(
    port,
    pushRun({ conclusion: 'failure', status: 'completed' }),
  );

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.match(stdout, /created incident issue=#202/);
  const createCall = mutatingCalls.find(
    (call) => call.method === 'POST' && call.url === `/repos/${OWNER}/${REPO}/issues`,
  );
  assert.ok(createCall, 'expected a new incident issue to be created for the genuine failure');
  assert.match(
    createCall.body.body,
    /## Merge-train promotion provenance/,
    'a genuine completed+successful trusted check must still be surfaced as provenance',
  );
  assert.match(createCall.body.body, /Failed job: \[check-format-and-labs\]\(/);
});

test('bounds trusted merge-train promotion provenance in incident comments', async (t) => {
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/issues`]: () => ({ body: [] }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [trustedTrainCheck({ output: { summary: 'x'.repeat(5_000) } })] },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs/555/jobs`]: () => ({ body: { jobs: [] } }),
    [`POST /repos/${OWNER}/${REPO}/labels`]: () => ({ body: {} }),
    [`POST /repos/${OWNER}/${REPO}/issues`]: () => ({
      body: { number: 204, node_id: 'ISSUE_204' },
    }),
    [`POST /graphql`]: (_url, parsed) => {
      const doc = String(parsed?.query ?? '');
      if (doc.includes('suggestedActors')) {
        return {
          body: {
            data: {
              repository: {
                suggestedActors: {
                  nodes: [{ login: 'copilot-swe-agent', __typename: 'Bot', id: 'BOT_1' }],
                },
              },
            },
          },
        };
      }
      return {
        body: {
          data: { replaceActorsForAssignable: { assignable: { assignees: { nodes: [] } } } },
        },
      };
    },
  });
  t.after(() => server.close());

  const { code, stderr } = await runScript(
    port,
    pushRun({ conclusion: 'failure', status: 'completed' }),
  );

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  const createCall = mutatingCalls.find(
    (call) => call.method === 'POST' && call.url === `/repos/${OWNER}/${REPO}/issues`,
  );
  assert.ok(createCall);
  assert.match(createCall.body.body, /promotion summary truncated/);
  assert.ok(createCall.body.body.includes('x'.repeat(4_000)));
  assert.ok(
    !createCall.body.body.includes('x'.repeat(4_001)),
    'the provenance summary must retain no more than the configured budget',
  );
});

for (const [label, overrides] of [
  ['in-progress (no conclusion yet)', { status: 'in_progress', conclusion: null }],
  ['failed', { status: 'completed', conclusion: 'failure' }],
]) {
  test(`does not surface an untrustworthy (${label}) merge-train check as promotion provenance`, async (t) => {
    const { server, port, mutatingCalls } = await startServer({
      [`GET /repos/${OWNER}/${REPO}/issues`]: () => ({ body: [] }),
      [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
        body: { check_runs: [trustedTrainCheck(overrides)] },
      }),
      [`POST /repos/${OWNER}/${REPO}/labels`]: () => ({ body: {} }),
      [`POST /repos/${OWNER}/${REPO}/issues`]: () => ({
        body: { number: 303, node_id: 'ISSUE_303' },
      }),
      [`POST /graphql`]: (url, parsed) => {
        const doc = String(parsed?.query ?? '');
        if (doc.includes('suggestedActors')) {
          return {
            body: {
              data: {
                repository: {
                  suggestedActors: {
                    nodes: [{ login: 'copilot-swe-agent', __typename: 'Bot', id: 'BOT_1' }],
                  },
                },
              },
            },
          };
        }
        return {
          body: {
            data: { replaceActorsForAssignable: { assignable: { assignees: { nodes: [] } } } },
          },
        };
      },
    });
    t.after(() => server.close());

    const { code, stdout, stderr } = await runScript(
      port,
      pushRun({ conclusion: 'failure', status: 'completed' }),
    );

    if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
    assert.match(stdout, /created incident issue=#303/);
    const createCall = mutatingCalls.find(
      (call) => call.method === 'POST' && call.url === `/repos/${OWNER}/${REPO}/issues`,
    );
    assert.ok(createCall, 'expected a new incident issue to be created for the genuine failure');
    assert.doesNotMatch(
      createCall.body.body,
      /## Merge-train promotion provenance/,
      `a ${label} merge-train check must not be presented as promotion provenance`,
    );
  });
}
