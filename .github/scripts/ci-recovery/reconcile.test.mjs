/**
 * Subprocess regression tests for dry-run lease-persistence policy.
 *
 * Each test runs reconcile.mjs as a child process against a local mock HTTP
 * server and inspects which mutating calls (POST / PATCH / PUT / DELETE) the
 * script issued, so the suite fails if anyone removes the shouldMutateRecoveryState
 * guard from acquire, updateState, or release.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { blockerFingerprint, makeState, renderStateComment } from './state.mjs';

const SCRIPT = fileURLToPath(new URL('./reconcile.mjs', import.meta.url));
const OWNER = 'test-owner';
const REPO = 'test-repo';
const PR_NUM = 42;
const HEAD_SHA = 'abc1234def5678901234567890abcdef12345678';
const LEASE_ID = 'test-lease-id';
const LABEL = `ci-owner-pr-${PR_NUM}`;
const TOKEN = 'x-test-token';

/** Minimal open PR fixture. */
function basePr() {
  return {
    number: PR_NUM,
    state: 'open',
    draft: false,
    mergeable: true,
    mergeable_state: 'clean',
    html_url: `https://github.com/${OWNER}/${REPO}/pull/${PR_NUM}`,
    head: { sha: HEAD_SHA, repo: { full_name: `${OWNER}/${REPO}` } },
    labels: [],
    changed_files: 0,
  };
}

/** Build a rendered state comment for an active shepherd lease. */
function shepherdStateComment(id = 777) {
  const state = makeState({
    prNumber: PR_NUM,
    headSha: HEAD_SHA,
    fingerprint: blockerFingerprint(HEAD_SHA, []),
    owner: 'shepherd',
    status: 'active',
    leaseId: LEASE_ID,
    blockers: [],
    updatedAt: new Date().toISOString(),
  });
  return { id, body: renderStateComment(state) };
}

/**
 * GraphQL response body for listReviewThreads (no threads, no assignees).
 */
function gqlNoThreads() {
  return {
    data: {
      repository: {
        pullRequest: {
          id: 'PR_test_id',
          assignees: { nodes: [] },
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        },
      },
    },
  };
}

