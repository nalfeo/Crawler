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
import { admissionFingerprint, QUEUE_LABEL } from '../merge-train/state.mjs';

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
            mutatingCalls.push({ method: 'GRAPHQL_MUTATION', url: req.url, body: parsed });
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
    [`PATCH /repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`]: (_url, body) => {
      stateComment.body = body.body;
      return { body: { id: stateComment.id, body: body.body } };
    },
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
        ? { body: { name: LABEL, node_id: 'LABEL_original' } }
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
  assert.ok(
    mutatingCalls.indexOf(commentUpdate) < mutatingCalls.indexOf(labelDelete),
    'the terminal state must be persisted before the repository ownership fence is released',
  );
});

test('lease-release does not overwrite an owner that acquires after fence deletion', async (t) => {
  const stateComment = shepherdStateComment();
  let repositoryLabelExists = true;
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({ body: basePr() }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [stateComment],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () =>
      repositoryLabelExists
        ? { body: { name: LABEL, node_id: 'LABEL_original' } }
        : { status: 404, body: { message: 'Not Found' } },
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}`]: () => ({ body: {} }),
    [`PATCH /repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`]: (_url, body) => {
      stateComment.body = body.body;
      return { body: { id: stateComment.id, body: body.body } };
    },
    [`DELETE /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => {
      repositoryLabelExists = true;
      stateComment.body = renderStateComment(
        makeState({
          prNumber: PR_NUM,
          headSha: HEAD_SHA,
          fingerprint: blockerFingerprint([]),
          owner: 'automation',
          status: 'active',
          trigger: 'concurrent-acquire',
          blockers: [],
          updatedAt: new Date().toISOString(),
        }),
      );
      return { body: {} };
    },
  });
  t.after(() => server.close());

  const { code, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'lease-release',
    CI_RECOVERY_MODE: 'dry-run',
  });

  assert.notEqual(code, 0);
  assert.match(stderr, /owner label was recreated during release/);
  assert.equal(parseStateComment(stateComment.body)?.owner, 'automation');
  const commentUpdates = mutatingCalls.filter(
    (call) =>
      call.method === 'PATCH' &&
      call.url === `/repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`,
  );
  assert.equal(
    commentUpdates.length,
    1,
    'release must not PATCH after deleting its ownership fence',
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
        ? { body: { name: LABEL, node_id: 'LABEL_original' } }
        : { status: 404, body: { message: 'Not Found' } },
    [`POST /repos/${OWNER}/${REPO}/labels`]: () => {
      repositoryLabelExists = true;
      return { body: { name: LABEL } };
    },
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
    [`PATCH /repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`]: (_url, body) => {
      stateComment.body = body.body;
      return { body: { id: stateComment.id, body: body.body } };
    },
    [`POST /graphql`]: (_url, body) => {
      if (String(body?.query || '').includes('deleteLabel')) {
        repositoryLabelExists = false;
        return { body: { data: { deleteLabel: { clientMutationId: null } } } };
      }
      return { body: gqlNoThreads() };
    },
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
  assert.equal(parseStateComment(stateComment.body)?.status, 'idle');
});

test('known stale-node retry preserves a concurrently recreated atomic owner label', async (t) => {
  const stateComment = shepherdStateComment();
  let attached = true;
  let detachAttempts = 0;
  let repositoryLabelNodeId = 'LABEL_original';
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: { ...basePr(), labels: attached ? [{ name: LABEL }] : [] },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [stateComment],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      body: { name: LABEL, node_id: repositoryLabelNodeId },
    }),
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}`]: () => {
      detachAttempts += 1;
      if (detachAttempts === 2) {
        attached = false;
        repositoryLabelNodeId = 'LABEL_recreated';
      }
      return {
        status: 422,
        body: {
          message: 'Validation Failed',
          errors: [{ resource: 'Issue', field: 'labels', code: 'missing' }],
        },
      };
    },
  });
  t.after(() => server.close());

  const { code, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'lease-release',
    CI_RECOVERY_MODE: 'dry-run',
  });

  assert.notEqual(code, 0);
  assert.match(stderr, /owner label incarnation changed after stale-node retry/);
  assert.equal(detachAttempts, 2);
  assert.equal(
    mutatingCalls.some(
      (call) => call.method === 'DELETE' && call.url === `/repos/${OWNER}/${REPO}/labels/${LABEL}`,
    ),
    false,
  );
});

test('known stale-node first refetch preserves a concurrently recreated atomic owner label', async (t) => {
  const stateComment = shepherdStateComment();
  let attached = true;
  let repositoryLabelNodeId = 'LABEL_original';
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: { ...basePr(), labels: attached ? [{ name: LABEL }] : [] },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [stateComment],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      body: { name: LABEL, node_id: repositoryLabelNodeId },
    }),
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}`]: () => {
      attached = false;
      repositoryLabelNodeId = 'LABEL_recreated';
      return {
        status: 422,
        body: {
          message: 'Validation Failed',
          errors: [{ resource: 'Issue', field: 'labels', code: 'missing' }],
        },
      };
    },
  });
  t.after(() => server.close());

  const { code, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'lease-release',
    CI_RECOVERY_MODE: 'dry-run',
  });

  assert.notEqual(code, 0);
  assert.match(stderr, /owner label incarnation changed during stale-node release/);
  assert.equal(
    mutatingCalls.some(
      (call) => call.method === 'DELETE' && call.url === `/repos/${OWNER}/${REPO}/labels/${LABEL}`,
    ),
    false,
  );
  assert.equal(
    mutatingCalls.some(
      (call) => call.method === 'POST' && call.url === '/graphql' && call.body?.query,
    ),
    false,
  );
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

