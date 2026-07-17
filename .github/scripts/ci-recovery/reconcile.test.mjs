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

import {
  automationProgressKey,
  blockerFingerprint,
  makeState,
  parseStateComment,
  renderStateComment,
  WAITING_LABEL,
  WAITING_TRANSITION_LABEL,
} from './state.mjs';
import { admissionFingerprint } from '../merge-train/state.mjs';

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
function shepherdStateComment(id = 777, overrides = {}) {
  const state = makeState({
    prNumber: PR_NUM,
    headSha: HEAD_SHA,
    fingerprint: blockerFingerprint([]),
    owner: 'shepherd',
    status: 'active',
    leaseId: LEASE_ID,
    blockers: [],
    updatedAt: new Date().toISOString(),
    ...overrides,
  });
  return { id, body: renderStateComment(state) };
}

function automationStateComment(id = 778) {
  const state = makeState({
    prNumber: PR_NUM,
    headSha: HEAD_SHA,
    fingerprint: blockerFingerprint([]),
    owner: 'automation',
    status: 'active',
    blockers: [],
    updatedAt: '2026-07-16T12:00:00.000Z',
  });
  return { id, body: renderStateComment(state) };
}

function waitingStateComment(
  id = 779,
  {
    checkRuns = [{ id: 1, name: 'ci', status: 'in_progress', conclusion: null }],
    ...overrides
  } = {},
) {
  const state = makeState({
    prNumber: PR_NUM,
    headSha: HEAD_SHA,
    fingerprint: admissionFingerprint({
      headSha: HEAD_SHA,
      checkRuns,
      requiredNames: ['ci'],
      reviewThreads: [],
    }),
    owner: 'none',
    status: 'waiting',
    trigger: 'schedule:sweep',
    blockers: [],
    updatedAt: '2026-07-16T12:00:00.000Z',
    ...overrides,
  });
  return { id, body: renderStateComment(state) };
}

/**
 * GraphQL response body for listReviewThreads (no threads, no assignees).
 */
function substantiveCopilotReview(overrides = {}) {
  return {
    id: 'REVIEW_copilot',
    body: 'Reviewed the pull request and found no blocking issues.',
    state: 'COMMENTED',
    submittedAt: '2026-07-16T00:00:00Z',
    author: { login: 'copilot-pull-request-reviewer' },
    comments: { nodes: [] },
    ...overrides,
  };
}

function reviewConnection(nodes = [substantiveCopilotReview()]) {
  return {
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes,
  };
}

function gqlNoThreads(reviews = [substantiveCopilotReview()]) {
  return {
    data: {
      repository: {
        pullRequest: {
          id: 'PR_test_id',
          assignees: { nodes: [] },
          closingIssuesReferences: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
          reviews: reviewConnection(reviews),
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
 * mutatingCalls is an array of { method, url } for every POST/PATCH/PUT/DELETE
 * REST call and every GraphQL mutation (POST /graphql whose document starts with
 * the `mutation` keyword, excluding plain queries that also use POST).
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
        // Track REST mutations (non-graphql POSTs/PATCHes/PUTs/DELETEs).
        if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) && pathOnly !== '/graphql') {
          mutatingCalls.push({ method, url: req.url, body: parsed });
        }
        // Track GraphQL mutations separately — POST /graphql is also used for
        // read-only queries, so check whether the document starts with `mutation`.
        if (method === 'POST' && pathOnly === '/graphql') {
          const doc = String(parsed?.query ?? '').trimStart();
          if (doc.startsWith('mutation')) {
            mutatingCalls.push({ method: 'GRAPHQL_MUTATION', url: req.url });
          }
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

function isWindowsAsyncCloseCrash(code, stderr) {
  return process.platform === 'win32' && code === 3221226505 && /UV_HANDLE_CLOSING/.test(stderr);
}

// The Windows UV_HANDLE_CLOSING shutdown assertion is a known Node/libuv
// race in this file's shared spawn-subprocess + mock-HTTP-server harness:
// every test here starts a real server, spawns reconcile.mjs as a child
// process pointed at it, then closes both in short order, and on some
// Windows hosts that rapid subprocess+handle teardown trips a native
// assertion in libuv itself (src/win/async.c) -- unrelated to reconcile.mjs's
// own logic or exit code. Local measurement on a Windows host reproduced
// this crash across effectively every test using this harness (fingerprint:
// exit code 3221226505 with `UV_HANDLE_CLOSING` in stderr), not just a
// single fixture, so the exemption cannot be usefully narrowed to "one
// documented test" -- but it MUST stay opt-in (default false/strict) rather
// than a silent blanket default, so every call site that relies on it does
// so as a visible, greppable, individually-reviewable decision, and any
// *new* subprocess test added to this file starts strict and only gets the
// exemption if someone deliberately adds it here. Real CI runs on Linux
// (see ci.yml), where `process.platform === 'win32'` is always false and
// this branch never applies, so this only ever affects local Windows runs
// of this suite, never the authoritative CI signal.
function assertSuccessfulExit(t, code, stderr, context = '', allowKnownWindowsFlake = false) {
  if (allowKnownWindowsFlake && isWindowsAsyncCloseCrash(code, stderr)) {
    t.skip('Node subprocess hit the known Windows UV_HANDLE_CLOSING shutdown assertion');
    return false;
  }
  assert.equal(code, 0, `${context ? `${context} ` : ''}expected exit 0; stderr: ${stderr}`);
  return true;
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
    [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
  });

  t.after(() => server.close());

  const { code, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'lease-acquire',
    CI_RECOVERY_MODE: 'dry-run',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;

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

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;

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
  let repositoryLabelExists = true;

  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({ body: basePr() }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [stateComment],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () =>
      repositoryLabelExists
        ? { body: { name: LABEL } }
        : { status: 404, body: { message: 'Not Found' } },
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}`]: () => ({
      body: {},
    }),
    [`DELETE /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => {
      repositoryLabelExists = false;
      return { body: {} };
    },
    [`PATCH /repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`]: () => ({
      body: { id: stateComment.id, body: '' },
    }),
  });

  t.after(() => server.close());

  const { code, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'lease-release',
    CI_RECOVERY_MODE: 'dry-run',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;

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
  assert.ok(
    mutatingCalls.indexOf(labelDetach) < mutatingCalls.indexOf(labelDelete),
    'the PR label attachment must be detached before the repository label definition is deleted',
  );
});

test('known stale-node 422 refetches ownership, retries detach once, and then converges', async (t) => {
  const stateComment = shepherdStateComment();
  let repositoryLabelExists = true;
  let attached = true;
  let detachAttempts = 0;
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: { ...basePr(), labels: attached ? [{ name: LABEL }] : [] },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [stateComment],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () =>
      repositoryLabelExists
        ? { body: { name: LABEL } }
        : { status: 404, body: { message: 'Not Found' } },
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}`]: () => {
      detachAttempts += 1;
      if (detachAttempts === 1) {
        return {
          status: 422,
          body: {
            message: 'Validation Failed',
            errors: [{ resource: 'Issue', field: 'labels', code: 'missing' }],
          },
        };
      }
      attached = false;
      return { body: {} };
    },
    [`DELETE /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => {
      repositoryLabelExists = false;
      return { body: {} };
    },
    [`PATCH /repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`]: () => ({
      body: { id: stateComment.id, body: '' },
    }),
  });
  t.after(() => server.close());

  const { code, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'lease-release',
    CI_RECOVERY_MODE: 'dry-run',
  });
  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;

  const issueDeletes = mutatingCalls.filter(
    (call) =>
      call.method === 'DELETE' &&
      call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}`,
  );
  const repositoryDelete = mutatingCalls.find(
    (call) => call.method === 'DELETE' && call.url === `/repos/${OWNER}/${REPO}/labels/${LABEL}`,
  );
  assert.equal(issueDeletes.length, 2);
  assert.ok(repositoryDelete);
  assert.ok(mutatingCalls.indexOf(issueDeletes[1]) < mutatingCalls.indexOf(repositoryDelete));
});

test('known stale-node 422 fails closed when ownership is a newer incarnation', async (t) => {
  const stateComment = shepherdStateComment();
  let detachAttempts = 0;
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: { ...basePr(), labels: [{ name: LABEL }] },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [stateComment],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({ body: { name: LABEL } }),
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}`]: () => {
      detachAttempts += 1;
      if (detachAttempts === 1) {
        const currentState = parseStateComment(stateComment.body);
        stateComment.body = renderStateComment(
          makeState({
            ...currentState,
            headSha: 'newer-owner-head',
            updatedAt: new Date(Date.now() + 1000).toISOString(),
          }),
        );
        return {
          status: 422,
          body: {
            message: 'Validation Failed',
            errors: [{ resource: 'Issue', field: 'labels', code: 'missing' }],
          },
        };
      }
      return { body: {} };
    },
  });
  t.after(() => server.close());

  const { code, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'lease-release',
    CI_RECOVERY_MODE: 'dry-run',
  });

  assert.notEqual(code, 0);
  assert.match(stderr, /ownership changed during stale-node release/);
  assert.equal(detachAttempts, 1);
  assert.equal(
    mutatingCalls.some(
      (call) => call.method === 'DELETE' && call.url === `/repos/${OWNER}/${REPO}/labels/${LABEL}`,
    ),
    false,
  );
  assert.equal(
    mutatingCalls.some(
      (call) =>
        call.method === 'PATCH' &&
        call.url === `/repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`,
    ),
    false,
  );
});