/**
 * Start a minimal mock HTTP/GraphQL server.
 *
 * `routes` maps `"METHOD /path-without-query"` to a handler:
 *   `(url, parsedBody) => { status?, body? }`
 *
 * Returns { server, port, mutatingCalls }.
 * mutatingCalls is an array of { method, url } for every POST/PATCH/PUT/DELETE.
 */
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
        // Track REST mutations only; /graphql uses POST for queries too.
        if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) && pathOnly !== '/graphql') {
          mutatingCalls.push({ method, url: req.url });
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

/** Spawn reconcile.mjs against the mock server and collect exit info. */
async function runScript(port, env) {
  const child = spawn(process.execPath, [SCRIPT], {
    env: {
      GITHUB_REPOSITORY: `${OWNER}/${REPO}`,
      GITHUB_API_URL: `http://127.0.0.1:${port}`,
      GITHUB_GRAPHQL_URL: `http://127.0.0.1:${port}/graphql`,
      PR_NUMBER: String(PR_NUM),
      LEASE_ID,
      CRAWLER_CI_PAT: TOKEN,
      GITHUB_TOKEN: TOKEN,
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

// ---------------------------------------------------------------------------
// lease-acquire
// ---------------------------------------------------------------------------

test('lease-acquire in dry-run writes the owner label and state comment', async (t) => {
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({ body: basePr() }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({ body: [] }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`POST /repos/${OWNER}/${REPO}/labels`]: () => ({ body: { name: LABEL } }),
    [`POST /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels`]: () => ({ body: {} }),
    [`POST /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: { id: 999, body: '' },
    }),
  });

  t.after(() => server.close());

  const { code, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'lease-acquire',
    CI_RECOVERY_MODE: 'dry-run',
  });

  assert.equal(code, 0, `expected exit 0; stderr: ${stderr}`);

  const labelCreate = mutatingCalls.find(
    (c) => c.method === 'POST' && c.url === `/repos/${OWNER}/${REPO}/labels`,
  );
  const labelAttach = mutatingCalls.find(
    (c) => c.method === 'POST' && c.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels`,
  );
  const commentCreate = mutatingCalls.find(
    (c) => c.method === 'POST' && c.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`,
  );

  assert.ok(labelCreate, 'expected POST to create the owner label');
  assert.ok(labelAttach, 'expected POST to attach the owner label to the PR');
  assert.ok(commentCreate, 'expected POST to create the state comment');
});

// ---------------------------------------------------------------------------
// lease-heartbeat
// ---------------------------------------------------------------------------

test('lease-heartbeat in dry-run updates the state comment', async (t) => {
  const stateComment = shepherdStateComment();

  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({ body: basePr() }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [stateComment],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({ body: { name: LABEL } }),
    [`PATCH /repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`]: () => ({
      body: { id: stateComment.id, body: '' },
    }),
  });

  t.after(() => server.close());

  const { code, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'lease-heartbeat',
    CI_RECOVERY_MODE: 'dry-run',
  });

  assert.equal(code, 0, `expected exit 0; stderr: ${stderr}`);

  const commentUpdate = mutatingCalls.find(
    (c) =>
      c.method === 'PATCH' &&
      c.url === `/repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`,
  );
  assert.ok(commentUpdate, 'expected PATCH to update the state comment');
});

// ---------------------------------------------------------------------------
// lease-release
// ---------------------------------------------------------------------------

test('lease-release in dry-run removes the owner label and writes idle state', async (t) => {
  const stateComment = shepherdStateComment();

  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({ body: basePr() }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [stateComment],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({ body: { name: LABEL } }),
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}`]: () => ({
      body: {},
    }),
    [`DELETE /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      body: {},
    }),
    [`PATCH /repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`]: () => ({
      body: { id: stateComment.id, body: '' },
    }),
  });

  t.after(() => server.close());

  const { code, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'lease-release',
    CI_RECOVERY_MODE: 'dry-run',
  });

  assert.equal(code, 0, `expected exit 0; stderr: ${stderr}`);

  const labelDetach = mutatingCalls.find(
    (c) =>
      c.method === 'DELETE' && c.url.startsWith(`/repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/`),
  );
  const labelDelete = mutatingCalls.find(
    (c) => c.method === 'DELETE' && c.url === `/repos/${OWNER}/${REPO}/labels/${LABEL}`,
  );
  const commentUpdate = mutatingCalls.find(
    (c) =>
      c.method === 'PATCH' &&
      c.url === `/repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`,
  );

  assert.ok(labelDetach, 'expected DELETE to detach the owner label from the PR');
  assert.ok(labelDelete, 'expected DELETE to remove the owner label from the repo');
  assert.ok(commentUpdate, 'expected PATCH to write idle state into the state comment');
});

// ---------------------------------------------------------------------------
// reconcile (automated recovery) — must be shadow-only in dry-run
// ---------------------------------------------------------------------------

test('reconcile in dry-run makes no mutating API calls', async (t) => {
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({ body: basePr() }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({ body: [] }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    // GraphQL (listReviewThreads) — read-only, must still be called
    [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
    // CI check-runs — one failed check to give the reconciler something to dispatch
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: {
        check_runs: [
          {
            id: 1,
            name: 'ci',
            status: 'completed',
            conclusion: 'failure',
            html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/1`,
          },
        ],
      },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
  });

  t.after(() => server.close());

  const { code, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    CI_RECOVERY_MODE: 'dry-run',
  });

  assert.equal(code, 0, `expected exit 0; stderr: ${stderr}`);
  assert.deepEqual(mutatingCalls, [], 'reconcile in dry-run must not issue any mutating API calls');
});

test('reconcile ignores same-repository action-required runs without approval or dispatch', async (t) => {
  const runId = 29220010234;
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({ body: basePr() }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({ body: [] }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [] },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({
      body: {
        workflow_runs: [
          {
            id: runId,
            name: 'CI Recovery Router',
            path: '.github/workflows/ci-recovery-router.yml',
            event: 'pull_request_review',
            conclusion: 'action_required',
            pull_requests: [{ number: PR_NUM }],
            html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/${runId}`,
          },
        ],
      },
    }),
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}/files`]: () => ({ body: [] }),
  });

  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    CI_RECOVERY_MODE: 'live',
    MERGE_TRAIN_ADMISSION_CHECKS: 'required-check',
  });

  assert.equal(code, 0, `expected exit 0; stderr: ${stderr}`);
  assert.match(stdout, new RegExp(`skip action_required run=${runId} .* reason=same-repository`));
  assert.match(stdout, /wait pr=#42 required-checks=required-check/);
  assert.doesNotMatch(stdout, /workflow-approval|approved workflow|would-approve/);
  assert.deepEqual(
    mutatingCalls,
    [],
    'same-repository action-required runs must not trigger approval or recovery dispatch',
  );
});