test('stale-node release fails closed when repository label is absent but state has a newer owner', async (t) => {
  // Regression for Threads 2/4: the !facts.repositoryLabelPresent branch in
  // the stale-node handler previously accepted a missing repository label as
  // sufficient convergence without checking the refetched state incarnation.
  // If another cleanup already removed the label AND advanced the state to a
  // newer owner, this path would overwrite the newer state with releasedState.
  const stateComment = shepherdStateComment();
  let detachAttempts = 0;
  let labelExistsCalls = 0;
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: { ...basePr(), labels: [{ name: LABEL }] },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [stateComment],
    }),
    // The first call (during normal flow) says the label exists so release()
    // attempts to remove it. The second call (inside fetchOwnershipFacts after
    // the 422) says the label is already gone — a concurrent cleanup removed it
    // and simultaneously advanced the state to a newer owner.
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => {
      labelExistsCalls += 1;
      if (labelExistsCalls > 1) {
        return { status: 404, body: { message: 'Not Found' } };
      }
      return { body: { name: LABEL } };
    },
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}`]: () => {
      detachAttempts += 1;
      // Advance the comment state to a *new* owner while the 422 is in flight,
      // simulating the concurrent cleanup that also removed the repo label.
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
    },
  });
  t.after(() => server.close());

  const { code, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'lease-release',
    CI_RECOVERY_MODE: 'dry-run',
    GITHUB_TOKEN: TOKEN,
  });

  // The release must fail closed: the newer state must NOT be overwritten.
  assert.notEqual(code, 0);
  assert.match(stderr, /ownership changed during stale-node release/);
  assert.equal(detachAttempts, 1);
  // fetchOwnershipFacts() queried the label endpoint (second call returned 404).
  assert.ok(labelExistsCalls >= 2, 'expected at least 2 label-exists calls');
  // No state-comment PATCH was attempted.
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
      // Loop incident routes (used only on attempt=2 / stale-automation-exhausted path).
      [`GET /repos/${OWNER}/${REPO}/issues`]: () => ({ body: [] }),
      [`POST /repos/${OWNER}/${REPO}/issues`]: () => ({
        body: { number: 999, node_id: 'ISSUE_999' },
      }),
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
      // Loop incident must NOT be filed on a normal retry (attempt=1).
      assert.equal(
        mutatingCalls.filter(
          (call) => call.method === 'POST' && call.url === `/repos/${OWNER}/${REPO}/issues`,
        ).length,
        0,
        'must not file a loop incident on a non-exhausted retry',
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
      // Loop incident must be filed on exhausted release (attempt=2).
      assert.match(
        stdout,
        /loop-incident pr=#42 issue=#999 action=created/,
        'must log loop-incident creation on stale-automation-exhausted release',
      );
      assert.equal(
        mutatingCalls.filter(
          (call) => call.method === 'POST' && call.url === `/repos/${OWNER}/${REPO}/issues`,
        ).length,
        1,
        'must create exactly one loop incident issue on exhausted release',
      );
    }
  });
}

test('stale-automation-exhausted in dry-run logs would-file message without creating an issue', async (t) => {
  const failedCheck = {
    id: 1,
    name: 'ci',
    status: 'completed',
    conclusion: 'failure',
    html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/1`,
  };
  const blockers = [
    { kind: 'ci-failure', id: 'ci', summary: 'ci concluded failure.', url: failedCheck.html_url },
  ];
  const fingerprint = blockerFingerprint(blockers);
  const staleAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  const stateComment = {
    id: 885,
    body: renderStateComment(
      makeState({
        prNumber: PR_NUM,
        headSha: HEAD_SHA,
        fingerprint,
        owner: 'automation',
        status: 'dispatched',
        blockers,
        attempt: 2,
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
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({ body: [stateComment] }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () =>
      repositoryLabelExists
        ? { body: { name: LABEL } }
        : { status: 404, body: { message: 'Not Found' } },
    [`PATCH /repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`]: (_url, body) => {
      stateComment.body = body.body;
      return { body: { id: stateComment.id, body: body.body } };
    },
    [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [failedCheck] },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'schedule:sweep',
    CI_RECOVERY_MODE: 'dry-run',
  });
  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;

  assert.match(
    stdout,
    /dry-run would-file-loop-incident pr=#42/,
    'dry-run must log the would-file message',
  );
  // No issue mutations in dry-run.
  assert.equal(
    mutatingCalls.filter(
      (call) => call.method === 'POST' && call.url === `/repos/${OWNER}/${REPO}/issues`,
    ).length,
    0,
    'dry-run must not create any loop incident issues',
  );
});

test('stale-automation-exhausted releases ownership even when incident filing fails', async (t) => {
  const failedCheck = {
    id: 1,
    name: 'ci',
    status: 'completed',
    conclusion: 'failure',
    html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/1`,
  };
  const blockers = [
    { kind: 'ci-failure', id: 'ci', summary: 'ci concluded failure.', url: failedCheck.html_url },
  ];
  const fingerprint = blockerFingerprint(blockers);
  const staleAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  const stateComment = {
    id: 886,
    body: renderStateComment(
      makeState({
        prNumber: PR_NUM,
        headSha: HEAD_SHA,
        fingerprint,
        owner: 'automation',
        status: 'dispatched',
        blockers,
        attempt: 2,
        progressKey: automationProgressKey(HEAD_SHA, fingerprint),
        progressAt: staleAt,
        updatedAt: staleAt,
      }),
    ),
  };
  let repositoryLabelExists = true;
  const { server, port } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: { ...basePr(), labels: [{ name: LABEL }] },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({ body: [stateComment] }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () =>
      repositoryLabelExists
        ? { body: { name: LABEL } }
        : { status: 404, body: { message: 'Not Found' } },
    [`DELETE /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => {
      repositoryLabelExists = false;
      return { status: 204, body: '' };
    },
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}`]: () => ({
      status: 204,
      body: '',
    }),
    [`PATCH /repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`]: (_url, body) => {
      stateComment.body = body.body;
      return { body: { id: stateComment.id, body: body.body } };
    },
    [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [failedCheck] },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
    // Loop incident label creation returns a non-422 error to simulate filing failure.
    [`POST /repos/${OWNER}/${REPO}/labels`]: () => ({
      status: 500,
      body: { message: 'Internal Server Error' },
    }),
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'schedule:sweep',
    CI_RECOVERY_MODE: 'live',
  });
  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;

  // Release must succeed even though filing failed.
  assert.match(stdout, /released stale automation pr=#42 attempts=2/);
  // Filing failure must be logged to stderr.
  assert.match(stderr, /loop-incident-filing-failed pr=#42/);

  const finalState = parseStateComment(stateComment.body);
  assert.equal(finalState.owner, 'none');
  assert.equal(finalState.status, 'idle');
  assert.equal(finalState.trigger, 'stale-automation-exhausted');
});

test('interrupted exhausted release completes when staleOwningState carries attempt>=2 with progressKey', async (t) => {
  // Regression for Thread 9: if the state-comment PATCH fails after
  // removePrLabel succeeds (label deleted but state not updated), the next
  // reconcile run sees the old automation state (attempt>=2) with no owner
  // label (staleOwningState=true).  Before this fix, labelExists=false caused
  // through to a fresh attempt-1 dispatch, silently resetting the exhausted
  // retry budget.  Now the staleOwningState handler detects this pattern and
  // writes the terminal idle state before exiting.
  const fingerprint = blockerFingerprint([
    { kind: 'ci-failure', id: 'ci:1', summary: 'CI failed' },
  ]);
  const progressKey = automationProgressKey(HEAD_SHA, fingerprint);
  const exhaustedState = makeState({
    prNumber: PR_NUM,
    headSha: HEAD_SHA,
    fingerprint,
    owner: 'automation',
    status: 'dispatched',
    blockers: [{ kind: 'ci-failure', id: 'ci:1', summary: 'CI failed' }],
    attempt: 2,
    progressKey,
    progressAt: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
  });
  const stateComment = { id: 900, body: renderStateComment(exhaustedState) };
  let finalStateBody = null;
  const { server, port, mutatingCalls } = await startServer({
    // No owner label on the repository (simulates interrupted label delete).
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      // No PR-level label either — the PR-label delete already completed.
      body: basePr(),
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [stateComment],
    }),
    [`PATCH /repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`]: (_url, body) => {
      finalStateBody = body.body;
      return { body: { id: stateComment.id } };
    },
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'schedule:sweep',
    CI_RECOVERY_MODE: 'live',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.match(stdout, /completed-interrupted-exhausted-release pr=#42/);
  assert.ok(finalStateBody !== null, 'state comment must be updated');
  const written = parseStateComment(finalStateBody);
  assert.equal(written.owner, 'none');
  assert.equal(written.status, 'idle');
  assert.equal(written.trigger, 'stale-automation-exhausted');
  assert.equal(written.attempt, 2);
  // Must NOT dispatch a new Copilot task.
  assert.equal(
    mutatingCalls.some(
      (call) =>
        call.method === 'POST' && call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`,
    ),
    false,
    'exhausted release must not dispatch a new agent task',
  );
});

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

test('post-state/pre-fence crash recovery preserves terminal waiting state and admission marker', async (t) => {
  // Scenario: a prior run wrote owner:none/status:waiting (terminal admission-wait state)
  // but crashed before removing the repository fence label.  The orphaned-cleanup path
  // must only delete the leftover fence, never overwrite the waiting state or remove
  // the durable WAITING_LABEL that keeps the PR out of the dispatch queue.
  const stateComment = waitingStateComment(995);
  let repositoryLabelDeleted = false;
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: { ...basePr(), labels: [{ name: WAITING_LABEL }] },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [stateComment],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () =>
      repositoryLabelDeleted
        ? { status: 404, body: { message: 'Not Found' } }
        : { body: { name: LABEL, node_id: 'LBL_orphan' } },
    [`DELETE /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => {
      repositoryLabelDeleted = true;
      return { body: {} };
    },
    [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [{ id: 1, name: 'ci', status: 'in_progress', conclusion: null }] },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
    [`PATCH /repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`]: () => ({
      body: { id: stateComment.id },
    }),
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

  // Fence-only cleanup logged; full release was NOT called.
  assert.match(stdout, /cleanup pr=#42 reason=orphaned-owner-label/);
  assert.match(stdout, /orphaned-fence-cleanup pr=#42 status=waiting/);

  // Repository fence was deleted.
  assert.ok(
    mutatingCalls.some(
      (call) => call.method === 'DELETE' && call.url === `/repos/${OWNER}/${REPO}/labels/${LABEL}`,
    ),
    'orphaned repository fence must be deleted',
  );

  // State comment must NOT have been PATCHed (waiting state preserved).
  assert.equal(
    mutatingCalls.some(
      (call) =>
        call.method === 'PATCH' &&
        call.url === `/repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`,
    ),
    false,
    'terminal waiting state must not be overwritten',
  );

  // WAITING_LABEL must NOT have been removed (admission marker preserved).
  assert.equal(
    mutatingCalls.some(
      (call) =>
        call.method === 'DELETE' &&
        call.url.includes(`/labels/${encodeURIComponent(WAITING_LABEL)}`),
    ),
    false,
    'durable waiting marker must not be removed during fence-only cleanup',
  );

  // Process continues to the normal waiting admission path.
  assert.match(stdout, /wait pr=#42 admission=ci/);
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
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels`]: () => ({ body: [] }),
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
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels`]: () => ({ body: [] }),
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
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels`]: () => ({ body: [] }),
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
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels`]: () => ({ body: [] }),
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
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels`]: () => ({ body: [] }),
    [`POST /repos/${OWNER}/${REPO}/labels`]: () => ({ body: { name: 'merge-train' } }),
    [`POST /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels`]: () => ({ body: {} }),
    [`POST /repos/${OWNER}/${REPO}/actions/workflows/ci-recovery-router.yml/dispatches`]: () => ({
      body: {},
    }),
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
        call.url === `/repos/${OWNER}/${REPO}/actions/workflows/ci-recovery-router.yml/dispatches`,
    ),
    false,
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
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels`]: () => ({ body: [] }),
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

test('live reconcile task comment includes explicit review-thread reply comment IDs', async (t) => {
  const reviewCommentId = '3606008324';
  const threadUrl = `https://github.com/${OWNER}/${REPO}/pull/${PR_NUM}#discussion_r${reviewCommentId}`;
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({ body: basePr() }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({ body: [] }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`POST /graphql`]: (_url, parsed) => {
      const query = String(parsed?.query ?? '');
      if (query.includes('suggestedActors')) {
        return {
          body: {
            data: {
              repository: { suggestedActors: { nodes: [{ id: 'BOT_copilot', login: 'copilot' }] } },
            },
          },
        };
      }
      if (query.includes('replaceActorsForAssignable')) {
        return {
          body: {
            data: {
              replaceActorsForAssignable: {
                assignable: { assignees: { nodes: [{ login: 'copilot' }] } },
              },
            },
          },
        };
      }
      return {
        body: gqlReviewThreads([
          {
            id: 'thread-review-target',
            isResolved: false,
            isOutdated: false,
            path: 'src/core/mob-abilities/runtime.ts',
            line: 93,
            comments: {
              nodes: [
                {
                  id: 'comment-review-target',
                  body: 'Please resolve in-thread.',
                  author: { login: 'copilot-pull-request-reviewer' },
                  authorAssociation: 'NONE',
                  url: threadUrl,
                },
              ],
            },
          },
        ]),
      };
    },
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
    CI_RECOVERY_MODE: 'live',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  const taskCommentCall = mutatingCalls.find(
    (call) =>
      call.method === 'POST' &&
      call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments` &&
      typeof call.body?.body === 'string' &&
      call.body.body.includes('crawler-ci-task:v1'),
  );
  assert.ok(taskCommentCall, 'expected live reconcile to post a recovery task comment');
  assert.ok(
    taskCommentCall.body.body.includes(`Reply target comment ID: \`${reviewCommentId}\``),
    'task comment should include the review-thread reply target comment ID',
  );
  assert.ok(
    taskCommentCall.body.body.includes(
      'A top-level PR comment is never sufficient for a review-thread blocker',
    ) && taskCommentCall.body.body.includes('exact thread comment listed above'),
    'task comment should explicitly reject top-level PR comments for review-thread blockers',
  );
});

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