test('unknown issue-label 422 remains fail-closed', async (t) => {
  const stateComment = shepherdStateComment();
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: { ...basePr(), labels: [{ name: LABEL }] },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [stateComment],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({ body: { name: LABEL } }),
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}`]: () => ({
      status: 422,
      body: { message: 'Validation Failed', errors: [{ resource: 'Issue', code: 'custom' }] },
    }),
  });
  t.after(() => server.close());

  const { code, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'lease-release',
    CI_RECOVERY_MODE: 'dry-run',
  });

  assert.notEqual(code, 0);
  assert.match(stderr, /Validation Failed/);
  assert.equal(
    mutatingCalls.some(
      (call) => call.method === 'DELETE' && call.url === `/repos/${OWNER}/${REPO}/labels/${LABEL}`,
    ),
    false,
  );
});

for (const attempt of [1, 2]) {
  test(`stale automation attempt ${attempt} ${
    attempt === 1 ? 'retries once with preserved progress state' : 'releases to idle'
  }`, async (t) => {
    const failedCheck = {
      id: 1,
      name: 'ci',
      status: 'completed',
      conclusion: 'failure',
      html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/1`,
    };
    const blockers = [
      {
        kind: 'ci-failure',
        id: 'ci',
        summary: 'ci concluded failure.',
        url: failedCheck.html_url,
      },
    ];
    const fingerprint = blockerFingerprint(blockers);
    const staleAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const stateComment = {
      id: 880 + attempt,
      body: renderStateComment(
        makeState({
          prNumber: PR_NUM,
          headSha: HEAD_SHA,
          fingerprint,
          owner: 'automation',
          status: 'dispatched',
          blockers,
          attempt,
          progressKey: automationProgressKey(HEAD_SHA, fingerprint),
          progressAt: staleAt,
          updatedAt: staleAt,
        }),
      ),
    };
    let repositoryLabelExists = true;
    const { server, port, mutatingCalls } = await startServer({
      [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
        body: { ...basePr(), labels: [{ name: LABEL }] },
      }),
      [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
        body: [stateComment],
      }),
      [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () =>
        repositoryLabelExists
          ? { body: { name: LABEL } }
          : { status: 404, body: { message: 'Not Found' } },
      [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}`]: () => ({
        body: {},
      }),
      [`DELETE /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => {
        repositoryLabelExists = false;
        return { body: {} };
      },
      [`PATCH /repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`]: (_url, body) => {
        stateComment.body = body.body;
        return { body: { id: stateComment.id, body: body.body } };
      },
      [`POST /repos/${OWNER}/${REPO}/labels`]: () => {
        repositoryLabelExists = true;
        return { body: { name: LABEL } };
      },
      [`POST /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels`]: () => ({ body: {} }),
      [`POST /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
        body: { id: 990 + attempt },
      }),
      [`POST /graphql`]: (_url, body) => {
        const query = String(body?.query || '');
        if (query.includes('suggestedActors')) {
          return {
            body: {
              data: {
                repository: {
                  suggestedActors: { nodes: [{ id: 'BOT_copilot', login: 'copilot' }] },
                },
              },
            },
          };
        }
        if (query.trimStart().startsWith('mutation')) {
          return {
            body: {
              data: {
                replaceActorsForAssignable: {
                  assignable: { assignees: { nodes: [{ login: 'Copilot' }] } },
                },
              },
            },
          };
        }
        return { body: gqlNoThreads() };
      },
      [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
        body: { check_runs: [failedCheck] },
      }),
      [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
    });
    t.after(() => server.close());

    const { code, stdout, stderr } = await runScript(port, {
      RECOVERY_OPERATION: 'reconcile',
      RECOVERY_TRIGGER: 'schedule:sweep',
      CI_RECOVERY_MODE: 'live',
    });
    if (!assertSuccessfulExit(t, code, stderr, '', true)) return;

    const finalState = parseStateComment(stateComment.body);
    if (attempt === 1) {
      assert.match(stdout, /assigned copilot pr=#42/);
      assert.equal(finalState.owner, 'automation');
      assert.equal(finalState.status, 'dispatched');
      assert.equal(finalState.attempt, 2);
      assert.equal(finalState.progressKey, automationProgressKey(HEAD_SHA, fingerprint));
      assert.ok(
        mutatingCalls.some(
          (call) =>
            call.method === 'POST' &&
            call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`,
        ),
      );
    } else {
      assert.match(stdout, /released stale automation pr=#42 attempts=2/);
      assert.equal(finalState.owner, 'none');
      assert.equal(finalState.status, 'idle');
      assert.equal(finalState.trigger, 'stale-automation-exhausted');
      assert.equal(finalState.attempt, 2);
      assert.equal(
        mutatingCalls.some(
          (call) =>
            call.method === 'POST' &&
            call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`,
        ),
        false,
      );
      assert.equal(
        mutatingCalls.some(
          (call) =>
            call.method === 'POST' &&
            call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels`,
        ),
        false,
      );
    }
  });
}

for (const [name, repositoryLabelInitiallyExists, ownerLabelInitiallyAttached] of [
  ['repository label only', true, false],
  ['PR attachment only', false, true],
]) {
  test(`interrupted acquire cleans an orphaned ${name} before invariant checks`, async (t) => {
    let repositoryLabelExists = repositoryLabelInitiallyExists;
    const prLabels = [{ name: 'ci-recovery-opt-out' }];
    if (ownerLabelInitiallyAttached) prLabels.push({ name: LABEL });

    const { server, port, mutatingCalls } = await startServer({
      [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
        body: { ...basePr(), labels: prLabels },
      }),
      [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({ body: [] }),
      [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () =>
        repositoryLabelExists
          ? { body: { name: LABEL } }
          : { status: 404, body: { message: 'Not Found' } },
      [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}`]: () =>
        ownerLabelInitiallyAttached
          ? { body: {} }
          : { status: 404, body: { message: 'Label does not exist' } },
      [`DELETE /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => {
        if (!repositoryLabelExists) {
          return { status: 404, body: { message: 'Not Found' } };
        }
        repositoryLabelExists = false;
        return { body: {} };
      },
      [`POST /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
        body: { id: 999, body: '' },
      }),
      [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
    });
    t.after(() => server.close());

    const { code, stdout, stderr } = await runScript(port, {
      RECOVERY_OPERATION: 'reconcile',
      RECOVERY_TRIGGER: 'workflow_dispatch',
      CI_RECOVERY_MODE: 'live',
    });

    if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
    assert.match(stdout, /cleanup pr=#42 reason=orphaned-owner-label/);
    assert.match(stdout, /skip pr=#42 reason=opt-out/);
    assert.ok(
      mutatingCalls.some(
        (call) =>
          call.method === 'DELETE' &&
          call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}`,
      ),
    );
    assert.ok(
      mutatingCalls.some(
        (call) =>
          call.method === 'POST' &&
          call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`,
      ),
    );
  });
}

test('closed PR orphan cleanup releases ownership exactly once', async (t) => {
  let repositoryLabelExists = true;
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: { ...basePr(), state: 'closed', labels: [{ name: LABEL }] },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({ body: [] }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () =>
      repositoryLabelExists
        ? { body: { name: LABEL } }
        : { status: 404, body: { message: 'Not Found' } },
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}`]: () => ({ body: {} }),
    [`DELETE /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => {
      repositoryLabelExists = false;
      return { body: {} };
    },
    [`POST /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: { id: 999, body: '' },
    }),
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'workflow_dispatch',
    CI_RECOVERY_MODE: 'live',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.match(stdout, /cleanup pr=#42 reason=orphaned-owner-label/);
  assert.match(stdout, /skip pr=#42 state=closed/);
  assert.equal(
    mutatingCalls.filter(
      (call) =>
        call.method === 'DELETE' &&
        call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}`,
    ).length,
    1,
  );
  assert.equal(
    mutatingCalls.filter(
      (call) =>
        call.method === 'POST' && call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`,
    ).length,
    1,
  );
});

test('admission wait after orphan cleanup does not release ownership twice', async (t) => {
  const stateCommentId = 999;
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: { ...basePr(), labels: [{ name: LABEL }] },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({ body: [] }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}`]: () => ({ body: {} }),
    [`DELETE /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`POST /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: { id: stateCommentId, body: '' },
    }),
    [`PATCH /repos/${OWNER}/${REPO}/issues/comments/${stateCommentId}`]: () => ({
      body: { id: stateCommentId, body: '' },
    }),
    [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [{ id: 1, name: 'ci', status: 'in_progress', conclusion: null }] },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
    [`POST /repos/${OWNER}/${REPO}/labels`]: () => ({ body: {} }),
    [`POST /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels`]: () => ({ body: {} }),
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'workflow_run:completed',
    CI_RECOVERY_MODE: 'live',
    MERGE_TRAIN_ENABLED: 'true',
    MERGE_TRAIN_ADMISSION_CHECKS: 'ci',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.match(stdout, /cleanup pr=#42 reason=orphaned-owner-label/);
  assert.match(stdout, /wait pr=#42 admission=/);
  assert.equal(
    mutatingCalls.filter(
      (call) =>
        call.method === 'DELETE' &&
        call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}`,
    ).length,
    1,
  );
  assert.equal(
    mutatingCalls.filter(
      (call) => call.method === 'DELETE' && call.url === `/repos/${OWNER}/${REPO}/labels/${LABEL}`,
    ).length,
    1,
  );
});

test('PR #1208 partial cleanup converges when both owner-label deletes return 404', async (t) => {
  const stateComment = automationStateComment();
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({ body: basePr() }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [stateComment],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Label does not exist' },
    }),
    [`DELETE /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`PATCH /repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`]: () => ({
      body: { id: stateComment.id },
    }),
    [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: {
        check_runs: [{ id: 1, name: 'ci', status: 'completed', conclusion: 'success' }],
      },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
  });
  t.after(() => server.close());

  const { code, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'workflow_run:completed',
    CI_RECOVERY_MODE: 'live',
    MERGE_TRAIN_ENABLED: 'true',
    MERGE_TRAIN_ADMISSION_CHECKS: 'ci',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.ok(
    mutatingCalls.some(
      (call) =>
        call.method === 'DELETE' &&
        call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}`,
    ),
  );
  assert.ok(
    mutatingCalls.some(
      (call) => call.method === 'DELETE' && call.url === `/repos/${OWNER}/${REPO}/labels/${LABEL}`,
    ),
  );
  const statePatch = mutatingCalls.find(
    (call) =>
      call.method === 'PATCH' &&
      call.url === `/repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`,
  );
  assert.equal(parseStateComment(statePatch.body.body).owner, 'none');
  assert.equal(parseStateComment(statePatch.body.body).status, 'idle');
});

