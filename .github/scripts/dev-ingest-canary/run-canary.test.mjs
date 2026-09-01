import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { canaryAlertTitle } from './alert-lib.mjs';
import {
  CANARY_ISSUE_LABEL,
  buildCanaryPayload,
  parseIssueUrl,
  postCanaryRun,
  runCanary,
} from './run-canary.mjs';

const OWNER = 'nalfeo';
const REPO = 'Crawler';

function startGithubMock(routes) {
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

function makeMockRequest(port) {
  return async function mockRequest(_token, apiPath, opts) {
    const method = opts && opts.method ? opts.method.toUpperCase() : 'GET';
    const bodyStr = opts && opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const url = 'http://127.0.0.1:' + port + apiPath;
    const resp = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: '******' },
      body: bodyStr,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = new Error('HTTP ' + resp.status);
      err.status = resp.status;
      throw err;
    }
    return { data, status: resp.status };
  };
}

function makeMockPaginate(port) {
  return async function mockPaginate(_token, apiPath) {
    const url = 'http://127.0.0.1:' + port + apiPath;
    const resp = await fetch(url, { headers: { Authorization: '******' } });
    return await resp.json();
  };
}

test('buildCanaryPayload sets file_issue true and a distinguishing marker description', () => {
  const payload = buildCanaryPayload(new Date('2026-01-01T00:00:00.000Z'));
  assert.equal(payload.file_issue, true);
  assert.match(payload.issue_description, /canary/i);
  assert.equal(payload.meta.runId, 'canary-1767225600000');
  assert.equal(typeof payload.recorderJsonl, 'string');
  assert.ok(payload.runStats);
});

test('parseIssueUrl extracts owner/repo/issueNumber from a well-formed GitHub issue URL', () => {
  assert.deepEqual(parseIssueUrl('https://github.com/nalfeo/Crawler/issues/4034'), {
    owner: 'nalfeo',
    repo: 'Crawler',
    issueNumber: 4034,
  });
});

test('parseIssueUrl returns null for a malformed url', () => {
  assert.equal(parseIssueUrl('not-a-url'), null);
  assert.equal(parseIssueUrl('https://github.com/nalfeo/Crawler/pull/1'), null);
});

test('postCanaryRun resolves with issueUrl on HTTP 201', async () => {
  const fetchImpl = async () => ({
    status: 201,
    text: async () =>
      JSON.stringify({
        runId: 'canary-1',
        issueUrl: 'https://github.com/nalfeo/Crawler/issues/4034',
      }),
  });
  const result = await postCanaryRun({ fetchImpl, ingestUrl: 'https://example.invalid/runs' });
  assert.deepEqual(result, {
    runId: 'canary-1',
    issueUrl: 'https://github.com/nalfeo/Crawler/issues/4034',
  });
});

test('postCanaryRun throws a descriptive error on non-201 (e.g. missing credential)', async () => {
  const fetchImpl = async () => ({
    status: 500,
    text: async () => JSON.stringify({ error: 'missing required configuration: CRAWLER_CI_PAT' }),
  });
  await assert.rejects(
    () => postCanaryRun({ fetchImpl, ingestUrl: 'https://example.invalid/runs' }),
    /HTTP 500.*CRAWLER_CI_PAT/,
  );
});

test('postCanaryRun throws when HTTP 201 but no issueUrl is returned', async () => {
  const fetchImpl = async () => ({
    status: 201,
    text: async () => JSON.stringify({ runId: 'canary-1' }),
  });
  await assert.rejects(
    () => postCanaryRun({ fetchImpl, ingestUrl: 'https://example.invalid/runs' }),
    /did not file a GitHub issue/,
  );
});

test('runCanary: success path labels+closes the canary issue and clears any open alert', async (t) => {
  const { server, port, mutatingCalls } = await startGithubMock({
    ['POST /repos/' + OWNER + '/' + REPO + '/labels']: () => ({
      body: { name: CANARY_ISSUE_LABEL },
    }),
    ['PATCH /repos/' + OWNER + '/' + REPO + '/issues/4034']: () => ({ body: { number: 4034 } }),
    ['POST /repos/' + OWNER + '/' + REPO + '/issues/4034/comments']: () => ({ body: { id: 1 } }),
    ['GET /repos/' + OWNER + '/' + REPO + '/issues']: () => ({
      body: [{ number: 55, state: 'open', title: canaryAlertTitle() }],
    }),
    ['PATCH /repos/' + OWNER + '/' + REPO + '/issues/55']: () => ({ body: { number: 55 } }),
    ['POST /repos/' + OWNER + '/' + REPO + '/issues/55/comments']: () => ({ body: { id: 2 } }),
  });
  t.after(() => server.close());

  const fetchImpl = async () => ({
    status: 201,
    text: async () =>
      JSON.stringify({
        runId: 'canary-1',
        issueUrl: `https://github.com/${OWNER}/${REPO}/issues/4034`,
      }),
  });

  const result = await runCanary({
    fetchImpl,
    requestImpl: makeMockRequest(port),
    paginateImpl: makeMockPaginate(port),
    ingestUrl: 'https://example.invalid/runs',
    token: 'test-token',
    alertOwner: OWNER,
    alertRepo: REPO,
  });

  assert.equal(result.ok, true);
  assert.equal(result.issueUrl, `https://github.com/${OWNER}/${REPO}/issues/4034`);
  assert.equal(result.alertAction, 'closed');
  const canaryIssuePatch = mutatingCalls.find((c) => c.url === '/repos/nalfeo/Crawler/issues/4034');
  assert.deepEqual(canaryIssuePatch.body.labels, [CANARY_ISSUE_LABEL]);
  assert.equal(canaryIssuePatch.body.state, 'closed');
});