test('live reconcile resolves only a trusted backtick-wrapped current-head marker', async (t) => {
  const trustedThreadId = 'thread-trusted-backtick';
  const untrustedThreadId = 'thread-untrusted-backtick';
  const malformedThreadId = 'thread-malformed-backtick';
  const headPrefix = HEAD_SHA.slice(0, 7);
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({ body: basePr() }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({ body: [] }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`POST /graphql`]: (_url, parsed) => {
      if (String(parsed?.query || '').includes('suggestedActors')) {
        return {
          body: {
            data: {
              repository: {
                suggestedActors: {
                  nodes: [{ id: 'BOT_copilot', login: 'copilot-swe-agent', __typename: 'Bot' }],
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
              resolveReviewThread: { thread: { isResolved: true } },
            },
          },
        };
      }
      return {
        body: gqlReviewThreads([
          {
            id: trustedThreadId,
            isResolved: false,
            comments: {
              nodes: [
                {
                  body: `✅ Addressed in \`${headPrefix}\`: fixed`,
                  authorAssociation: 'OWNER',
                  author: { login: 'dev' },
                },
              ],
            },
          },
          {
            id: untrustedThreadId,
            isResolved: false,
            comments: {
              nodes: [
                {
                  body: `✅ Addressed in \`${headPrefix}\`: untrusted`,
                  authorAssociation: 'NONE',
                  author: { login: 'drive-by' },
                },
              ],
            },
          },
          {
            id: malformedThreadId,
            isResolved: false,
            comments: {
              nodes: [
                {
                  body: `✅ Addressed in \`${headPrefix}: malformed`,
                  authorAssociation: 'MEMBER',
                  author: { login: 'reviewer' },
                },
              ],
            },
          },
        ]),
      };
    },
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [] },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
  });

  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    CI_RECOVERY_MODE: 'live',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  const resolutionMutations = mutatingCalls.filter(
    (call) =>
      call.method === 'GRAPHQL_MUTATION' &&
      String(call.body?.query || '').includes('resolveReviewThread'),
  );
  assert.equal(resolutionMutations.length, 1);
  assert.equal(resolutionMutations[0].body.variables.threadId, trustedThreadId);
  assert.match(stdout, new RegExp(`resolved thread=${trustedThreadId}`));
  assert.doesNotMatch(stdout, new RegExp(`resolved thread=${untrustedThreadId}`));
  assert.doesNotMatch(stdout, new RegExp(`resolved thread=${malformedThreadId}`));
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

// ---------------------------------------------------------------------------
// Queue admission must inspect every live label page before deciding whether
// the merge-train transition is absent.
// ---------------------------------------------------------------------------

test('queue admission finds a concurrently attached merge-train label on the second page', async (t) => {
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
        check_runs: [{ id: 1, name: 'ci', status: 'completed', conclusion: 'success' }],
      },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
    [`POST /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({ body: { id: 800 } }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels`]: (url) => {
      const page = new URL(url, 'http://localhost').searchParams.get('page');
      if (page === '2') {
        return { body: [{ name: 'merge-train' }] };
      }
      return {
        body: Array.from({ length: 100 }, (_, index) => ({ name: `other-${index}` })),
      };
    },
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    CI_RECOVERY_MODE: 'live',
    MERGE_TRAIN_ENABLED: 'true',
    MERGE_TRAIN_ADMISSION_CHECKS: 'ci',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.match(stdout, new RegExp(`queue unchanged merge-train pr=#${PR_NUM}`));
  assert.ok(
    !mutatingCalls.some(
      (call) =>
        call.method === 'POST' &&
        call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels` &&
        Array.isArray(call.body?.labels) &&
        call.body.labels.includes('merge-train'),
    ),
    'must not POST merge-train label after live re-fetch reveals it is already attached',
  );
});

// ---------------------------------------------------------------------------
// Thread 3 regression: automationStallAction 'progressed' resets attempt
// counter and uses 'blocker-progressed' release trigger.
// ---------------------------------------------------------------------------

test('progressed stale action resets attempt counter to zero and uses blocker-progressed release trigger', async (t) => {
  // Scenario: the PR was dispatched against an older head SHA ('old-head-sha')
  // with attempt=1. The head has since advanced to HEAD_SHA (e.g. a rebase) but
  // the blockers fingerprint is unchanged (same CI failure). automationStallAction
  // must return 'progressed', which triggers the Thread 3 fix:
  //   - dispatchAttemptBase reset to 0 (so the new head gets a full retry budget)
  //   - release trigger set to 'blocker-progressed' (not 'stale-automation-retry')
  //   - final attempt stored as 0+1=1 (not 2, which would exhaust the budget)
  const PROG_FINGERPRINT = blockerFingerprint([
    {
      kind: 'ci-failure',
      id: 'ci',
      summary: 'ci concluded failure.',
      url: `https://github.com/${OWNER}/${REPO}/actions/runs/1`,
    },
  ]);
  const OLD_HEAD = 'old000head000sha000000000000000000000000';
  const oldProgressKey = automationProgressKey(OLD_HEAD, PROG_FINGERPRINT);
  const stateComment = {
    id: 780,
    body: renderStateComment(
      makeState({
        prNumber: PR_NUM,
        headSha: OLD_HEAD,
        fingerprint: PROG_FINGERPRINT,
        owner: 'automation',
        status: 'dispatched',
        blockers: [
          {
            kind: 'ci-failure',
            id: 'ci',
            summary: 'ci concluded failure.',
            url: `https://github.com/${OWNER}/${REPO}/actions/runs/1`,
          },
        ],
        attempt: 1,
        progressKey: oldProgressKey,
        progressAt: new Date(Date.now() - 35 * 60 * 1000).toISOString(),
        updatedAt: new Date(Date.now() - 35 * 60 * 1000).toISOString(),
      }),
    ),
  };
  const ciFailure = {
    id: 1,
    name: 'ci',
    status: 'completed',
    conclusion: 'failure',
    html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/1`,
  };
  let repoLabelDeleted = false;
  const capturedPatches = [];
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: {
        ...basePr(),
        labels: [{ name: LABEL }],
      },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [stateComment],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () =>
      repoLabelDeleted
        ? { status: 404, body: { message: 'Not Found' } }
        : { body: { name: LABEL } },
    [`DELETE /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => {
      repoLabelDeleted = true;
      return { body: {} };
    },
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}`]: () => ({ body: {} }),
    [`PATCH /repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`]: (_url, body) => {
      capturedPatches.push(body);
      return { body: { id: stateComment.id } };
    },
    [`POST /repos/${OWNER}/${REPO}/labels`]: () => ({ body: { name: LABEL } }),
    [`POST /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels`]: () => ({ body: {} }),
    [`POST /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({ body: { id: 900 } }),
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
                assignable: { assignees: { nodes: [{ login: 'copilot' }] } },
              },
            },
          },
        };
      }
      return { body: gqlNoThreads() };
    },
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [ciFailure] },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'workflow_run:completed',
    CI_RECOVERY_MODE: 'live',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.match(stdout, /assigned copilot pr=#42/);

  // Must use 'blocker-progressed' release trigger, never 'stale-automation-retry'.
  const releasePatch = capturedPatches.find((patch) => {
    const parsed = parseStateComment(patch.body);
    return parsed?.trigger === 'blocker-progressed';
  });
  assert.ok(
    releasePatch,
    'the release state must carry trigger=blocker-progressed for a progressed head',
  );
  assert.ok(
    !mutatingCalls.some((call) => {
      if (call.method !== 'PATCH') return false;
      try {
        return parseStateComment(call.body?.body)?.trigger === 'stale-automation-retry';
      } catch {
        return false;
      }
    }),
    'must not use stale-automation-retry for a progressed head',
  );

  // Final dispatched state must carry attempt=1 (reset-to-0 then incremented),
  // not attempt=2 (which would carry forward the stale budget and exhaust it).
  const finalPatch = capturedPatches.at(-1);
  assert.ok(finalPatch, 'a final state PATCH must be issued');
  const finalState = parseStateComment(finalPatch.body);
  assert.equal(
    finalState?.attempt,
    1,
    'progressed dispatch must reset attempt budget: stored attempt must be 1 (0+1), not 2',
  );
  assert.equal(finalState?.trigger, 'workflow_run:completed');
  assert.equal(finalState?.owner, 'automation');
  assert.equal(finalState?.status, 'dispatched');
});

// ---------------------------------------------------------------------------
// RC-A regression: stale-node 422 + !repositoryLabelPresent + converged state
// (Threads 1, 2, 6 — PRRT_kwDOSvo2Ms6Rvxir / RvxjH / Rv6pp)
// ---------------------------------------------------------------------------