test('partial cleanup independently tolerates a missing PR attachment before deleting the repository label', async (t) => {
  const stateComment = automationStateComment(780);
  let repositoryLabelExists = true;
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({ body: basePr() }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [stateComment],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () =>
      repositoryLabelExists
        ? { body: { name: LABEL } }
        : { status: 404, body: { message: 'Not Found' } },
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Label does not exist' },
    }),
    [`DELETE /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => {
      repositoryLabelExists = false;
      return { body: {} };
    },
    [`PATCH /repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`]: () => ({
      body: { id: stateComment.id },
    }),
    [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: {
        check_runs: [{ id: 1, name: 'ci', status: 'completed', conclusion: 'success' }],
      },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
  });
  t.after(() => server.close());

  const { code, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'workflow_run:completed',
    CI_RECOVERY_MODE: 'live',
    MERGE_TRAIN_ENABLED: 'true',
    MERGE_TRAIN_ADMISSION_CHECKS: 'ci',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.equal(repositoryLabelExists, false);
  assert.equal(
    mutatingCalls.filter(
      (call) =>
        call.method === 'DELETE' &&
        (call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}` ||
          call.url === `/repos/${OWNER}/${REPO}/labels/${LABEL}`),
    ).length,
    2,
  );
});

test('missing-label shepherd state fails closed until expiry but matching release still converges', async (t) => {
  const unexpired = shepherdStateComment(781);
  const routes = {
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({ body: basePr() }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [unexpired],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
  };
  const first = await startServer(routes);
  t.after(() => first.server.close());
  const blocked = await runScript(first.port, {
    RECOVERY_OPERATION: 'reconcile',
    CI_RECOVERY_MODE: 'live',
  });
  assert.notEqual(blocked.code, 0);
  assert.match(blocked.stderr, /unexpired shepherd lease with a missing owner label/);

  const second = await startServer({
    ...routes,
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Label does not exist' },
    }),
    [`DELETE /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`PATCH /repos/${OWNER}/${REPO}/issues/comments/${unexpired.id}`]: () => ({
      body: { id: unexpired.id },
    }),
  });
  t.after(() => second.server.close());
  const released = await runScript(second.port, {
    RECOVERY_OPERATION: 'lease-release',
    CI_RECOVERY_MODE: 'dry-run',
  });
  if (!assertSuccessfulExit(t, released.code, released.stderr, '', true)) return;
  assert.ok(
    second.mutatingCalls.some(
      (call) =>
        call.method === 'PATCH' &&
        call.url === `/repos/${OWNER}/${REPO}/issues/comments/${unexpired.id}`,
    ),
  );
});

test('an expired missing-label shepherd lease can be safely reacquired', async (t) => {
  const expired = shepherdStateComment(783, {
    trigger: 'workflow_dispatch',
    updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  });
  let reacquiredStateBody = null;
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({ body: basePr() }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [expired],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`POST /repos/${OWNER}/${REPO}/labels`]: () => ({ body: { name: LABEL } }),
    [`POST /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels`]: () => ({ body: {} }),
    [`PATCH /repos/${OWNER}/${REPO}/issues/comments/${expired.id}`]: (_url, body) => {
      reacquiredStateBody = body.body;
      return { body: { id: expired.id } };
    },
  });
  t.after(() => server.close());

  const { code, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'lease-acquire',
    CI_RECOVERY_MODE: 'dry-run',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.ok(
    mutatingCalls.some(
      (call) => call.method === 'POST' && call.url === `/repos/${OWNER}/${REPO}/labels`,
    ),
  );
  const reacquired = parseStateComment(reacquiredStateBody);
  assert.equal(reacquired.leaseId, LEASE_ID);
  assert.equal(reacquired.trigger, 'workflow_dispatch');
  assert.ok(
    Date.parse(reacquired.updatedAt) > Date.parse(parseStateComment(expired.body).updatedAt),
    'same-ID/same-trigger reacquisition must persist a fresh lease timestamp',
  );
  assert.ok(
    mutatingCalls.some(
      (call) =>
        call.method === 'PATCH' &&
        call.url === `/repos/${OWNER}/${REPO}/issues/comments/${expired.id}`,
    ),
  );
});

test('repeated direct waiting reconciliation keeps durable state without PATCH churn', async (t) => {
  const stateComment = waitingStateComment();
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: { ...basePr(), labels: [{ name: WAITING_LABEL }] },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [stateComment],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [{ id: 1, name: 'ci', status: 'in_progress', conclusion: null }] },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'workflow_run:completed',
    CI_RECOVERY_MODE: 'live',
    MERGE_TRAIN_ENABLED: 'true',
    MERGE_TRAIN_ADMISSION_CHECKS: 'ci',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.match(stdout, /state unchanged pr=#42 status=waiting/);
  assert.match(stdout, /wait pr=#42 admission=ci/);
  assert.equal(
    mutatingCalls.some(
      (call) =>
        call.method === 'PATCH' &&
        call.url === `/repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`,
    ),
    false,
  );
  assert.equal(
    mutatingCalls.some(
      (call) =>
        call.method === 'DELETE' &&
        call.url.endsWith(`/labels/${encodeURIComponent(WAITING_LABEL)}`),
    ),
    false,
    'direct rechecks must retain the waiting marker until facts leave waiting',
  );
});

test('direct state-change event persists convergence before clearing the waiting marker', async (t) => {
  const stateComment = waitingStateComment(782);
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: { ...basePr(), labels: [{ name: WAITING_LABEL }] },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [stateComment],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`PATCH /repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`]: () => ({
      body: { id: stateComment.id },
    }),
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${WAITING_LABEL}`]: () => ({
      body: {},
    }),
    [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: {
        check_runs: [{ id: 2, name: 'ci', status: 'completed', conclusion: 'success' }],
      },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
    [`POST /repos/${OWNER}/${REPO}/labels`]: () => ({ body: {} }),
    [`POST /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels`]: () => ({ body: {} }),
    [`POST /repos/${OWNER}/${REPO}/actions/workflows/ci-recovery-router.yml/dispatches`]: () => ({
      body: {},
    }),
  });
  t.after(() => server.close());

  const { code, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'workflow_run:completed',
    CI_RECOVERY_MODE: 'live',
    MERGE_TRAIN_ENABLED: 'true',
    MERGE_TRAIN_ADMISSION_CHECKS: 'ci',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  const statePatchIndex = mutatingCalls.findIndex(
    (call) =>
      call.method === 'PATCH' &&
      call.url === `/repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`,
  );
  const transitionPostIndex = mutatingCalls.findIndex(
    (call) =>
      call.method === 'POST' &&
      call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels` &&
      call.body?.labels?.includes(WAITING_TRANSITION_LABEL),
  );
  const waitingDeleteIndex = mutatingCalls.findIndex(
    (call) =>
      call.method === 'DELETE' &&
      call.url ===
        `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${encodeURIComponent(WAITING_LABEL)}`,
  );
  const transitionDeleteIndex = mutatingCalls.findIndex(
    (call) =>
      call.method === 'DELETE' &&
      call.url ===
        `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${encodeURIComponent(WAITING_TRANSITION_LABEL)}`,
  );
  assert.ok(transitionPostIndex >= 0);
  assert.ok(statePatchIndex > transitionPostIndex);
  assert.ok(statePatchIndex >= 0);
  assert.ok(waitingDeleteIndex > statePatchIndex);
  assert.ok(transitionDeleteIndex > waitingDeleteIndex);
});

test('failed non-owning waiting cleanup remains schedule-retryable via transition marker', async (t) => {
  const waitingComment = waitingStateComment(786);
  let convergedStateBody = null;
  const first = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: { ...basePr(), labels: [{ name: WAITING_LABEL }] },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [waitingComment],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`PATCH /repos/${OWNER}/${REPO}/issues/comments/${waitingComment.id}`]: (_url, body) => {
      convergedStateBody = body.body;
      return { body: { id: waitingComment.id } };
    },
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${WAITING_LABEL}`]: () => ({
      status: 500,
      body: { message: 'temporary waiting cleanup failure' },
    }),
    [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: {
        check_runs: [{ id: 2, name: 'ci', status: 'completed', conclusion: 'success' }],
      },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
    [`POST /repos/${OWNER}/${REPO}/labels`]: () => ({ body: {} }),
    [`POST /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels`]: () => ({ body: {} }),
  });
  t.after(() => first.server.close());

  const failed = await runScript(first.port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'workflow_run:completed',
    CI_RECOVERY_MODE: 'live',
    MERGE_TRAIN_ENABLED: 'true',
    MERGE_TRAIN_ADMISSION_CHECKS: 'ci',
  });
  if (isWindowsAsyncCloseCrash(failed.code, failed.stderr)) {
    t.skip('Node subprocess hit the known Windows UV_HANDLE_CLOSING shutdown assertion');
    return;
  }
  assert.notEqual(failed.code, 0);
  assert.match(failed.stderr, /temporary waiting cleanup failure/);
  assert.equal(parseStateComment(convergedStateBody).status, 'idle');
  assert.ok(
    first.mutatingCalls.some(
      (call) =>
        call.method === 'POST' &&
        call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels` &&
        call.body?.labels?.includes(WAITING_TRANSITION_LABEL),
    ),
    'the transition marker must be durable before persisting non-waiting state',
  );

  const followupComment = { id: waitingComment.id, body: convergedStateBody };
  const second = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: {
        ...basePr(),
        labels: [{ name: WAITING_LABEL }, { name: WAITING_TRANSITION_LABEL }],
      },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [followupComment],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/`]: () => ({ body: {} }),
    [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: {
        check_runs: [{ id: 2, name: 'ci', status: 'completed', conclusion: 'success' }],
      },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
    [`POST /repos/${OWNER}/${REPO}/labels`]: () => ({ body: {} }),
    [`POST /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels`]: () => ({ body: {} }),
    [`POST /repos/${OWNER}/${REPO}/actions/workflows/ci-recovery-router.yml/dispatches`]: () => ({
      body: {},
    }),
  });
  t.after(() => second.server.close());

  const retried = await runScript(second.port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'schedule:sweep',
    CI_RECOVERY_MODE: 'live',
    MERGE_TRAIN_ENABLED: 'true',
    MERGE_TRAIN_ADMISSION_CHECKS: 'ci',
  });
  if (!assertSuccessfulExit(t, retried.code, retried.stderr, '', true)) return;
  assert.match(retried.stdout, /queued merge-train pr=#42/);
  for (const label of [WAITING_LABEL, WAITING_TRANSITION_LABEL]) {
    assert.ok(
      second.mutatingCalls.some(
        (call) =>
          call.method === 'DELETE' &&
          call.url ===
            `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${encodeURIComponent(label)}`,
      ),
      `schedule retry must clear ${label}`,
    );
  }
});