test('runCanary: failure path files an alert instead of throwing', async (t) => {
  const { server, port, mutatingCalls } = await startGithubMock({
    ['GET /repos/' + OWNER + '/' + REPO + '/issues']: () => ({ body: [] }),
    ['POST /repos/' + OWNER + '/' + REPO + '/labels']: () => ({ body: {} }),
    ['POST /repos/' + OWNER + '/' + REPO + '/issues']: () => ({ body: { number: 77 } }),
  });
  t.after(() => server.close());

  const fetchImpl = async () => ({
    status: 500,
    text: async () => JSON.stringify({ error: 'missing required configuration: CRAWLER_CI_PAT' }),
  });

  const result = await runCanary({
    fetchImpl,
    requestImpl: makeMockRequest(port),
    paginateImpl: makeMockPaginate(port),
    ingestUrl: 'https://example.invalid/runs',
    token: 'test-token',
    alertOwner: OWNER,
    alertRepo: REPO,
    workflowRunUrl: 'https://github.com/nalfeo/Crawler/actions/runs/1',
  });

  assert.equal(result.ok, false);
  assert.equal(result.credentialSuspected, true);
  assert.match(result.errorMessage, /CRAWLER_CI_PAT/);
  assert.equal(result.alertAction, 'created');
  assert.equal(result.alertIssueNumber, 77);
  const alertCreation = mutatingCalls.find(
    (c) => c.method === 'POST' && c.url === '/repos/nalfeo/Crawler/issues',
  );
  assert.equal(alertCreation.body.title, canaryAlertTitle());
});

test('runCanary: an issueUrl pointing at an unexpected repo is treated as a credential/config failure, not cleaned up', async (t) => {
  // Config drift (e.g. the live Function's GITHUB_REPOSITORY setting pointing
  // somewhere other than nalfeo/Crawler) must be caught before any attempt to
  // mutate the returned issue with GITHUB_TOKEN — that token is scoped to
  // alertOwner/alertRepo and has no business touching a foreign repo's issue.
  const { server, port, mutatingCalls } = await startGithubMock({
    ['GET /repos/' + OWNER + '/' + REPO + '/issues']: () => ({ body: [] }),
    ['POST /repos/' + OWNER + '/' + REPO + '/labels']: () => ({ body: {} }),
    ['POST /repos/' + OWNER + '/' + REPO + '/issues']: () => ({ body: { number: 88 } }),
    // Deliberately no route for other-owner/other-repo — if the code under
    // test tried to call it, the mock's fallback 200 would hide the bug, so
    // we instead assert directly on `mutatingCalls` below that no such call
    // was ever made.
  });
  t.after(() => server.close());

  const fetchImpl = async () => ({
    status: 201,
    text: async () =>
      JSON.stringify({
        runId: 'canary-1',
        issueUrl: 'https://github.com/other-owner/other-repo/issues/1',
      }),
  });

  const result = await runCanary({
    fetchImpl,
    requestImpl: makeMockRequest(port),
    paginateImpl: makeMockPaginate(port),
    ingestUrl: 'https://example.invalid/runs',
    token: 'test-token',
    alertOwner: OWNER,
    alertRepo: REPO,
    workflowRunUrl: 'https://github.com/nalfeo/Crawler/actions/runs/1',
  });

  assert.equal(result.ok, false);
  assert.equal(result.credentialSuspected, true);
  assert.match(result.errorMessage, /other-owner\/other-repo/);
  assert.match(result.errorMessage, /GITHUB_REPOSITORY/);
  assert.equal(result.alertAction, 'created');
  assert.equal(result.alertIssueNumber, 88);
  const foreignRepoCall = mutatingCalls.find((c) => c.url.includes('other-owner/other-repo'));
  assert.equal(
    foreignRepoCall,
    undefined,
    'must never attempt to mutate an issue in an unexpected repo',
  );
});

test('runCanary: a cleanup-step failure after a successful issue filing does NOT file a credential alert', async (t) => {
  // The /runs POST succeeds (proving CRAWLER_CI_PAT is healthy), but the
  // canary's own label-creation call (using GITHUB_TOKEN) fails with a
  // non-422 error. This must NOT be reported as a broken credential, and
  // must NOT create/update the deduplicated "credential broken" alert issue
  // — doing so would misdiagnose a healthy credential based on an unrelated
  // GitHub API hiccup.
  const { server, port, mutatingCalls } = await startGithubMock({
    ['POST /repos/' + OWNER + '/' + REPO + '/labels']: () => ({
      status: 503,
      body: { message: 'label service unavailable' },
    }),
  });
  t.after(() => server.close());

  const fetchImpl = async () => ({
    status: 201,
    text: async () =>
      JSON.stringify({
        runId: 'canary-1',
        issueUrl: `https://github.com/${OWNER}/${REPO}/issues/4034`,
      }),
  });

  const result = await runCanary({
    fetchImpl,
    requestImpl: makeMockRequest(port),
    paginateImpl: makeMockPaginate(port),
    ingestUrl: 'https://example.invalid/runs',
    token: 'test-token',
    alertOwner: OWNER,
    alertRepo: REPO,
  });

  assert.equal(result.ok, false);
  assert.equal(result.credentialSuspected, false);
  assert.equal(result.issueUrl, `https://github.com/${OWNER}/${REPO}/issues/4034`);
  const alertCreation = mutatingCalls.find(
    (c) => c.method === 'POST' && c.url === '/repos/nalfeo/Crawler/issues',
  );
  assert.equal(
    alertCreation,
    undefined,
    'no alert issue should be created for a cleanup-only failure',
  );
});