test('stale-node 422 with !repositoryLabelPresent + converged idle state exits clean without overwriting newer state', async (t) => {
  // The repo label is already gone when we fetch it post-422.  A concurrent run
  // has already written the PR to idle. The stale-node release path must NOT
  // overwrite that newer converged state with an older releasedState PATCH.
  const initialShepherdState = makeState({
    prNumber: PR_NUM,
    headSha: HEAD_SHA,
    fingerprint: blockerFingerprint([]),
    owner: 'shepherd',
    status: 'active',
    leaseId: LEASE_ID,
    blockers: [],
    updatedAt: '2026-07-17T12:00:00.000Z',
  });
  const fingerprint = blockerFingerprint([]);
  const stateComment = { id: 8801, body: renderStateComment(initialShepherdState) };
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
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}`]: () => {
      // Mark repo label as gone AND update state to concurrent-run's idle write,
      // simulating the race. fetchOwnershipFacts() will see both after this 422.
      repositoryLabelExists = false;
      stateComment.body = renderStateComment(
        makeState({
          prNumber: PR_NUM,
          headSha: HEAD_SHA,
          fingerprint,
          owner: 'none',
          status: 'idle',
          trigger: 'lease-release',
          blockers: [],
          updatedAt: new Date().toISOString(),
        }),
      );
      return {
        status: 422,
        body: {
          message: 'Validation Failed',
          errors: [{ resource: 'Issue', field: 'labels', code: 'missing' }],
        },
      };
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
  if (!assertSuccessfulExit(t, code, stderr, 'rc-a converged idle', true)) return;

  // Must not PATCH the state comment (that would overwrite the newer idle state).
  assert.equal(
    mutatingCalls.some(
      (call) =>
        call.method === 'PATCH' &&
        call.url === `/repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`,
    ),
    false,
    'must not overwrite newer converged idle state with releasedState PATCH',
  );
});

test('stale-node 422 with !repositoryLabelPresent + active different-owner state fails closed', async (t) => {
  // A different active shepherd lease was acquired after our first 422 attempt.
  // The label is already gone from the repository but the state now belongs to
  // a different run. We must fail closed rather than silently accepting the 422.
  const initialShepherdState = makeState({
    prNumber: PR_NUM,
    headSha: HEAD_SHA,
    fingerprint: blockerFingerprint([]),
    owner: 'shepherd',
    status: 'active',
    leaseId: LEASE_ID,
    blockers: [],
    updatedAt: '2026-07-17T12:00:00.000Z',
  });
  const stateComment = { id: 8802, body: renderStateComment(initialShepherdState) };
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
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}`]: () => {
      repositoryLabelExists = false;
      // State is now a DIFFERENT active shepherd (concurrent re-lease, not idle).
      stateComment.body = renderStateComment(
        makeState({
          prNumber: PR_NUM,
          headSha: HEAD_SHA,
          fingerprint: blockerFingerprint([]),
          owner: 'shepherd',
          status: 'active',
          leaseId: 'different-new-lease-id',
          blockers: [],
          updatedAt: new Date().toISOString(),
        }),
      );
      return {
        status: 422,
        body: {
          message: 'Validation Failed',
          errors: [{ resource: 'Issue', field: 'labels', code: 'missing' }],
        },
      };
    },
  });
  t.after(() => server.close());

  const { code, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'lease-release',
    CI_RECOVERY_MODE: 'dry-run',
  });

  assert.notEqual(code, 0, 'must fail closed when a different active owner is present');
  assert.match(stderr, /ownership changed during stale-node release/);
  assert.equal(
    mutatingCalls.some(
      (call) =>
        call.method === 'PATCH' &&
        call.url === `/repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`,
    ),
    false,
    'must not PATCH state when failing closed',
  );
});

// ---------------------------------------------------------------------------
// Threads 1-4 regressions: converged-elsewhere must stop callers and preserve
// waiting-state labels across both stale-node 422 branches.
// ---------------------------------------------------------------------------

test('duplicate stale-node convergence to waiting stops retry reacquire and keeps waiting label', async (t) => {
  const failedCheck = {
    id: 11,
    name: 'ci',
    status: 'completed',
    conclusion: 'failure',
    html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/11`,
  };
  const blockers = [
    { kind: 'ci-failure', id: 'ci', summary: 'ci concluded failure.', url: failedCheck.html_url },
  ];
  const fingerprint = blockerFingerprint(blockers);
  const staleAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  const staleAutomationState = makeState({
    prNumber: PR_NUM,
    headSha: HEAD_SHA,
    fingerprint,
    owner: 'automation',
    status: 'dispatched',
    blockers,
    attempt: 1,
    progressKey: automationProgressKey(HEAD_SHA, fingerprint),
    progressAt: staleAt,
    updatedAt: staleAt,
  });
  const concurrentWaiting = waitingStateComment(9003);
  const stateComment = { id: 9003, body: renderStateComment(staleAutomationState) };
  let repositoryLabelExists = true;
  let prLabels = [{ name: LABEL }, { name: WAITING_LABEL }];
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: { ...basePr(), labels: prLabels },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [stateComment],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () =>
      repositoryLabelExists
        ? { body: { name: LABEL } }
        : { status: 404, body: { message: 'Not Found' } },
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [failedCheck] },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
    [`POST /repos/${OWNER}/${REPO}/labels`]: (_url, body) => ({
      body: { name: body?.name || 'unknown' },
    }),
    [`POST /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels`]: (_url, body) => {
      for (const label of body?.labels || []) {
        if (!prLabels.some((entry) => entry.name === label)) {
          prLabels = [...prLabels, { name: label }];
        }
      }
      return { body: {} };
    },
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}`]: () => {
      repositoryLabelExists = false;
      prLabels = [{ name: WAITING_LABEL }, { name: WAITING_TRANSITION_LABEL }];
      stateComment.body = concurrentWaiting.body;
      return {
        status: 422,
        body: {
          message: 'Validation Failed',
          errors: [{ resource: 'Issue', field: 'labels', code: 'missing' }],
        },
      };
    },
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${WAITING_LABEL}`]: () => {
      prLabels = prLabels.filter((label) => label.name !== WAITING_LABEL);
      return { body: {} };
    },
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${WAITING_TRANSITION_LABEL}`]: () => {
      prLabels = prLabels.filter((label) => label.name !== WAITING_TRANSITION_LABEL);
      return { body: {} };
    },
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
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'schedule:sweep',
    CI_RECOVERY_MODE: 'live',
  });
  if (!assertSuccessfulExit(t, code, stderr, 'converged waiting retry', true)) return;

  assert.match(stdout, /reason=converged-elsewhere/);
  assert.equal(parseStateComment(stateComment.body)?.status, 'waiting');
  assert.equal(
    mutatingCalls.some(
      (call) =>
        call.method === 'POST' &&
        call.url === `/repos/${OWNER}/${REPO}/labels` &&
        call.body?.name === LABEL,
    ),
    false,
    'must not recreate the owner label after preserving a concurrent waiting state',
  );
  assert.equal(
    mutatingCalls.some(
      (call) =>
        call.method === 'POST' &&
        call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels` &&
        Array.isArray(call.body?.labels) &&
        call.body.labels.includes(LABEL),
    ),
    false,
    'must not reattach owner ownership after converging elsewhere',
  );
  assert.equal(
    mutatingCalls.some(
      (call) =>
        call.method === 'POST' && call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`,
    ),
    false,
    'must not post a new recovery task after converging elsewhere',
  );
  assert.equal(
    mutatingCalls.some(
      (call) =>
        call.method === 'PATCH' &&
        call.url === `/repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`,
    ),
    false,
    'must not overwrite the concurrent waiting state comment',
  );
  assert.equal(
    mutatingCalls.some(
      (call) =>
        call.method === 'DELETE' &&
        call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${WAITING_LABEL}`,
    ),
    false,
    'must not remove the preserved waiting label',
  );
  assert.equal(
    mutatingCalls.some(
      (call) =>
        call.method === 'DELETE' &&
        call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${WAITING_TRANSITION_LABEL}`,
    ),
    true,
    'must still clean up the transition marker we attached while preserving waiting',
  );
});