test('failed waiting-marker cleanup remains sweep-retryable after automation ownership is acquired', async (t) => {
  const waitingComment = waitingStateComment(784);
  const failedCheck = {
    id: 7,
    name: 'ci',
    status: 'completed',
    conclusion: 'failure',
    html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/7`,
  };
  let acquiredStateBody = null;
  const first = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: { ...basePr(), labels: [{ name: WAITING_LABEL }] },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [waitingComment],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`POST /repos/${OWNER}/${REPO}/labels`]: () => ({ body: { name: LABEL } }),
    [`POST /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels`]: () => ({ body: {} }),
    [`PATCH /repos/${OWNER}/${REPO}/issues/comments/${waitingComment.id}`]: (_url, body) => {
      acquiredStateBody = body.body;
      return { body: { id: waitingComment.id } };
    },
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${WAITING_LABEL}`]: () => ({
      status: 500,
      body: { message: 'temporary label API failure' },
    }),
    [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [failedCheck] },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
  });
  t.after(() => first.server.close());

  const failed = await runScript(first.port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'workflow_run:completed',
    CI_RECOVERY_MODE: 'live',
    MERGE_TRAIN_ADMISSION_CHECKS: 'ci',
  });
  if (isWindowsAsyncCloseCrash(failed.code, failed.stderr)) {
    t.skip('Node subprocess hit the known Windows UV_HANDLE_CLOSING shutdown assertion');
    return;
  }
  assert.notEqual(failed.code, 0);
  assert.match(failed.stderr, /temporary label API failure/);
  assert.equal(parseStateComment(acquiredStateBody).status, 'active');
  assert.equal(parseStateComment(acquiredStateBody).owner, 'automation');
  assert.ok(
    first.mutatingCalls.some(
      (call) =>
        call.method === 'POST' &&
        call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels` &&
        call.body?.labels?.includes(WAITING_TRANSITION_LABEL),
    ),
  );
  assert.equal(
    first.mutatingCalls.some(
      (call) =>
        call.method === 'POST' && call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`,
    ),
    false,
    'the recovery task is not posted before waiting-marker cleanup succeeds',
  );

  let repositoryOwnerExists = true;
  const followupComment = { id: waitingComment.id, body: acquiredStateBody };
  const second = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: {
        ...basePr(),
        labels: [{ name: WAITING_LABEL }, { name: WAITING_TRANSITION_LABEL }, { name: LABEL }],
      },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [followupComment],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () =>
      repositoryOwnerExists
        ? { body: { name: LABEL } }
        : { status: 404, body: { message: 'Not Found' } },
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${WAITING_LABEL}`]: () => ({
      body: {},
    }),
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${WAITING_TRANSITION_LABEL}`]: () => ({
      body: {},
    }),
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}`]: () => ({
      body: {},
    }),
    [`DELETE /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => {
      repositoryOwnerExists = false;
      return { body: {} };
    },
    [`POST /repos/${OWNER}/${REPO}/labels`]: () => {
      repositoryOwnerExists = true;
      return { body: { name: LABEL } };
    },
    [`POST /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels`]: () => ({ body: {} }),
    [`PATCH /repos/${OWNER}/${REPO}/issues/comments/${followupComment.id}`]: (_url, body) => {
      followupComment.body = body.body;
      return { body: { id: followupComment.id } };
    },
    [`POST /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: { id: 785 },
    }),
    [`POST /graphql`]: (_url, body) => {
      const query = String(body?.query || '');
      if (query.includes('suggestedActors')) {
        return {
          body: {
            data: {
              repository: {
                suggestedActors: {
                  nodes: [{ id: 'BOT_copilot', login: 'copilot' }],
                },
              },
            },
          },
        };
      }
      if (query.trimStart().startsWith('mutation')) {
        return {
          body: {
            data: {
              replaceActorsForAssignable: {
                assignable: { assignees: { nodes: [{ login: 'Copilot' }] } },
              },
            },
          },
        };
      }
      return { body: gqlNoThreads() };
    },
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [failedCheck] },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
  });
  t.after(() => second.server.close());

  const retried = await runScript(second.port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'schedule:sweep',
    CI_RECOVERY_MODE: 'live',
    MERGE_TRAIN_ADMISSION_CHECKS: 'ci',
  });
  if (!assertSuccessfulExit(t, retried.code, retried.stderr, '', true)) return;
  assert.match(retried.stdout, /assigned copilot pr=#42/);
  const waitingCleanupIndex = second.mutatingCalls.findIndex(
    (call) =>
      call.method === 'DELETE' &&
      call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${WAITING_LABEL}`,
  );
  const ownerReleaseIndex = second.mutatingCalls.findIndex(
    (call) =>
      call.method === 'DELETE' &&
      call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}`,
  );
  const transitionCleanupIndex = second.mutatingCalls.findIndex(
    (call) =>
      call.method === 'DELETE' &&
      call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${WAITING_TRANSITION_LABEL}`,
  );
  assert.ok(waitingCleanupIndex >= 0);
  assert.ok(transitionCleanupIndex > waitingCleanupIndex);
  assert.ok(ownerReleaseIndex > waitingCleanupIndex);
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

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.deepEqual(mutatingCalls, [], 'reconcile in dry-run must not issue any mutating API calls');
});

// ---------------------------------------------------------------------------
// expected_head_sha binding — fail closed on a time-of-check/time-of-use race
// between the trusted review-wake bridge's validation and this reconciliation.
// ---------------------------------------------------------------------------

/** Clean-PR route set: reconcile reaches the arm/admission decision. */
function trustedReviewWakePr(overrides = {}) {
  return {
    ...basePr(),
    base: { ref: 'main', repo: { full_name: `${OWNER}/${REPO}` } },
    ...overrides,
  };
}

function cleanReconcileRoutes() {
  return {
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: trustedReviewWakePr(),
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({ body: [] }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [] },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
  };
}

test('expected_head_sha match: reconcile proceeds normally past the head guard', async (t) => {
  const { server, port, mutatingCalls } = await startServer(cleanReconcileRoutes());
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'trusted-review-wake:pull_request_review:run-1',
    EXPECTED_HEAD_SHA: HEAD_SHA,
    EXPECTED_BASE_REF: 'main',
    CI_RECOVERY_MODE: 'dry-run',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.doesNotMatch(stdout, /head-sha-moved/, 'a matching head must not trip the guard');
  assert.match(stdout, /(dry-run would-arm-auto-merge|wait pr=#42 admission=)/);
  assert.deepEqual(mutatingCalls, [], 'dry-run must not issue any mutating API calls');
});

test('expected_head_sha mismatch: reconcile fails closed before any mutation, even in live mode', async (t) => {
  const movedHead = 'b'.repeat(40);
  // Only the PR fetch should be reached; the guard exits before comments,
  // labels, checks, or any mutation — so no other route is registered.
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: trustedReviewWakePr(),
    }),
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'trusted-review-wake:pull_request_review:run-1',
    EXPECTED_HEAD_SHA: movedHead,
    EXPECTED_BASE_REF: 'main',
    CI_RECOVERY_MODE: 'live',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.match(
    stdout,
    new RegExp(`skip pr=#${PR_NUM} reason=head-sha-moved expected=${movedHead} actual=${HEAD_SHA}`),
  );
  assert.deepEqual(mutatingCalls, [], 'a mismatched head must fail closed with no mutation');
});

test('trusted metadata mismatch does not clean a pre-existing ownership artifact', async (t) => {
  const movedHead = 'b'.repeat(40);
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: {
        ...trustedReviewWakePr(),
        labels: [{ name: LABEL }],
      },
    }),
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'trusted-review-wake:pull_request_review:run-1',
    EXPECTED_HEAD_SHA: movedHead,
    EXPECTED_BASE_REF: 'main',
    CI_RECOVERY_MODE: 'live',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.match(stdout, /reason=head-sha-moved/);
  assert.deepEqual(
    mutatingCalls,
    [],
    'orphan cleanup must remain behind the opening trusted-metadata fence',
  );
});

test('expected_head_sha without expected_base_ref fails closed before any mutation', async (t) => {
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: trustedReviewWakePr(),
    }),
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'trusted-review-wake:pull_request_review:run-1',
    EXPECTED_HEAD_SHA: HEAD_SHA,
    EXPECTED_BASE_REF: '',
    CI_RECOVERY_MODE: 'live',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.match(
    stdout,
    new RegExp(`skip pr=#${PR_NUM} reason=missing-expected-base-ref expected=non-empty actual=`),
  );
  assert.deepEqual(mutatingCalls, [], 'an incomplete trust envelope must not mutate the PR');
});

test('empty expected_head_sha preserves normal reconcile behavior', async (t) => {
  const { server, port, mutatingCalls } = await startServer(cleanReconcileRoutes());
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    EXPECTED_HEAD_SHA: '',
    CI_RECOVERY_MODE: 'dry-run',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.doesNotMatch(stdout, /head-sha-moved/, 'an empty expected SHA must not trip the guard');
  assert.match(stdout, /(dry-run would-arm-auto-merge|wait pr=#42 admission=)/);
  assert.deepEqual(mutatingCalls, [], 'dry-run must not issue any mutating API calls');
});

test('same-head retarget before reconcile fails closed before any mutation', async (t) => {
  const retargetedBase = 'release';
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: {
        ...trustedReviewWakePr(),
        base: { ...trustedReviewWakePr().base, ref: retargetedBase },
      },
    }),
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'trusted-review-wake:pull_request_review:run-1',
    EXPECTED_HEAD_SHA: HEAD_SHA,
    EXPECTED_BASE_REF: 'main',
    CI_RECOVERY_MODE: 'live',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.match(
    stdout,
    new RegExp(`skip pr=#${PR_NUM} reason=base-ref-moved expected=main actual=${retargetedBase}`),
  );
  assert.deepEqual(mutatingCalls, [], 'a retargeted PR must fail closed with no mutation');
});