test('mirrored stale-node retry convergence to waiting stops merge-train queueing and keeps waiting label', async (t) => {
  const staleBlockers = [
    {
      kind: 'ci-failure',
      id: 'stale',
      summary: 'stale automation blocker',
      url: `https://github.com/${OWNER}/${REPO}/actions/runs/22`,
    },
  ];
  const staleAutomationState = makeState({
    prNumber: PR_NUM,
    headSha: HEAD_SHA,
    fingerprint: blockerFingerprint(staleBlockers),
    owner: 'automation',
    status: 'active',
    blockers: staleBlockers,
    updatedAt: '2026-07-17T12:00:00.000Z',
  });
  const stateComment = { id: 9004, body: renderStateComment(staleAutomationState) };
  const concurrentWaiting = waitingStateComment(9004);
  let repositoryLabelExists = true;
  let releaseAttempts = 0;
  let prLabels = [{ name: LABEL }, { name: WAITING_LABEL }];
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: { ...basePr(), labels: prLabels },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [stateComment],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () =>
      repositoryLabelExists
        ? { body: { name: LABEL } }
        : { status: 404, body: { message: 'Not Found' } },
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [] },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels`]: () => ({ body: prLabels }),
    [`POST /repos/${OWNER}/${REPO}/labels`]: (_url, body) => ({
      body: { name: body?.name || 'unknown' },
    }),
    [`POST /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels`]: (_url, body) => {
      for (const label of body?.labels || []) {
        if (!prLabels.some((entry) => entry.name === label)) {
          prLabels = [...prLabels, { name: label }];
        }
      }
      return { body: {} };
    },
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}`]: () => {
      releaseAttempts += 1;
      if (releaseAttempts === 2) {
        repositoryLabelExists = false;
        prLabels = [{ name: WAITING_LABEL }, { name: WAITING_TRANSITION_LABEL }];
        stateComment.body = concurrentWaiting.body;
      }
      return {
        status: 422,
        body: {
          message: 'Validation Failed',
          errors: [{ resource: 'Issue', field: 'labels', code: 'missing' }],
        },
      };
    },
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${WAITING_LABEL}`]: () => {
      prLabels = prLabels.filter((label) => label.name !== WAITING_LABEL);
      return { body: {} };
    },
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${WAITING_TRANSITION_LABEL}`]: () => {
      prLabels = prLabels.filter((label) => label.name !== WAITING_TRANSITION_LABEL);
      return { body: {} };
    },
    [`POST /graphql`]: () => ({ body: gqlNoThreads() }),
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'workflow_run:completed',
    CI_RECOVERY_MODE: 'live',
    MERGE_TRAIN_ENABLED: 'true',
  });
  if (!assertSuccessfulExit(t, code, stderr, 'converged waiting queue', true)) return;

  assert.match(stdout, /reason=converged-elsewhere/);
  assert.equal(releaseAttempts, 2, 'expected the mirrored stale-node retry path to run');
  assert.equal(
    mutatingCalls.some(
      (call) =>
        call.method === 'POST' &&
        call.url === `/repos/${OWNER}/${REPO}/labels` &&
        call.body?.name === QUEUE_LABEL,
    ),
    false,
    'must not create the merge-train queue label after preserving a concurrent waiting state',
  );
  assert.equal(
    mutatingCalls.some(
      (call) =>
        call.method === 'POST' &&
        call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels` &&
        Array.isArray(call.body?.labels) &&
        call.body.labels.includes(QUEUE_LABEL),
    ),
    false,
    'must not queue the PR after converging elsewhere',
  );
  assert.equal(
    mutatingCalls.some(
      (call) =>
        call.method === 'POST' &&
        call.url === `/repos/${OWNER}/${REPO}/actions/workflows/ci-recovery-router.yml/dispatches`,
    ),
    false,
    'must not dispatch an exact direct wake after preserving a concurrent waiting state',
  );
  assert.equal(
    mutatingCalls.some(
      (call) =>
        call.method === 'PATCH' &&
        call.url === `/repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`,
    ),
    false,
    'must not overwrite the concurrent waiting state comment',
  );
  assert.equal(
    mutatingCalls.some(
      (call) =>
        call.method === 'DELETE' &&
        call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${WAITING_LABEL}`,
    ),
    false,
    'must not remove the preserved waiting label in the mirrored branch',
  );
  assert.equal(
    mutatingCalls.some(
      (call) =>
        call.method === 'DELETE' &&
        call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${WAITING_TRANSITION_LABEL}`,
    ),
    true,
    'must still clear the transition marker in the mirrored branch',
  );
});

// ---------------------------------------------------------------------------
// Thread 9 regression: stale automation incomplete release
// (PRRT_kwDOSvo2Ms6RwLDt)
// ---------------------------------------------------------------------------

test('stale automation incomplete release at attempt=2 persists exhausted state and does not re-dispatch', async (t) => {
  // Simulate: previous run deleted the repo label but failed to write the idle
  // state. staleOwningState=true, owner=automation, attempt=2. The current run
  // must detect this, write the terminal idle state, and exit 0 without
  // dispatching a new Copilot task.
  const failedCheck = {
    id: 1,
    name: 'ci',
    status: 'completed',
    conclusion: 'failure',
    html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/1`,
  };
  const blockers = [
    { kind: 'ci-failure', id: 'ci', summary: 'ci concluded failure.', url: failedCheck.html_url },
  ];
  const fingerprint = blockerFingerprint(blockers);
  const staleAt = new Date(Date.now() - 5000).toISOString();
  const staleAutomationState = makeState({
    prNumber: PR_NUM,
    headSha: HEAD_SHA,
    fingerprint,
    owner: 'automation',
    status: 'dispatched',
    blockers,
    attempt: 2,
    progressKey: automationProgressKey(HEAD_SHA, fingerprint),
    progressAt: staleAt,
    updatedAt: staleAt,
  });
  const stateComment = { id: 8901, body: renderStateComment(staleAutomationState) };
  let repositoryLabelExists = false;
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: { ...basePr(), labels: [] }, // no owner label attached
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [stateComment],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () =>
      repositoryLabelExists
        ? { body: { name: LABEL } }
        : { status: 404, body: { message: 'Not Found' } },
    [`POST /repos/${OWNER}/${REPO}/labels`]: () => {
      repositoryLabelExists = true;
      return { body: { name: LABEL } };
    },
    [`DELETE /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => {
      repositoryLabelExists = false;
      return { body: {} };
    },
    [`PATCH /repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`]: (_url, body) => {
      stateComment.body = body.body;
      return { body: { id: stateComment.id, body: body.body } };
    },
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [failedCheck] },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
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
      return { body: gqlNoThreads() };
    },
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'schedule:sweep',
    CI_RECOVERY_MODE: 'live',
  });
  if (!assertSuccessfulExit(t, code, stderr, 'thread9 attempt=2', true)) return;

  // Must write an idle terminal state preserving attempt=2
  const finalState = parseStateComment(stateComment.body);
  assert.equal(finalState?.owner, 'none', 'must write owner=none terminal state');
  assert.equal(finalState?.status, 'idle', 'must write status=idle');
  assert.equal(finalState?.attempt, 2, 'must preserve the exhausted attempt=2 count');
  assert.match(stdout, /completed-interrupted-exhausted-release pr=#42 attempts=2/);

  // Must NOT dispatch a new Copilot task (no label creation or comment posting)
  assert.equal(
    mutatingCalls.some(
      (call) =>
        call.method === 'POST' && call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels`,
    ),
    false,
    'must not re-attach owner label for exhausted PR',
  );
  assert.equal(
    mutatingCalls.some(
      (call) =>
        call.method === 'POST' && call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`,
    ),
    false,
    'must not post a new task comment for exhausted PR',
  );
});

test('exhausted interrupted-release atomically fences ownership after its live refetch', async (t) => {
  // Regression: staleOwningState=true with owner=automation, progressKey set,
  // attempt=2 (exhausted). Between startup and the terminal idle updateState a
  // concurrent run re-creates the owner label (and writes an active state).
  // Before this fix the exhausted block had no live fence and would silently
  // overwrite the newer active state with idle. Now it must fail closed.
  const fingerprint = blockerFingerprint([
    { kind: 'ci-failure', id: 'ci:fence', summary: 'CI failed' },
  ]);
  const progressKey = automationProgressKey(HEAD_SHA, fingerprint);
  const exhaustedState = makeState({
    prNumber: PR_NUM,
    headSha: HEAD_SHA,
    fingerprint,
    owner: 'automation',
    status: 'dispatched',
    blockers: [{ kind: 'ci-failure', id: 'ci:fence', summary: 'CI failed' }],
    attempt: 2,
    progressKey,
    progressAt: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
  });
  const stateComment = { id: 9021, body: renderStateComment(exhaustedState) };
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: { ...basePr(), labels: [] }, // no owner label on PR
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [stateComment],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`POST /repos/${OWNER}/${REPO}/labels`]: () => {
      // A competing acquire wins after our live refetch but before our atomic
      // claim. GitHub's unique label name rejects our claim with 422.
      return {
        status: 422,
        body: {
          message: 'Validation Failed',
          errors: [{ resource: 'Label', field: 'name', code: 'already_exists' }],
        },
      };
    },
  });
  t.after(() => server.close());

  const { code, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'schedule:sweep',
    CI_RECOVERY_MODE: 'live',
  });

  assert.notEqual(
    code,
    0,
    'must fail closed when another acquire wins after the exhausted-release refetch',
  );
  assert.match(stderr, /owner label was claimed during exhausted interrupted-release completion/);
  assert.equal(
    mutatingCalls.some(
      (call) =>
        call.method === 'PATCH' &&
        call.url === `/repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`,
    ),
    false,
    'must not write idle state when exhausted-release live fence detected label re-creation',
  );
});

test('legacy stale automation incomplete release gets one retry despite its cumulative attempt count', async (t) => {
  const failedCheck = {
    id: 2,
    name: 'ci',
    status: 'completed',
    conclusion: 'failure',
    html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/2`,
  };
  const blockers = [
    { kind: 'ci-failure', id: 'ci', summary: 'ci concluded failure.', url: failedCheck.html_url },
  ];
  const fingerprint = blockerFingerprint(blockers);
  const staleAt = new Date(Date.now() - 5000).toISOString();
  const staleAutomationState = makeState({
    prNumber: PR_NUM,
    headSha: HEAD_SHA,
    fingerprint,
    owner: 'automation',
    status: 'dispatched',
    blockers,
    attempt: 5,
    progressAt: staleAt,
    updatedAt: staleAt,
  });
  const stateComment = { id: 8902, body: renderStateComment(staleAutomationState) };
  let repositoryLabelExists = false; // Already deleted by the previous run
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: { ...basePr(), labels: [] },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [stateComment],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () =>
      repositoryLabelExists
        ? { body: { name: LABEL } }
        : { status: 404, body: { message: 'Not Found' } },
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
      body: { id: 9902 },
    }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [failedCheck] },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
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
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'schedule:sweep',
    CI_RECOVERY_MODE: 'live',
  });
  if (!assertSuccessfulExit(t, code, stderr, 'legacy interrupted release', true)) return;

  assert.match(stdout, /resuming interrupted release pr=#42 attempt=5/);
  assert.match(stdout, /assigned copilot pr=#42/);

  const finalState = parseStateComment(stateComment.body);
  assert.equal(finalState?.owner, 'automation');
  assert.equal(finalState?.status, 'dispatched');
  assert.equal(
    finalState?.attempt,
    6,
    'the one compatible retry must preserve the legacy cumulative attempt count',
  );
});

// ---------------------------------------------------------------------------
// Thread PRRT_kwDOSvo2Ms6R14jx regressions: ownership fence + durable resume
// ---------------------------------------------------------------------------

test('interrupted-release live fence fails closed when label re-created before reacquire', async (t) => {
  // Regression: staleOwningState=true (automation/active, label absent at startup).
  // Between startup and the interrupted-release idle PATCH a concurrent run
  // re-creates the label. The live fence must detect this and fail closed before
  // the direct reacquire can overwrite the concurrent run's active state.
  const failedCheck = {
    id: 10,
    name: 'ci',
    status: 'completed',
    conclusion: 'failure',
    html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/10`,
  };
  const blockers = [
    { kind: 'ci-failure', id: 'ci', summary: 'ci concluded failure.', url: failedCheck.html_url },
  ];
  const fingerprint = blockerFingerprint(blockers);
  const staleAt = new Date(Date.now() - 5000).toISOString();
  const staleAutomationState = makeState({
    prNumber: PR_NUM,
    headSha: HEAD_SHA,
    fingerprint,
    owner: 'automation',
    status: 'dispatched',
    blockers,
    attempt: 1,
    progressKey: automationProgressKey(HEAD_SHA, fingerprint),
    progressAt: staleAt,
    updatedAt: staleAt,
  });
  const stateComment = { id: 8910, body: renderStateComment(staleAutomationState) };
  let labelEndpointCalls = 0;
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: { ...basePr(), labels: [] }, // no owner label attached
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [stateComment],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => {
      labelEndpointCalls += 1;
      // First call (startup): label absent — staleOwningState=true.
      // Second call onward (fetchOwnershipFacts in interrupted-release fence):
      // label re-created by a concurrent run — fence must fail closed.
      return labelEndpointCalls === 1
        ? { status: 404, body: { message: 'Not Found' } }
        : { body: { name: LABEL } };
    },
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [failedCheck] },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
    [`POST /graphql`]: (_url, body) => {
      const query = String(body?.query || '');
      if (query.includes('suggestedActors')) {
        return { body: { data: { repository: { suggestedActors: { nodes: [] } } } } };
      }
      return { body: gqlNoThreads() };
    },
  });
  t.after(() => server.close());

  const { code, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'schedule:sweep',
    CI_RECOVERY_MODE: 'live',
  });

  assert.notEqual(code, 0, 'must fail closed when label is re-created before reacquire');
  assert.match(stderr, /owner label re-created before interrupted-release reacquire/);
  assert.equal(
    mutatingCalls.some(
      (call) =>
        call.method === 'PATCH' &&
        call.url === `/repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`,
    ),
    false,
    'must not write state when interrupted-release fence detected label re-creation',
  );
});

test('interrupted automation release reacquires directly with its attempt budget preserved', async (t) => {
  // The atomic owner label disappeared while the owning state remained at
  // attempt=1. Resume directly through acquire() without an intermediate idle
  // PATCH, preserving the same-key attempt so the dispatch becomes attempt=2.
  const failedCheck = {
    id: 11,
    name: 'ci',
    status: 'completed',
    conclusion: 'failure',
    html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/11`,
  };
  const blockers = [
    { kind: 'ci-failure', id: 'ci', summary: 'ci concluded failure.', url: failedCheck.html_url },
  ];
  const fingerprint = blockerFingerprint(blockers);
  const interruptedReleaseState = makeState({
    prNumber: PR_NUM,
    headSha: HEAD_SHA,
    fingerprint,
    owner: 'automation',
    status: 'dispatched',
    blockers,
    attempt: 1,
    progressKey: automationProgressKey(HEAD_SHA, fingerprint),
    progressAt: new Date(Date.now() - 5000).toISOString(),
    updatedAt: new Date(Date.now() - 5000).toISOString(),
  });
  const stateComment = { id: 8911, body: renderStateComment(interruptedReleaseState) };
  let repositoryLabelExists = false;
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: { ...basePr(), labels: [] },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [stateComment],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () =>
      repositoryLabelExists
        ? { body: { name: LABEL } }
        : { status: 404, body: { message: 'Not Found' } },
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
      body: { id: 9911 },
    }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [failedCheck] },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
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
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'schedule:sweep',
    CI_RECOVERY_MODE: 'live',
  });
  if (!assertSuccessfulExit(t, code, stderr, 'interrupted-release carry-forward', true)) return;

  assert.match(stdout, /resuming interrupted release pr=#42 attempt=1/);
  assert.match(stdout, /assigned copilot pr=#42/);
  assert.equal(
    mutatingCalls.some((call) => {
      if (
        call.method !== 'PATCH' ||
        call.url !== `/repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`
      ) {
        return false;
      }
      return parseStateComment(call.body?.body)?.trigger === 'stale-automation-incomplete-release';
    }),
    false,
    'interrupted release must not write a resumability-breaking idle state',
  );

  const finalState = parseStateComment(stateComment.body);
  assert.equal(finalState?.owner, 'automation');
  assert.equal(finalState?.status, 'dispatched');
  assert.equal(
    finalState?.attempt,
    2,
    'interrupted release must dispatch with attempt=2, not a reset attempt=1',
  );
});

// ---------------------------------------------------------------------------
// Thread PRRT_kwDOSvo2Ms6R18LO regressions: !facts.attached TOCTOU
// ---------------------------------------------------------------------------

test('stale-node 422 !facts.attached fails closed while the repository owner label remains', async (t) => {
  const initialShepherdState = makeState({
    prNumber: PR_NUM,
    headSha: HEAD_SHA,
    fingerprint: blockerFingerprint([]),
    owner: 'shepherd',
    status: 'active',
    leaseId: LEASE_ID,
    blockers: [],
    updatedAt: '2026-07-17T14:00:00.000Z',
  });
  const stateComment = { id: 8912, body: renderStateComment(initialShepherdState) };
  let repositoryLabelPresent = true;
  let pullRequestCalls = 0;
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => {
      pullRequestCalls += 1;
      // Startup: label attached. fetchOwnershipFacts after 422: label detached.
      return pullRequestCalls <= 1
        ? { body: { ...basePr(), labels: [{ name: LABEL }] } }
        : { body: { ...basePr(), labels: [] } };
    },
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [stateComment],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () =>
      repositoryLabelPresent
        ? { body: { name: LABEL } }
        : { status: 404, body: { message: 'Not Found' } },
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}`]: () => {
      // 422 stale-node. Simultaneously, another run wrote the terminal idle
      // state (this is the converged-elsewhere scenario for !facts.attached).
      stateComment.body = renderStateComment(
        makeState({
          prNumber: PR_NUM,
          headSha: HEAD_SHA,
          fingerprint: blockerFingerprint([]),
          owner: 'none',
          status: 'idle',
          trigger: 'concurrent-converge',
          blockers: [],
          updatedAt: new Date().toISOString(),
        }),
      );
      return {
        status: 422,
        body: {
          message: 'Validation Failed',
          errors: [{ resource: 'Issue', field: 'labels', code: 'missing' }],
        },
      };
    },
    [`DELETE /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => {
      repositoryLabelPresent = false;
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

  assert.notEqual(code, 0);
  assert.match(stderr, /ownership changed during stale-node release/);
  assert.equal(repositoryLabelPresent, true);
  assert.equal(
    mutatingCalls.some(
      (call) =>
        call.method === 'PATCH' &&
        call.url === `/repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`,
    ),
    false,
    '!facts.attached must not overwrite newer idle state',
  );
});

test('stale-node 422 absent owner bit waits for the concurrent terminal state before writing', async (t) => {
  // Regression for Thread PRRT_kwDOSvo2Ms6R18LO: the first refetch sees the
  // repository owner label already absent while the concurrent releaser's state
  // PATCH is still in flight. The bounded handoff must refetch, observe the
  // terminal state, and preserve it instead of writing or reacquiring from the
  // stale ownership snapshot.
  const initialShepherdState = makeState({
    prNumber: PR_NUM,
    headSha: HEAD_SHA,
    fingerprint: blockerFingerprint([]),
    owner: 'shepherd',
    status: 'active',
    leaseId: LEASE_ID,
    blockers: [],
    updatedAt: '2026-07-17T14:01:00.000Z',
  });
  const stateComment = { id: 8913, body: renderStateComment(initialShepherdState) };
  let repoLabelPresent = true;
  let pullRequestCalls = 0;
  let commentCalls = 0;
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => {
      pullRequestCalls += 1;
      // Startup: label attached. fetchOwnershipFacts: label already detached.
      return pullRequestCalls <= 1
        ? { body: { ...basePr(), labels: [{ name: LABEL }] } }
        : { body: { ...basePr(), labels: [] } };
    },
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => {
      commentCalls += 1;
      if (commentCalls >= 3) {
        stateComment.body = renderStateComment(
          makeState({
            prNumber: PR_NUM,
            headSha: HEAD_SHA,
            fingerprint: blockerFingerprint([]),
            owner: 'none',
            status: 'idle',
            trigger: 'concurrent-release',
            blockers: [],
            updatedAt: new Date().toISOString(),
          }),
        );
      }
      return { body: [stateComment] };
    },
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () =>
      repoLabelPresent
        ? { body: { name: LABEL } }
        : { status: 404, body: { message: 'Not Found' } },
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}`]: () => {
      repoLabelPresent = false;
      return {
        status: 422,
        body: {
          message: 'Validation Failed',
          errors: [{ resource: 'Issue', field: 'labels', code: 'missing' }],
        },
      };
    },
    [`PATCH /repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`]: () => ({
      body: { id: stateComment.id, body: '' },
    }),
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'lease-release',
    CI_RECOVERY_MODE: 'dry-run',
  });
  if (!assertSuccessfulExit(t, code, stderr, 'absent-owner-bit-handoff', true)) return;

  assert.match(stdout, /reason=converged-elsewhere/);
  assert.equal(
    mutatingCalls.some(
      (call) =>
        call.method === 'PATCH' &&
        call.url === `/repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`,
    ),
    false,
    'bounded handoff must preserve the delayed concurrent terminal state',
  );
});

test('stale-node 422 absent owner bit fails closed when another run claims the handoff fence', async (t) => {
  const initialShepherdState = makeState({
    prNumber: PR_NUM,
    headSha: HEAD_SHA,
    fingerprint: blockerFingerprint([]),
    owner: 'shepherd',
    status: 'active',
    leaseId: LEASE_ID,
    blockers: [],
    updatedAt: '2026-07-17T14:02:00.000Z',
  });
  const stateComment = { id: 8914, body: renderStateComment(initialShepherdState) };
  let repositoryLabelPresent = true;
  let pullRequestCalls = 0;
  let commentCalls = 0;
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => {
      pullRequestCalls += 1;
      return pullRequestCalls === 1
        ? { body: { ...basePr(), labels: [{ name: LABEL }] } }
        : { body: { ...basePr(), labels: [] } };
    },
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => {
      commentCalls += 1;
      return { body: [stateComment] };
    },
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () =>
      repositoryLabelPresent
        ? { body: { name: LABEL } }
        : { status: 404, body: { message: 'Not Found' } },
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}`]: () => {
      repositoryLabelPresent = false;
      return {
        status: 422,
        body: {
          message: 'Validation Failed',
          errors: [{ resource: 'Issue', field: 'labels', code: 'missing' }],
        },
      };
    },
    [`POST /repos/${OWNER}/${REPO}/labels`]: () => ({
      status: 422,
      body: {
        message: 'Validation Failed',
        errors: [{ resource: 'Label', field: 'name', code: 'already_exists' }],
      },
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

  assert.notEqual(code, 0, 'a pending handoff must not acknowledge explicit lease release');
  assert.match(stderr, /owner label was claimed during release handoff completion/);
  assert.equal(commentCalls, 4, 'bounded handoff should perform exactly two follow-up refetches');
  assert.equal(
    mutatingCalls.some(
      (call) =>
        call.method === 'PATCH' &&
        call.url === `/repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`,
    ),
    false,
    'pending handoff must not overwrite the in-flight owner state',
  );
});