test('moved head after initial fetch fails closed before the first mutation phase', async (t) => {
  // A synchronize can land after reconcile's opening PR fetch but before the
  // first write. The per-phase recheck must re-fetch the live head immediately
  // before mutating and fail closed if it moved, so no state comment, label,
  // task comment, or Copilot assignment ever touches a head the bridge never
  // validated. A mergeable:false PR deterministically reaches acquire (the very
  // first mutation phase) in live mode.
  const movedHead = 'b'.repeat(40);
  let pullFetches = 0;
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => {
      pullFetches += 1;
      // Call #1 is the opening fetch (passes the initial guard); call #2 is the
      // per-phase recheck inside acquire, which must observe the moved head.
      const head = pullFetches === 1 ? HEAD_SHA : movedHead;
      return {
        body: {
          ...trustedReviewWakePr(),
          mergeable: false,
          mergeable_state: 'clean',
          head: { ...trustedReviewWakePr().head, sha: head },
        },
      };
    },
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({ body: [] }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'trusted-review-wake:pull_request_review:run-1',
    EXPECTED_HEAD_SHA: HEAD_SHA,
    EXPECTED_BASE_REF: 'main',
    CI_RECOVERY_MODE: 'live',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.match(
    stdout,
    new RegExp(
      `skip pr=#${PR_NUM} reason=head-sha-moved-before-mutation phase=acquire-label expected=${HEAD_SHA} actual=${movedHead}`,
    ),
    'a head that moved after the initial fetch must trip the per-phase guard',
  );
  assert.equal(pullFetches, 2, 'the per-phase guard must re-fetch the live head before mutating');
  assert.deepEqual(
    mutatingCalls,
    [],
    'a head moved before the first mutation must fail closed with no mutation',
  );
});

test('same-head retarget after initial fetch fails closed before the first mutation phase', async (t) => {
  const retargetedBase = 'release';
  let pullFetches = 0;
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => {
      pullFetches += 1;
      const baseRef = pullFetches === 1 ? 'main' : retargetedBase;
      return {
        body: {
          ...trustedReviewWakePr(),
          mergeable: false,
          mergeable_state: 'clean',
          base: { ...trustedReviewWakePr().base, ref: baseRef },
        },
      };
    },
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({ body: [] }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'trusted-review-wake:pull_request_review:run-1',
    EXPECTED_HEAD_SHA: HEAD_SHA,
    EXPECTED_BASE_REF: 'main',
    CI_RECOVERY_MODE: 'live',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.match(
    stdout,
    new RegExp(
      `skip pr=#${PR_NUM} reason=base-ref-moved-before-mutation phase=acquire-label expected=main actual=${retargetedBase}`,
    ),
  );
  assert.equal(pullFetches, 2);
  assert.deepEqual(mutatingCalls, [], 'a same-head retarget must fail closed with no mutation');
});

test('same-head draft conversion fails closed before the first mutation phase', async (t) => {
  let pullFetches = 0;
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => {
      pullFetches += 1;
      return {
        body: {
          ...trustedReviewWakePr(),
          mergeable: false,
          mergeable_state: 'clean',
          draft: pullFetches > 1,
        },
      };
    },
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({ body: [] }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'trusted-review-wake:pull_request_review:run-1',
    EXPECTED_HEAD_SHA: HEAD_SHA,
    EXPECTED_BASE_REF: 'main',
    CI_RECOVERY_MODE: 'live',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.match(
    stdout,
    new RegExp(
      `skip pr=#${PR_NUM} reason=pr-drafted-before-mutation phase=acquire-label expected=false actual=true`,
    ),
  );
  assert.equal(pullFetches, 2);
  assert.deepEqual(mutatingCalls, [], 'a draft conversion must fail closed with no mutation');
});

test('empty expected_head_sha makes no extra head re-fetch before mutations', async (t) => {
  // The per-phase recheck is a no-op when EXPECTED_HEAD_SHA is empty, so normal
  // manual/router/scheduled/lease flows keep their exact prior API footprint:
  // exactly one PR fetch and no additional /pulls calls per mutation phase.
  let pullFetches = 0;
  const { server, port } = await startServer({
    ...cleanReconcileRoutes(),
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => {
      pullFetches += 1;
      return { body: basePr() };
    },
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    EXPECTED_HEAD_SHA: '',
    CI_RECOVERY_MODE: 'live',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.doesNotMatch(stdout, /head-sha-moved/, 'an empty expected SHA must not trip any guard');
  assert.equal(pullFetches, 1, 'an empty expected SHA must not add per-phase head re-fetches');
});

test('reconcile treats mergeable_state=behind as non-conflict and does not dispatch recovery', async (t) => {
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: { ...basePr(), mergeable: true, mergeable_state: 'behind' },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({ body: [] }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [] },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
  });

  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    CI_RECOVERY_MODE: 'dry-run',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.match(stdout, /(dry-run would-arm-auto-merge|wait pr=#42 admission=)/);
  assert.doesNotMatch(stdout, /dry-run would-assign copilot/);
  assert.doesNotMatch(stdout, /merge-conflict/);
  assert.deepEqual(mutatingCalls, [], 'dry-run must not issue any mutating API calls');
});

test('human-gated balance PR cannot keep merge-train or armed auto-merge before owner approval', async (t) => {
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: {
        ...basePr(),
        node_id: 'PR_balance_gate',
        auto_merge: { enabled_at: '2026-07-16T00:00:00Z' },
        head: {
          ...basePr().head,
          ref: 'copilot/balance-telemetry-driven-improvement-sweep',
        },
        labels: [
          { name: 'merge-train' },
          { name: 'merge-train-blocked' },
          { name: 'human-approval-required' },
          { name: 'ci-recovery-opt-out' },
        ],
      },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({ body: [] }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/`]: () => ({ body: {} }),
    [`POST /graphql`]: (_url, parsed) => {
      if (String(parsed?.query || '').includes('closingIssuesReferences')) {
        return {
          body: {
            data: {
              repository: {
                pullRequest: {
                  closingIssuesReferences: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [],
                  },
                },
              },
            },
          },
        };
      }
      if (
        String(parsed?.query || '')
          .trimStart()
          .startsWith('mutation')
      ) {
        return {
          body: {
            data: {
              disablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: null } },
            },
          },
        };
      }
      return { body: gqlNoThreads() };
    },
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: {
        check_runs: [
          { id: 1, name: 'Human approval', status: 'completed', conclusion: 'failure' },
          { id: 2, name: 'Merge gate', status: 'completed', conclusion: 'failure' },
          { id: 3, name: 'ci', status: 'completed', conclusion: 'failure' },
          { id: 4, name: 'Security checks', status: 'completed', conclusion: 'success' },
        ],
      },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
  });

  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    CI_RECOVERY_MODE: 'live',
    MERGE_TRAIN_ENABLED: 'true',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.match(stdout, /blocked pr=#42 reason=human-approval-required/);
  assert.match(stdout, /disabled auto-merge pr=#42 reason=human-approval-required/);
  // TODO(ci-recovery): remove required-checks fallback once all branches emit admission=.
  // Accept both log formats while train admission wording converges across branches.
  assert.match(stdout, /wait pr=#42 (required-checks|admission)=ci/);
  assert.doesNotMatch(stdout, /removed temporary approval opt-out/);
  assert.ok(
    mutatingCalls.some(
      (call) =>
        call.method === 'DELETE' &&
        call.url.endsWith(`/labels/${encodeURIComponent('merge-train')}`),
    ),
  );
  assert.ok(
    mutatingCalls.some((call) => call.method === 'GRAPHQL_MUTATION' && call.url === '/graphql'),
  );
  assert.equal(
    mutatingCalls.some(
      (call) =>
        call.method === 'DELETE' &&
        call.url.endsWith(`/labels/${encodeURIComponent('merge-train-blocked')}`),
    ),
    false,
  );
  assert.equal(
    mutatingCalls.some(
      (call) =>
        call.method === 'DELETE' &&
        call.url.endsWith(`/labels/${encodeURIComponent('ci-recovery-opt-out')}`),
    ),
    false,
  );
  assert.equal(
    mutatingCalls.some(
      (call) => call.method === 'POST' && call.body?.labels?.includes('merge-train'),
    ),
    false,
  );
  assert.equal(
    mutatingCalls.some(
      (call) =>
        call.method === 'POST' &&
        typeof call.body?.body === 'string' &&
        call.body.body.includes('crawler-ci-task'),
    ),
    false,
  );
});

test('scheduled sweep clears stale train labels when persisted state head differs from the live PR head', async (t) => {
  const staleState = makeState({
    prNumber: PR_NUM,
    headSha: 'ffffffffffffffffffffffffffffffffffffff',
    fingerprint: blockerFingerprint([]),
    owner: 'none',
    status: 'idle',
    trigger: 'reconcile:manual',
    blockers: [],
    updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  });
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: {
        ...basePr(),
        mergeable: true,
        mergeable_state: 'clean',
        labels: [{ name: 'merge-train-blocked' }],
      },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [{ id: 555, body: renderStateComment(staleState) }],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/`]: () => ({ body: {} }),
    [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [] },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
  });

  t.after(() => server.close());

  const { code, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'schedule',
    CI_RECOVERY_MODE: 'live',
    MERGE_TRAIN_ENABLED: 'true',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  const clearedBlockedLabel = mutatingCalls.some(
    (call) =>
      call.method === 'DELETE' &&
      call.url ===
        `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${encodeURIComponent('merge-train-blocked')}`,
  );
  assert.equal(
    clearedBlockedLabel,
    true,
    'a scheduled sweep must clear the stale merge-train-blocked label once the head has moved past the persisted state, not only on a :synchronize trigger',
  );
});

test('train mode persists a converged state comment before queuing a clean PR with no prior comment', async (t) => {
  // A PR that never needed a recovery owner (all required checks pass on the
  // very first reconcile) has no pre-existing state comment. merge-train's
  // eligible() requires exactly one CI-recovery state comment before it will
  // admit a PR, so reconcile must create that comment before attaching the
  // queue label below, or the very next train reconciliation would de-admit
  // this PR as stale and redispatch it forever.
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({ body: basePr() }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({ body: [] }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: {
        check_runs: [
          {
            id: 1,
            name: 'ci',
            status: 'completed',
            conclusion: 'success',
            html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/1`,
          },
        ],
      },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
    [`POST /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: { id: 999, body: '' },
    }),
    [`POST /repos/${OWNER}/${REPO}/labels`]: () => ({ body: { name: 'merge-train' } }),
    [`POST /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels`]: () => ({ body: {} }),
    [`POST /repos/${OWNER}/${REPO}/actions/workflows/ci-recovery-router.yml/dispatches`]: () => ({
      body: {},
    }),
  });

  test('repeated clean reconciliation of an already queued PR does not dispatch another fill sweep', async (t) => {
    const { server, port, mutatingCalls } = await startServer({
      [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
        body: { ...basePr(), labels: [{ name: 'merge-train' }] },
      }),
      [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({ body: [] }),
      [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
        status: 404,
        body: { message: 'Not Found' },
      }),
      [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
    });
    t.after(() => server.close());

    const { code, stdout, stderr } = await runScript(port, {
      RECOVERY_OPERATION: 'reconcile',
      RECOVERY_TRIGGER: 'schedule:sweep',
      CI_RECOVERY_MODE: 'live',
      MERGE_TRAIN_ENABLED: 'true',
      MERGE_TRAIN_ADMISSION_CHECKS: 'ci',
    });
    if (!assertSuccessfulExit(t, code, stderr, '', true)) return;

    assert.match(stdout, /skip pr=#42 reason=merge-train-owned/);
    assert.equal(
      mutatingCalls.some(
        (call) =>
          call.method === 'POST' &&
          call.url ===
            `/repos/${OWNER}/${REPO}/actions/workflows/ci-recovery-router.yml/dispatches`,
      ),
      false,
    );
  });

  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'schedule',
    CI_RECOVERY_MODE: 'live',
    MERGE_TRAIN_ENABLED: 'true',
    MERGE_TRAIN_ADMISSION_CHECKS: 'ci',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.match(stdout, /queued merge-train pr=#42/);
  const commentPost = mutatingCalls.find(
    (call) =>
      call.method === 'POST' && call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`,
  );
  assert.ok(
    commentPost,
    'reconcile must persist a converged state comment for a label-free, comment-free PR once its required checks pass',
  );
  const commentPostIndex = mutatingCalls.indexOf(commentPost);
  const queueLabelIndex = mutatingCalls.findIndex(
    (call) =>
      call.method === 'POST' && call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels`,
  );
  assert.ok(queueLabelIndex >= 0, 'expected the PR to be labeled for the merge train');
  assert.ok(
    commentPostIndex < queueLabelIndex,
    'the state comment must be persisted before the queue label is attached',
  );
});

test('train mode waits when Copilot produced only a no-files review', async (t) => {
  const noFilesReview = substantiveCopilotReview({
    body: "Copilot wasn't able to review any files in this pull request.",
  });
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({ body: basePr() }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({ body: [] }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`POST /graphql`]: () => ({ body: gqlNoThreads([noFilesReview]) }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: {
        check_runs: [
          {
            id: 1,
            name: 'ci',
            status: 'completed',
            conclusion: 'success',
            html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/1`,
          },
        ],
      },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'schedule',
    CI_RECOVERY_MODE: 'live',
    MERGE_TRAIN_ENABLED: 'true',
    MERGE_TRAIN_ADMISSION_CHECKS: 'ci',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.match(stdout, /admission=substantive-copilot-review/);
  const labelPosts = mutatingCalls.filter(
    (call) =>
      call.method === 'POST' && call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels`,
  );
  assert.ok(
    labelPosts.some((call) => call.body?.labels?.includes(WAITING_LABEL)),
    'a no-files review should durably mark the PR as waiting',
  );
  assert.equal(
    labelPosts.some((call) => call.body?.labels?.includes('merge-train')),
    false,
    'a no-files review must not admit the PR to the merge train',
  );
});

test('synchronize sweep does not immediately recreate a stale merge-train-noop blocker it just cleared', async (t) => {
  // The PR previously carried merge-train-blocked + merge-train-noop (the
  // train decided its squash diff was already in the base). A new
  // synchronize event means the head moved past that judgment. The cleanup
  // branch removes all three train labels via the API, but `trainNoop` /
  // `validationFailed` were captured from the labels the PR had when this
  // run started -- if reconcile doesn't also reset those in-memory flags, the
  // very next lines would re-push the same merge-train-noop blocker for the
  // newly synchronized head instead of letting it revalidate cleanly.
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: {
        ...basePr(),
        mergeable: true,
        mergeable_state: 'clean',
        labels: [{ name: 'merge-train-blocked' }, { name: 'merge-train-noop' }],
      },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({ body: [] }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: {
        check_runs: [
          {
            id: 1,
            name: 'ci',
            status: 'completed',
            conclusion: 'success',
            html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/1`,
          },
        ],
      },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
    [`POST /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: { id: 999, body: '' },
    }),
    [`POST /repos/${OWNER}/${REPO}/labels`]: () => ({ body: { name: 'merge-train' } }),
    [`POST /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels`]: () => ({ body: {} }),
    [`POST /repos/${OWNER}/${REPO}/actions/workflows/ci-recovery-router.yml/dispatches`]: () => ({
      body: {},
    }),
  });

  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'pull_request_target:synchronize',
    CI_RECOVERY_MODE: 'live',
    MERGE_TRAIN_ENABLED: 'true',
    MERGE_TRAIN_ADMISSION_CHECKS: 'ci',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  for (const label of [
    'merge-train-blocked',
    'merge-train-noop',
    'merge-train-validation-failed',
  ]) {
    assert.equal(
      mutatingCalls.some(
        (call) =>
          call.method === 'DELETE' &&
          call.url ===
            `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${encodeURIComponent(label)}`,
      ),
      true,
      `expected the stale ${label} label to be cleared on synchronize`,
    );
  }
  assert.match(
    stdout,
    /queued merge-train pr=#42/,
    'clearing the stale noop label must let the newly synchronized head revalidate and queue cleanly, not immediately recreate the same blocker',
  );
  assert.equal(
    mutatingCalls.some(
      (call) =>
        call.method === 'POST' &&
        call.url === `/repos/${OWNER}/${REPO}/labels` &&
        call.body?.name === LABEL,
    ),
    false,
    'a stale in-memory noop/validation-failed flag must not cause reconcile to acquire a recovery-owner label for the new head',
  );
});

test('legacy mode removes train labels without recursive cleanup', async (t) => {
  const trainLabels = [
    'merge-train',
    'merge-train-blocked',
    'merge-train-noop',
    'merge-train-validation-failed',
  ];
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: {
        ...basePr(),
        labels: trainLabels.map((name) => ({ name })),
      },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({ body: [] }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/`]: () => ({ body: {} }),
    [`POST /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: { id: 999, body: '' },
    }),
    [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [] },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
  });

  t.after(() => server.close());

  const { code, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    CI_RECOVERY_MODE: 'live',
    MERGE_TRAIN_ENABLED: 'false',
    MERGE_TRAIN_ADMISSION_CHECKS: 'required-check',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  const deletedLabels = mutatingCalls
    .filter((call) => call.method === 'DELETE')
    .map((call) => decodeURIComponent(call.url.split('/').at(-1)))
    .sort();
  assert.deepEqual(deletedLabels, [...trainLabels].sort());
});

test('reconcile still emits merge-conflict blocker for dirty or mergeable=false PRs', async (t) => {
  const conflictFixtures = [
    { name: 'dirty', pr: { ...basePr(), mergeable: true, mergeable_state: 'dirty' } },
    { name: 'mergeable-false', pr: { ...basePr(), mergeable: false, mergeable_state: 'clean' } },
  ];

  for (const fixture of conflictFixtures) {
    const { server, port, mutatingCalls } = await startServer({
      [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({ body: fixture.pr }),
      [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({ body: [] }),
      [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
        status: 404,
        body: { message: 'Not Found' },
      }),
      [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
      [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
        body: { check_runs: [] },
      }),
      [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
    });

    t.after(() => server.close());

    const { code, stdout, stderr } = await runScript(port, {
      RECOVERY_OPERATION: 'reconcile',
      CI_RECOVERY_MODE: 'dry-run',
    });

    if (!assertSuccessfulExit(t, code, stderr, `fixture=${fixture.name}`, true)) return;
    assert.match(
      stdout,
      /dry-run would-assign copilot/,
      `fixture=${fixture.name} expected dispatch`,
    );
    assert.match(
      stdout,
      /merge-conflict/,
      `fixture=${fixture.name} expected merge-conflict blocker`,
    );
    assert.deepEqual(
      mutatingCalls,
      [],
      `fixture=${fixture.name} dry-run must not issue any mutating API calls`,
    );
  }
});

test('train mode dispatches exactly one conflict-only rebase', async (t) => {
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: { ...trustedReviewWakePr(), mergeable: false, mergeable_state: 'dirty' },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({ body: [] }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
    [`POST /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: { id: 999, body: '' },
    }),
    [`POST /repos/${OWNER}/${REPO}/actions/workflows/auto-rebase-prs.yml/dispatches`]: () => ({
      body: {},
    }),
  });

  t.after(() => server.close());

  const { code, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'pull_request_target:synchronize',
    CI_RECOVERY_MODE: 'live',
    MERGE_TRAIN_ENABLED: 'true',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.equal(
    mutatingCalls.filter(
      (call) =>
        call.method === 'POST' && call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`,
    ).length,
    1,
  );
  assert.equal(
    mutatingCalls.filter(
      (call) =>
        call.method === 'POST' &&
        call.url === `/repos/${OWNER}/${REPO}/actions/workflows/auto-rebase-prs.yml/dispatches`,
    ).length,
    1,
  );
  const dispatch = mutatingCalls.find(
    (call) =>
      call.method === 'POST' &&
      call.url === `/repos/${OWNER}/${REPO}/actions/workflows/auto-rebase-prs.yml/dispatches`,
  );
  assert.equal(dispatch.body.inputs.expected_head_sha, HEAD_SHA);
  assert.equal(dispatch.body.inputs.expected_base_ref, 'main');
});

test('trusted metadata drift after conflict state write blocks auto-rebase dispatch', async (t) => {
  let pullFetches = 0;
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => {
      pullFetches += 1;
      const baseRef = pullFetches >= 3 ? 'release' : 'main';
      return {
        body: {
          ...trustedReviewWakePr(),
          mergeable: false,
          mergeable_state: 'dirty',
          base: { ...trustedReviewWakePr().base, ref: baseRef },
        },
      };
    },
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({ body: [] }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
    [`POST /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: { id: 999, body: '' },
    }),
    [`POST /repos/${OWNER}/${REPO}/actions/workflows/auto-rebase-prs.yml/dispatches`]: () => ({
      body: {},
    }),
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'trusted-review-wake:pull_request_review:run-1',
    EXPECTED_HEAD_SHA: HEAD_SHA,
    EXPECTED_BASE_REF: 'main',
    CI_RECOVERY_MODE: 'live',
    MERGE_TRAIN_ENABLED: 'true',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.match(
    stdout,
    /reason=base-ref-moved-before-mutation phase=auto-rebase-dispatch expected=main actual=release/,
  );
  assert.equal(pullFetches, 3);
  assert.equal(
    mutatingCalls.filter(
      (call) =>
        call.method === 'POST' &&
        call.url === `/repos/${OWNER}/${REPO}/actions/workflows/auto-rebase-prs.yml/dispatches`,
    ).length,
    0,
  );
});

/** A previously-dispatched conflict-only rebase state comment for HEAD_SHA. */
function rebaseDispatchedStateComment(id, updatedAt, attempt = 1) {
  const state = makeState({
    prNumber: PR_NUM,
    headSha: HEAD_SHA,
    fingerprint: blockerFingerprint([
      {
        kind: 'merge-conflict',
        id: HEAD_SHA,
        summary: 'The PR conflicts with main and requires a conflict-only rebase.',
        url: `https://github.com/${OWNER}/${REPO}/pull/${PR_NUM}`,
      },
    ]),
    owner: 'none',
    status: 'idle',
    trigger: 'rebase-dispatched',
    blockers: [
      {
        kind: 'merge-conflict',
        id: HEAD_SHA,
        summary: 'The PR conflicts with main and requires a conflict-only rebase.',
        url: `https://github.com/${OWNER}/${REPO}/pull/${PR_NUM}`,
      },
    ],
    attempt,
    updatedAt,
  });
  return { id, body: renderStateComment(state) };
}

test('train mode waits on a still-pending conflict-only rebase for the same head', async (t) => {
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: { ...basePr(), mergeable: false, mergeable_state: 'dirty' },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [rebaseDispatchedStateComment(900, new Date().toISOString())],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
  });

  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'schedule',
    CI_RECOVERY_MODE: 'live',
    MERGE_TRAIN_ENABLED: 'true',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.match(stdout, /wait pr=#42 reason=conflict-rebase-pending/);
  assert.deepEqual(mutatingCalls, []);
});

test('train mode redispatches a conflict-only rebase once the prior dispatch times out', async (t) => {
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: { ...basePr(), mergeable: false, mergeable_state: 'dirty' },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [
        rebaseDispatchedStateComment(901, new Date(Date.now() - 20 * 60 * 1000).toISOString()),
      ],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
    [`PATCH /repos/${OWNER}/${REPO}/issues/comments/901`]: () => ({ body: { id: 901, body: '' } }),
    [`POST /repos/${OWNER}/${REPO}/actions/workflows/auto-rebase-prs.yml/dispatches`]: () => ({
      body: {},
    }),
  });

  t.after(() => server.close());

  const { code, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'schedule',
    CI_RECOVERY_MODE: 'live',
    MERGE_TRAIN_ENABLED: 'true',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.equal(
    mutatingCalls.filter(
      (call) =>
        call.method === 'POST' &&
        call.url === `/repos/${OWNER}/${REPO}/actions/workflows/auto-rebase-prs.yml/dispatches`,
    ).length,
    1,
    'expected the timed-out rebase-dispatched state to be redispatched, not waited on forever',
  );
  assert.equal(
    mutatingCalls.filter(
      (call) =>
        call.method === 'PATCH' && call.url === `/repos/${OWNER}/${REPO}/issues/comments/901`,
    ).length,
    1,
  );
});

test('train mode retries auto-rebase-failure for the same head before timeout once backoff elapses', async (t) => {
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: { ...basePr(), mergeable: false, mergeable_state: 'dirty' },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [
        rebaseDispatchedStateComment(902, new Date(Date.now() - 2 * 60 * 1000).toISOString(), 1),
      ],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
    [`PATCH /repos/${OWNER}/${REPO}/issues/comments/902`]: () => ({ body: { id: 902, body: '' } }),
    [`POST /repos/${OWNER}/${REPO}/actions/workflows/auto-rebase-prs.yml/dispatches`]: () => ({
      body: {},
    }),
  });

  t.after(() => server.close());

  const { code, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'auto-rebase-failure',
    CI_RECOVERY_MODE: 'live',
    MERGE_TRAIN_ENABLED: 'true',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.equal(
    mutatingCalls.filter(
      (call) =>
        call.method === 'POST' &&
        call.url === `/repos/${OWNER}/${REPO}/actions/workflows/auto-rebase-prs.yml/dispatches`,
    ).length,
    1,
  );
});

test('train mode waits during bounded backoff for auto-rebase-failure retries', async (t) => {
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: { ...basePr(), mergeable: false, mergeable_state: 'dirty' },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [rebaseDispatchedStateComment(903, new Date().toISOString(), 1)],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
  });

  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'auto-rebase-failure',
    CI_RECOVERY_MODE: 'live',
    MERGE_TRAIN_ENABLED: 'true',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.match(stdout, /wait pr=#42 reason=conflict-rebase-retry-backoff attempt=1/);
  assert.deepEqual(mutatingCalls, []);
});

test('train mode escalates an explicit auto-rebase-failure once bounded retries are exhausted', async (t) => {
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: { ...basePr(), mergeable: false, mergeable_state: 'dirty' },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      // Already retried REBASE_FAILURE_MAX_ATTEMPTS (3) times, still fresh (not timed out).
      body: [rebaseDispatchedStateComment(903, new Date().toISOString(), 3)],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [] },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
  });

  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'auto-rebase-failure',
    CI_RECOVERY_MODE: 'dry-run',
    MERGE_TRAIN_ENABLED: 'true',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.match(stdout, /merge-conflict/, 'expected the conflict blocker to still surface');
  assert.match(stdout, /dry-run would-assign copilot/, 'expected fallthrough to escalation');
  assert.equal(
    mutatingCalls.filter(
      (call) =>
        call.method === 'POST' &&
        call.url === `/repos/${OWNER}/${REPO}/actions/workflows/auto-rebase-prs.yml/dispatches`,
    ).length,
    0,
    'must not redispatch once bounded retries are exhausted',
  );
});

// Regression coverage for a review finding: the exponential backoff
// (60s/120s/240s, bounded at REBASE_FAILURE_MAX_ATTEMPTS) previously only
// applied when the invoking trigger was literally `auto-rebase-failure`. Any
// other trigger -- in particular the 10-minute `schedule` sweep dispatched by
// ci-recovery-router.yml -- fell straight through to the flat 15-minute
// pending-timeout wait, so a schedule sweep firing 70s after a failed attempt
// (well past the 60s backoff for attempt 1) would keep waiting instead of
// retrying, silently swallowing the intended cadence.
test('train mode honors the same bounded backoff for schedule sweeps, not just auto-rebase-failure', async (t) => {
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: { ...basePr(), mergeable: false, mergeable_state: 'dirty' },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      // attempt 1, dispatched 70s ago -- past the 60s backoff for attempt 1,
      // but nowhere near the 15-minute flat pending timeout.
      body: [rebaseDispatchedStateComment(904, new Date(Date.now() - 70 * 1000).toISOString(), 1)],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
    [`PATCH /repos/${OWNER}/${REPO}/issues/comments/904`]: () => ({ body: { id: 904, body: '' } }),
    [`POST /repos/${OWNER}/${REPO}/actions/workflows/auto-rebase-prs.yml/dispatches`]: () => ({
      body: {},
    }),
  });

  t.after(() => server.close());

  const { code, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'schedule',
    CI_RECOVERY_MODE: 'live',
    MERGE_TRAIN_ENABLED: 'true',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.equal(
    mutatingCalls.filter(
      (call) =>
        call.method === 'POST' &&
        call.url === `/repos/${OWNER}/${REPO}/actions/workflows/auto-rebase-prs.yml/dispatches`,
    ).length,
    1,
    'expected the schedule sweep to retry once the backoff for attempt 1 elapsed, not wait for the 15m timeout',
  );
});

test('train mode still waits (does not retry) during bounded backoff for schedule sweeps', async (t) => {
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: { ...basePr(), mergeable: false, mergeable_state: 'dirty' },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      // attempt 1, dispatched moments ago -- still inside the 60s backoff.
      body: [rebaseDispatchedStateComment(905, new Date().toISOString(), 1)],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
  });

  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'schedule',
    CI_RECOVERY_MODE: 'live',
    MERGE_TRAIN_ENABLED: 'true',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.match(stdout, /wait pr=#42 reason=conflict-rebase-pending attempt=1/);
  assert.deepEqual(mutatingCalls, []);
});