test('interrupted stale automation release resets the carried attempt when progressKey changed', async (t) => {
  const failedCheck = {
    id: 3,
    name: 'ci',
    status: 'completed',
    conclusion: 'failure',
    html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/3`,
  };
  const blockers = [
    { kind: 'ci-failure', id: 'ci', summary: 'ci concluded failure.', url: failedCheck.html_url },
  ];
  const fingerprint = blockerFingerprint(blockers);
  const staleAt = new Date(Date.now() - 5000).toISOString();
  const priorHead = 'fedcba9876543210fedcba9876543210fedcba98';
  const staleAutomationState = makeState({
    prNumber: PR_NUM,
    headSha: priorHead,
    fingerprint,
    owner: 'automation',
    status: 'dispatched',
    blockers,
    attempt: 1,
    progressKey: automationProgressKey(priorHead, fingerprint),
    progressAt: staleAt,
    updatedAt: staleAt,
  });
  const stateComment = { id: 8903, body: renderStateComment(staleAutomationState) };
  let repositoryLabelExists = false;
  const { server, port } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: { ...basePr(), labels: [] },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: [stateComment],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () =>
      repositoryLabelExists
        ? { body: { name: LABEL } }
        : { status: 404, body: { message: 'Not Found' } },
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
      body: { id: 9903 },
    }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [failedCheck] },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
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
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    RECOVERY_TRIGGER: 'schedule:sweep',
    CI_RECOVERY_MODE: 'live',
  });
  if (!assertSuccessfulExit(t, code, stderr, 'interrupted release progress reset', true)) return;

  assert.match(stdout, /resuming interrupted release pr=#42 attempt=0/);
  assert.match(stdout, /assigned copilot pr=#42/);

  const finalState = parseStateComment(stateComment.body);
  assert.equal(finalState?.owner, 'automation');
  assert.equal(finalState?.status, 'dispatched');
  assert.equal(finalState?.progressKey, automationProgressKey(HEAD_SHA, fingerprint));
  assert.equal(
    finalState?.attempt,
    1,
    'a changed progress key must reset the carried attempt so the new head gets a full retry budget',
  );
});

// ---------------------------------------------------------------------------
// Fix A regression: isConvergedElsewhereState must reject null (missing state)
// ---------------------------------------------------------------------------

test('null fetched state after owner bit disappears fails closed instead of treating as converged', async (t) => {
  // Regression: isConvergedElsewhereState previously returned true for null,
  // so a missing state comment (e.g. deleted by concurrent cleanup) after the
  // owner bit disappeared was silently accepted as convergence and the release
  // proceeded without a terminal idle/waiting record.  Null state is not
  // evidence another run converged — fail closed.
  const initialShepherdState = makeState({
    prNumber: PR_NUM,
    headSha: HEAD_SHA,
    fingerprint: blockerFingerprint([]),
    owner: 'shepherd',
    status: 'active',
    leaseId: LEASE_ID,
    blockers: [],
    updatedAt: '2026-07-17T15:00:00.000Z',
  });
  const stateComment = { id: 9100, body: renderStateComment(initialShepherdState) };
  let repositoryLabelPresent = true;
  const { server, port } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: { ...basePr(), labels: [{ name: LABEL }] },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      // After the 422, simulate the concurrent run deleting the state comment.
      body: repositoryLabelPresent ? [stateComment] : [],
    }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () =>
      repositoryLabelPresent
        ? { body: { name: LABEL } }
        : { status: 404, body: { message: 'Not Found' } },
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}`]: () => {
      // Concurrent cleanup removed the repository label and deleted the state comment.
      repositoryLabelPresent = false;
      return {
        status: 422,
        body: {
          message: 'Validation Failed',
          errors: [{ resource: 'Issue', field: 'labels', code: 'missing' }],
        },
      };
    },
  });
  t.after(() => server.close());

  const { code, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'lease-release',
    CI_RECOVERY_MODE: 'dry-run',
  });

  // Null state is not convergence evidence — must fail closed.
  assert.notEqual(code, 0, 'must fail closed when state is null after owner bit disappears');
  assert.match(stderr, /ownership changed during stale-node release/);
});

// ---------------------------------------------------------------------------
// Fix B regression: 404 from removePrLabel with expected attachment routes
// through handoff instead of writing terminal state over concurrent state.
// ---------------------------------------------------------------------------

test('concurrent PR-label detach (404) during release routes through handoff and preserves concurrent idle state', async (t) => {
  // Regression: removePrLabel() swallows 404. If a concurrent release already
  // detached the owner PR label before this run's DELETE, the 404 was silently
  // accepted as success and the ordinary path continued — writing an outdated
  // releasedState over the concurrent run's terminal state and potentially
  // deleting a newly recreated repository fence by name.  When the label was
  // expected to be attached (hasPrLabel), a 404 must route through handoff.
  const initialShepherdState = makeState({
    prNumber: PR_NUM,
    headSha: HEAD_SHA,
    fingerprint: blockerFingerprint([]),
    owner: 'shepherd',
    status: 'active',
    leaseId: LEASE_ID,
    blockers: [],
    updatedAt: '2026-07-17T15:01:00.000Z',
  });
  const stateComment = { id: 9101, body: renderStateComment(initialShepherdState) };
  let commentCallCount82 = 0;
  // Concurrent run has already written terminal idle state and removed the repository label.
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      // Startup: PR still shows label attached (stale cache before concurrent detach).
      body: { ...basePr(), labels: [{ name: LABEL }] },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => {
      commentCallCount82 += 1;
      if (commentCallCount82 > 1) {
        // fetchOwnershipFacts (call 2+) sees the concurrent run's already-written idle state.
        stateComment.body = renderStateComment(
          makeState({
            prNumber: PR_NUM,
            headSha: HEAD_SHA,
            fingerprint: blockerFingerprint([]),
            owner: 'none',
            status: 'idle',
            trigger: 'concurrent-lease-release',
            blockers: [],
            updatedAt: new Date().toISOString(),
          }),
        );
      }
      return { body: [stateComment] };
    },
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      // Repository label is already gone (concurrent run removed it).
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}`]: () => ({
      // Concurrent run already detached the PR label — return 404 (swallowed by removePrLabel).
      status: 404,
      body: { message: 'Label does not exist' },
    }),
    [`PATCH /repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`]: () => ({
      body: { id: stateComment.id, body: '' },
    }),
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'lease-release',
    CI_RECOVERY_MODE: 'live',
  });
  if (!assertSuccessfulExit(t, code, stderr, 'pr-label-detach-handoff', true)) return;

  // Must exit via converged-elsewhere, not write its own releasedState.
  assert.match(stdout, /reason=converged-elsewhere/);
  assert.equal(
    mutatingCalls.some(
      (call) =>
        call.method === 'PATCH' &&
        call.url === `/repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`,
    ),
    false,
    'must not overwrite the concurrent idle state with releasedState PATCH',
  );
});

// ---------------------------------------------------------------------------
// Fix C regression: completeReleaseHandoff converged-elsewhere branch holds
// the fence through waiting-label cleanup and deletes it last by node ID.
// ---------------------------------------------------------------------------

test('handoff converged-elsewhere holds fence through waiting-label cleanup before deleting by node ID', async (t) => {
  // Regression: completeReleaseHandoff dropped the claimed repository fence
  // (removeRepositoryLabel by name) before calling preserveConvergedElsewhereState,
  // which removes the WAITING_TRANSITION_LABEL.  A new reconcile could establish
  // a fresh waiting state in that gap, and this stale run could delete its
  // durable marker.  The fix calls preserveConvergedElsewhereState first (while
  // the fence is held) and then deletes the exact fence incarnation by node ID.
  const initialShepherdState = makeState({
    prNumber: PR_NUM,
    headSha: HEAD_SHA,
    fingerprint: blockerFingerprint([]),
    owner: 'shepherd',
    status: 'active',
    leaseId: LEASE_ID,
    blockers: [],
    updatedAt: '2026-07-17T15:02:00.000Z',
  });
  const concurrentWaitingState = makeState({
    prNumber: PR_NUM,
    headSha: HEAD_SHA,
    fingerprint: blockerFingerprint([]),
    owner: 'none',
    status: 'waiting',
    trigger: 'admission-wait',
    blockers: [],
    updatedAt: new Date().toISOString(),
  });
  const stateComment = { id: 9102, body: renderStateComment(initialShepherdState) };
  let repoLabelPresent = true;
  let commentCallCount = 0;
  let prLabels = [{ name: LABEL }, { name: WAITING_LABEL }, { name: WAITING_TRANSITION_LABEL }];
  const FENCE_NODE_ID = 'LBL_handoff_fence_9102';
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({
      body: { ...basePr(), labels: prLabels },
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => {
      commentCallCount += 1;
      // On the fifth+ fetch (inside completeReleaseHandoff after claimRepositoryLabelFence),
      // return the concurrent waiting state to trigger the converged-elsewhere branch.
      // Earlier calls (startup, fetchOwnershipFacts after 422, settleAbsentOwnerBit loop
      // iterations 1 and 2) must still return the matching shepherd state so that
      // settleAbsentOwnerBit returns RELEASE_HANDOFF_PENDING and reaches the fenced path.
      if (commentCallCount >= 5) {
        stateComment.body = renderStateComment(concurrentWaitingState);
      }
      return { body: [stateComment] };
    },
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () =>
      repoLabelPresent
        ? { body: { name: LABEL, node_id: FENCE_NODE_ID } }
        : { status: 404, body: { message: 'Not Found' } },
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${LABEL}`]: () => {
      // 422: stale node, kick into handoff path.
      repoLabelPresent = false;
      return {
        status: 422,
        body: {
          message: 'Validation Failed',
          errors: [{ resource: 'Issue', field: 'labels', code: 'missing' }],
        },
      };
    },
    [`POST /repos/${OWNER}/${REPO}/labels`]: (_url, body) => {
      // claimRepositoryLabelFence re-creates the repository label.
      repoLabelPresent = true;
      return { body: { name: body?.name || LABEL, node_id: FENCE_NODE_ID } };
    },
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${encodeURIComponent(WAITING_TRANSITION_LABEL)}`]:
      () => {
        prLabels = prLabels.filter((l) => l.name !== WAITING_TRANSITION_LABEL);
        return { body: {} };
      },
    [`DELETE /repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${encodeURIComponent(WAITING_LABEL)}`]:
      () => {
        prLabels = prLabels.filter((l) => l.name !== WAITING_LABEL);
        return { body: {} };
      },
    [`DELETE /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => {
      repoLabelPresent = false;
      return { body: {} };
    },
    [`POST /graphql`]: (_url, body) => {
      const query = String(body?.query || '').trimStart();
      if (query.startsWith('mutation') && query.includes('deleteLabel')) {
        repoLabelPresent = false;
        return { body: { data: { deleteLabel: { clientMutationId: null } } } };
      }
      return { body: gqlNoThreads() };
    },
    [`PATCH /repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`]: () => ({
      body: { id: stateComment.id, body: '' },
    }),
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'lease-release',
    CI_RECOVERY_MODE: 'live',
  });
  if (!assertSuccessfulExit(t, code, stderr, 'handoff-converged-elsewhere-fence', true)) return;

  assert.match(stdout, /reason=converged-elsewhere/);

  // WAITING_TRANSITION_LABEL must have been removed (waiting-label cleanup ran).
  assert.ok(
    mutatingCalls.some(
      (call) =>
        call.method === 'DELETE' &&
        call.url ===
          `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${encodeURIComponent(WAITING_TRANSITION_LABEL)}`,
    ),
    'WAITING_TRANSITION_LABEL must be cleaned up by preserveConvergedElsewhereState',
  );

  // WAITING_LABEL must NOT have been removed (concurrent durable waiting marker preserved).
  assert.equal(
    mutatingCalls.some(
      (call) =>
        call.method === 'DELETE' &&
        call.url ===
          `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/labels/${encodeURIComponent(WAITING_LABEL)}`,
    ),
    false,
    'durable WAITING_LABEL must not be removed during handoff converged-elsewhere cleanup',
  );

  // Fence must have been deleted via GraphQL deleteLabel (by node ID), not by REST name.
  assert.ok(
    mutatingCalls.some(
      (call) =>
        call.method === 'GRAPHQL_MUTATION' &&
        String(call.body?.variables?.labelId || '') === FENCE_NODE_ID,
    ),
    'fence must be deleted by exact node ID via GraphQL, not by name',
  );

  // No state comment PATCH (concurrent waiting state preserved).
  assert.equal(
    mutatingCalls.some(
      (call) =>
        call.method === 'PATCH' &&
        call.url === `/repos/${OWNER}/${REPO}/issues/comments/${stateComment.id}`,
    ),
    false,
    'concurrent waiting state must not be overwritten',
  );
});