// Regression coverage for the other half of the same finding: bounded
// retries must stay bounded regardless of which trigger observes them. A
// `schedule` sweep arriving after REBASE_FAILURE_MAX_ATTEMPTS attempts (but
// before the flat 15-minute pending timeout) must not redispatch a 4th
// attempt -- it must fall through to the same conflict-blocker escalation an
// exhausted `auto-rebase-failure` trigger gets, instead of fanning out
// indefinitely every 10 minutes.
test('train mode does not fan out past bounded retries for a schedule sweep once attempts are exhausted', async (t) => {
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: { ...basePr(), mergeable: false, mergeable_state: 'dirty' },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      // Already retried REBASE_FAILURE_MAX_ATTEMPTS (3) times, still fresh
      // (well inside the 15-minute flat pending timeout).
      body: [rebaseDispatchedStateComment(906, new Date().toISOString(), 3)],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [] },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
  });

  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'schedule',
    CI_RECOVERY_MODE: 'dry-run',
    MERGE_TRAIN_ENABLED: 'true',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.match(stdout, /merge-conflict/, 'expected the conflict blocker to still surface');
  assert.match(stdout, /dry-run would-assign copilot/, 'expected fallthrough to escalation');
  assert.equal(
    mutatingCalls.filter(
      (call) =>
        call.method === 'POST' &&
        call.url === `/repos/${OWNER}/${REPO}/actions/workflows/auto-rebase-prs.yml/dispatches`,
    ).length,
    0,
    'must not redispatch (or wait indefinitely) once bounded retries are exhausted, regardless of trigger',
  );
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

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.match(stdout, new RegExp(`skip action_required run=${runId} .* reason=same-repository`));
  assert.match(stdout, /wait pr=#42 admission=required-check/);
  assert.doesNotMatch(stdout, /workflow-approval|approved workflow|would-approve/);
  assert.equal(
    mutatingCalls.filter(
      (call) => call.url.includes('/actions/runs/') || call.url.includes('/actions/workflows/'),
    ).length,
    0,
    'same-repository action-required runs must not trigger approval or recovery dispatch',
  );
  assert.equal(
    mutatingCalls.filter(
      (call) =>
        call.method === 'POST' && call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`,
    ).length,
    1,
    'waiting PRs should persist one durable state comment',
  );
});

test('reconcile escalates required-check action-required runs as ci-retrigger blockers', async (t) => {
  const ciRunId = 29220010235;
  const lintRunId = 29220010236;
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
            id: ciRunId,
            name: 'CI',
            path: '.github/workflows/ci.yml',
            event: 'pull_request',
            conclusion: 'action_required',
            pull_requests: [{ number: PR_NUM }],
            html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/${ciRunId}`,
          },
          {
            id: lintRunId,
            name: 'commit-lint',
            path: '.github/workflows/commit-lint.yml',
            event: 'pull_request',
            conclusion: 'action_required',
            pull_requests: [{ number: PR_NUM }],
            html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/${lintRunId}`,
          },
        ],
      },
    }),
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}/files`]: () => ({ body: [] }),
    // acquire label + state comment when a new blocker is found
    [`POST /repos/${OWNER}/${REPO}/labels`]: () => ({ body: { name: LABEL } }),
    [`POST /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels`]: () => ({ body: {} }),
    [`POST /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: { id: 999, body: '' },
    }),
  });

  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    CI_RECOVERY_MODE: 'dry-run',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.match(
    stdout,
    new RegExp(`escalate action_required run=${ciRunId} .* reason=required-check-parked`),
  );
  // commit-lint was removed in PR #1109; its workflow path is no longer in
  // REQUIRED_CHECK_WORKFLOW_PATHS and must not produce a required-check-parked escalation.
  assert.doesNotMatch(
    stdout,
    new RegExp(`escalate action_required run=${lintRunId} .* reason=required-check-parked`),
  );
  // Must NOT attempt approval or produce an un-actionable wait-only exit
  assert.doesNotMatch(stdout, /workflow-approval|approved workflow|would-approve/);
  assert.doesNotMatch(
    stdout,
    /^wait pr=/m,
    'must not exit with a permanent wait when a required-check is parked',
  );
  // dry-run must make no mutating API calls
  assert.deepEqual(
    mutatingCalls,
    [],
    'dry-run must not issue any mutating API calls even with ci-retrigger blockers',
  );
});

test('reconcile ignores stale action-required run when a newer run of the same workflow succeeded', async (t) => {
  // A stale action_required run (lower id) and a newer success run (higher id)
  // for the same (path, event) must collapse to the latest — no ci-retrigger blocker.
  const staleRunId = 29220010240;
  const newRunId = 29220010241;
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
            id: staleRunId,
            name: 'CI',
            path: '.github/workflows/ci.yml',
            event: 'pull_request',
            conclusion: 'action_required',
            pull_requests: [{ number: PR_NUM }],
            html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/${staleRunId}`,
          },
          {
            id: newRunId,
            name: 'CI',
            path: '.github/workflows/ci.yml',
            event: 'pull_request',
            conclusion: 'success',
            pull_requests: [{ number: PR_NUM }],
            html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/${newRunId}`,
          },
        ],
      },
    }),
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}/files`]: () => ({ body: [] }),
  });

  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    CI_RECOVERY_MODE: 'dry-run',
    MERGE_TRAIN_ADMISSION_CHECKS: 'required-check',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.doesNotMatch(
    stdout,
    new RegExp(`escalate action_required run=${staleRunId}`),
    'stale action_required run must not produce a retrigger blocker when a newer success run exists',
  );
  assert.doesNotMatch(stdout, /ci-retrigger/, 'no ci-retrigger blocker expected');
  assert.deepEqual(mutatingCalls, [], 'no mutating calls expected');
});

// ---------------------------------------------------------------------------
// Regression: copilot assignee alone must never suppress recovery (#1092)
// ---------------------------------------------------------------------------

/**
 * GraphQL response with Copilot as an assignee but no review threads.
 * Simulates a PR where Copilot is assigned but there is no active lease or
 * state comment — the old guard would exit here with existing-copilot-assignment.
 */
function gqlCopilotAssigned() {
  return {
    data: {
      repository: {
        pullRequest: {
          id: 'PR_test_id',
          assignees: {
            nodes: [{ id: 'U_copilot', login: 'copilot' }],
          },
          reviews: reviewConnection(),
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        },
      },
    },
  };
}

function gqlReviewThreads(threads, reviews = [substantiveCopilotReview()]) {
  return {
    data: {
      repository: {
        pullRequest: {
          id: 'PR_test_id',
          assignees: { nodes: [] },
          reviews: reviewConnection(reviews),
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: threads,
          },
        },
      },
    },
  };
}

test('reconcile proceeds when copilot is assigned but no lease/state exists', async (t) => {
  // PR has Copilot as assignee, no owner label, no state comment, and one
  // failed CI check — recovery MUST proceed to detect the blocker, not exit
  // early with reason=existing-copilot-assignment.
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({ body: basePr() }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({ body: [] }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    // GraphQL returns Copilot as assignee but no review threads
    [`POST /graphql`]: () => ({ body: gqlCopilotAssigned() }),
    // One failed check gives the reconciler a blocker to detect
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

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    CI_RECOVERY_MODE: 'dry-run',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.doesNotMatch(
    stdout,
    /reason=existing-copilot-assignment/,
    'copilot assignee alone must not suppress recovery',
  );
  // dry-run must reach blocker detection and print a would-assign line
  assert.match(stdout, /dry-run would-assign copilot/, 'expected dry-run to reach dispatch');
});

test('reconcile resolves only ancestor lineage markers from compare status', async (t) => {
  const ancestorMarkerSha = 'def5678abc1234ff00aa11bb22cc33dd44ee55ff';
  const descendantMarkerSha = 'fedcba98765432100123456789abcdef12345678';
  const threadToResolve = 'thread-ancestor';
  const threadToKeep = 'thread-descendant';
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({ body: basePr() }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({ body: [] }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`POST /graphql`]: () => ({
      body: gqlReviewThreads([
        {
          id: threadToResolve,
          isResolved: false,
          comments: {
            nodes: [
              {
                body: `✅ Addressed in ${ancestorMarkerSha}`,
                authorAssociation: 'OWNER',
                author: { login: 'dev' },
              },
            ],
          },
        },
        {
          id: threadToKeep,
          isResolved: false,
          comments: {
            nodes: [
              {
                body: `✅ Addressed in ${descendantMarkerSha}`,
                authorAssociation: 'OWNER',
                author: { login: 'dev' },
              },
            ],
          },
        },
      ]),
    }),
    [`GET /repos/${OWNER}/${REPO}/compare/${ancestorMarkerSha}...${HEAD_SHA}`]: () => ({
      body: { status: 'ahead' },
    }),
    [`GET /repos/${OWNER}/${REPO}/compare/${descendantMarkerSha}...${HEAD_SHA}`]: () => ({
      body: { status: 'behind' },
    }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [] },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
  });

  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    CI_RECOVERY_MODE: 'dry-run',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.match(stdout, new RegExp(`would-resolve thread=${threadToResolve}`));
  assert.doesNotMatch(stdout, new RegExp(`would-resolve thread=${threadToKeep}`));
  assert.deepEqual(mutatingCalls, [], 'dry-run must not issue any mutating API calls');
});

test('reconcile does not escalate router action-required run when it is the only obstruction', async (t) => {
  // The CI Recovery Router is a non-required infrastructure workflow; its
  // action_required status must remain a skip, not a blocker, preserving the
  // rollout guard that prevents spurious Copilot dispatches.
  const routerRunId = 29220010237;
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
            id: routerRunId,
            name: 'CI Recovery Router',
            path: '.github/workflows/ci-recovery-router.yml',
            event: 'pull_request_review',
            conclusion: 'action_required',
            pull_requests: [{ number: PR_NUM }],
            html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/${routerRunId}`,
          },
        ],
      },
    }),
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}/files`]: () => ({ body: [] }),
  });

  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    CI_RECOVERY_MODE: 'dry-run',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.match(
    stdout,
    new RegExp(`skip action_required run=${routerRunId} .* reason=same-repository`),
  );
  assert.doesNotMatch(stdout, /escalate action_required/);
  assert.doesNotMatch(stdout, /ci-retrigger/);
  assert.deepEqual(
    mutatingCalls,
    [],
    'router-only action_required must not trigger any mutating calls',
  );
});