// ---------------------------------------------------------------------------
// Stale-marker detection: thread has trusted ✅ Addressed marker but the SHA
// was never pushed (compare 404), so the thread remains unresolved.
// ---------------------------------------------------------------------------

test('stale-marker thread includes recovery hint in blocker summary', async (t) => {
  // Simulate the root cause from the PR #1266 loop incident:
  // The recovery agent replied to a review thread with ✅ Addressed in <sha>
  // but that commit was created locally and never pushed.  The compare API
  // returns 404, so the thread stays unresolved and the same fingerprint
  // repeats indefinitely.  The reconciler should detect the stale marker and
  // include a targeted hint in the blocker summary so the next recovery agent
  // knows to re-post the marker with the current-head SHA.
  const staleMarkerSha = 'dead0000aabbccddeeff00112233445566778899';
  const threadId = 'PRRT_stale_marker_thread';
  const originalConcern = 'reviewer: the CLI does not propagate the fifth score.';

  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({ body: basePr() }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({ body: [] }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`POST /graphql`]: (_url, body) => {
      const query = String(body?.query || '');
      if (query.includes('suggestedActors')) {
        return {
          body: {
            data: {
              repository: {
                suggestedActors: {
                  nodes: [{ id: 'BOT_copilot', login: 'copilot-swe-agent', __typename: 'Bot' }],
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
      return {
        body: gqlReviewThreads([
          {
            id: threadId,
            isResolved: false,
            isOutdated: true,
            path: 'scripts/sprites/cli.ts',
            line: 285,
            comments: {
              nodes: [
                {
                  id: 'PRIC_original',
                  body: 'the CLI does not propagate the fifth score.',
                  url: `https://github.com/${OWNER}/${REPO}/pull/${PR_NUM}#discussion_r1`,
                  authorAssociation: 'COLLABORATOR',
                  author: { login: 'reviewer' },
                },
                {
                  id: 'PRIC_stale_reply',
                  body: `✅ Addressed in \`${staleMarkerSha}\`: Added themeAdherence to the score vector.`,
                  authorAssociation: 'NONE',
                  author: { login: 'copilot-swe-agent[bot]' },
                },
              ],
            },
          },
        ]),
      };
    },
    // Stale SHA returns 404 — commit was never pushed to GitHub.
    [`GET /repos/${OWNER}/${REPO}/compare/${staleMarkerSha}...${HEAD_SHA}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [] },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
    [`POST /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: { id: 1001 },
    }),
  });

  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    CI_RECOVERY_MODE: 'live',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;

  // Thread must NOT be auto-resolved (stale SHA is not reachable).
  assert.doesNotMatch(stdout, new RegExp(`resolved thread=${threadId}`));

  // A task comment must be posted because there is still a blocker.
  const taskCommentCall = mutatingCalls.find(
    (call) =>
      call.method === 'POST' &&
      call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments` &&
      typeof call.body?.body === 'string' &&
      call.body.body.includes('crawler-ci-task'),
  );
  assert.ok(taskCommentCall, 'expected a task comment to be posted for the stale-marker blocker');

  // The task body must include the stale-marker annotation so the agent knows
  // to re-post the marker rather than re-investigate.
  assert.match(
    taskCommentCall.body.body,
    new RegExp(`Stale marker.*${staleMarkerSha}`, 'i'),
    'task body must identify the stale marker SHA',
  );
  assert.match(
    taskCommentCall.body.body,
    /verify fix is present.*reply to this thread/i,
    'task body must instruct the agent to verify and re-post the marker',
  );
});

test('transient compare failure does not produce a stale-marker hint (generic blocker preserved)', async (t) => {
  // When the compare API call fails with a transient/indeterminate error (e.g. 5xx,
  // rate limit, network error), the reconciler cannot determine whether the marker
  // SHA is truly stale.  It must NOT emit a stale-marker hint that would
  // incorrectly direct the recovery agent down the re-marker path.  The generic
  // review-thread blocker must still be emitted so recovery continues normally.
  const markerSha = 'beef0000aabbccddeeff00112233445566778899';
  const threadId = 'PRRT_transient_fail_thread';

  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUM}`]: () => ({ body: basePr() }),
    [`GET /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({ body: [] }),
    [`GET /repos/${OWNER}/${REPO}/labels/${LABEL}`]: () => ({
      status: 404,
      body: { message: 'Not Found' },
    }),
    [`POST /graphql`]: (_url, body) => {
      const query = String(body?.query || '');
      if (query.includes('suggestedActors')) {
        return {
          body: {
            data: {
              repository: {
                suggestedActors: {
                  nodes: [{ id: 'BOT_copilot', login: 'copilot-swe-agent', __typename: 'Bot' }],
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
      return {
        body: gqlReviewThreads([
          {
            id: threadId,
            isResolved: false,
            isOutdated: false,
            path: 'src/core/systems/damageSystem.ts',
            line: 42,
            comments: {
              nodes: [
                {
                  id: 'PRIC_original_transient',
                  body: 'reviewer: damage calculation does not account for armor.',
                  url: `https://github.com/${OWNER}/${REPO}/pull/${PR_NUM}#discussion_r2`,
                  authorAssociation: 'COLLABORATOR',
                  author: { login: 'reviewer' },
                },
                {
                  id: 'PRIC_marker_transient',
                  body: `✅ Addressed in \`${markerSha}\`: Armor factor applied before final damage.`,
                  authorAssociation: 'NONE',
                  author: { login: 'copilot-swe-agent[bot]' },
                },
              ],
            },
          },
        ]),
      };
    },
    // Compare call returns a transient server error — lineage is indeterminate.
    [`GET /repos/${OWNER}/${REPO}/compare/${markerSha}...${HEAD_SHA}`]: () => ({
      status: 500,
      body: { message: 'Internal Server Error' },
    }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [] },
    }),
    [`GET /repos/${OWNER}/${REPO}/actions/runs`]: () => ({ body: { workflow_runs: [] } }),
    [`POST /repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`]: () => ({
      body: { id: 1002 },
    }),
  });

  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, {
    RECOVERY_OPERATION: 'reconcile',
    CI_RECOVERY_MODE: 'live',
  });

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;

  // Thread must NOT be auto-resolved (lineage was indeterminate).
  assert.doesNotMatch(stdout, new RegExp(`resolved thread=${threadId}`));

  // A task comment must still be posted for the generic review-thread blocker.
  const taskCommentCall = mutatingCalls.find(
    (call) =>
      call.method === 'POST' &&
      call.url === `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments` &&
      typeof call.body?.body === 'string' &&
      call.body.body.includes('crawler-ci-task'),
  );
  assert.ok(taskCommentCall, 'expected a task comment to be posted for the review-thread blocker');

  // The stale-marker hint must NOT appear — the compare failed transiently, so
  // the SHA is indeterminate, not confirmed unreachable.
  assert.doesNotMatch(
    taskCommentCall.body.body,
    new RegExp(`Stale marker.*${markerSha}`, 'i'),
    'task body must NOT include a stale-marker hint when lineage check was transient/indeterminate',
  );
  assert.doesNotMatch(
    taskCommentCall.body.body,
    /verify fix is present.*reply to this thread/i,
    'task body must NOT include re-marker instructions when compare failed transiently',
  );
});
