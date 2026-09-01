import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import {
  CANARY_ALERT_LABEL,
  buildCanaryAlertBody,
  canaryAlertTitle,
  closeCanaryAlert,
  fileOrUpdateCanaryAlert,
} from './alert-lib.mjs';

const OWNER = 'test-owner';
const REPO = 'test-repo';

function startMockServer(routes) {
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

test('canaryAlertTitle is a fixed, stable string', () => {
  assert.equal(canaryAlertTitle(), 'Dev-build ingest canary: GitHub issue-filing check is failing');
});

test('buildCanaryAlertBody embeds error, timestamps, repetition count, and run url', () => {
  const body = buildCanaryAlertBody({
    errorMessage: 'HTTP 500: missing required configuration: CRAWLER_CI_PAT',
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-02T00:00:00.000Z',
    repetitionCount: 3,
    workflowRunUrl: 'https://github.com/nalfeo/Crawler/actions/runs/123',
  });
  assert.match(body, /First seen:\*\* 2026-01-01T00:00:00\.000Z/);
  assert.match(body, /Last seen:\*\* 2026-01-02T00:00:00\.000Z/);
  assert.match(body, /Repetition count:\*\* 3/);
  assert.match(body, /CRAWLER_CI_PAT/);
  assert.match(body, /actions\/runs\/123/);
});

test('fileOrUpdateCanaryAlert creates exactly one issue when none exists', async (t) => {
  const { server, port, mutatingCalls } = await startMockServer({
    ['POST /repos/' + OWNER + '/' + REPO + '/labels']: () => ({
      body: { name: CANARY_ALERT_LABEL },
    }),
    ['GET /repos/' + OWNER + '/' + REPO + '/issues']: () => ({ body: [] }),
    ['POST /repos/' + OWNER + '/' + REPO + '/issues']: () => ({ body: { number: 701 } }),
  });
  t.after(() => server.close());

  const result = await fileOrUpdateCanaryAlert({
    request: makeMockRequest(port),
    paginate: makeMockPaginate(port),
    token: 'test-token',
    owner: OWNER,
    repo: REPO,
    errorMessage: 'canary POST failed: HTTP 500',
    workflowRunUrl: null,
    now: new Date('2026-02-01T00:00:00.000Z'),
  });

  assert.deepEqual(result, { action: 'created', issueNumber: 701 });
  const issueCreations = mutatingCalls.filter(
    (call) => call.method === 'POST' && call.url.endsWith('/issues'),
  );
  assert.equal(issueCreations.length, 1);
  assert.equal(issueCreations[0].body.title, canaryAlertTitle());
  assert.deepEqual(issueCreations[0].body.labels, [CANARY_ALERT_LABEL]);
});

test('fileOrUpdateCanaryAlert updates the existing open alert instead of creating a duplicate', async (t) => {
  const existingBody = buildCanaryAlertBody({
    errorMessage: 'first failure',
    firstSeenAt: '2026-02-01T00:00:00.000Z',
    lastSeenAt: '2026-02-01T00:00:00.000Z',
    repetitionCount: 1,
    workflowRunUrl: null,
  });
  const { server, port, mutatingCalls } = await startMockServer({
    ['POST /repos/' + OWNER + '/' + REPO + '/labels']: () => ({
      status: 422,
      body: { message: 'exists' },
    }),
    ['GET /repos/' + OWNER + '/' + REPO + '/issues']: () => ({
      body: [{ number: 701, state: 'open', title: canaryAlertTitle(), body: existingBody }],
    }),
    ['PATCH /repos/' + OWNER + '/' + REPO + '/issues/701']: () => ({ body: { number: 701 } }),
    ['POST /repos/' + OWNER + '/' + REPO + '/issues']: () => ({ body: { number: 999 } }),
  });
  t.after(() => server.close());

  const result = await fileOrUpdateCanaryAlert({
    request: makeMockRequest(port),
    paginate: makeMockPaginate(port),
    token: 'test-token',
    owner: OWNER,
    repo: REPO,
    errorMessage: 'second failure',
    workflowRunUrl: null,
    now: new Date('2026-02-02T00:00:00.000Z'),
  });

  assert.deepEqual(result, { action: 'updated', issueNumber: 701 });
  const creations = mutatingCalls.filter(
    (call) => call.method === 'POST' && call.url.endsWith('/issues'),
  );
  assert.equal(creations.length, 0, 'must not create a duplicate alert issue');
  const patches = mutatingCalls.filter((call) => call.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.match(patches[0].body.body, /Repetition count:\*\* 2/);
  assert.match(patches[0].body.body, /second failure/);
});

test('fileOrUpdateCanaryAlert reopens a previously auto-closed alert instead of duplicating', async (t) => {
  const { server, port, mutatingCalls } = await startMockServer({
    ['POST /repos/' + OWNER + '/' + REPO + '/labels']: () => ({ body: {} }),
    ['GET /repos/' + OWNER + '/' + REPO + '/issues']: () => ({
      body: [
        {
          number: 701,
          state: 'closed',
          title: canaryAlertTitle(),
          body: buildCanaryAlertBody({
            errorMessage: 'old',
            firstSeenAt: '2026-01-01T00:00:00.000Z',
            lastSeenAt: '2026-01-01T00:00:00.000Z',
            repetitionCount: 1,
            workflowRunUrl: null,
          }),
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    }),
    ['PATCH /repos/' + OWNER + '/' + REPO + '/issues/701']: () => ({ body: { number: 701 } }),
  });
  t.after(() => server.close());

  const result = await fileOrUpdateCanaryAlert({
    request: makeMockRequest(port),
    paginate: makeMockPaginate(port),
    token: 'test-token',
    owner: OWNER,
    repo: REPO,
    errorMessage: 'recurred',
    now: new Date('2026-03-01T00:00:00.000Z'),
  });

  assert.deepEqual(result, { action: 'reopened', issueNumber: 701 });
  const patches = mutatingCalls.filter((call) => call.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.equal(patches[0].body.state, 'open');
});

test('closeCanaryAlert closes the open alert and comments', async (t) => {
  const { server, port, mutatingCalls } = await startMockServer({
    ['GET /repos/' + OWNER + '/' + REPO + '/issues']: () => ({
      body: [{ number: 701, state: 'open', title: canaryAlertTitle() }],
    }),
    ['PATCH /repos/' + OWNER + '/' + REPO + '/issues/701']: () => ({ body: { number: 701 } }),
    ['POST /repos/' + OWNER + '/' + REPO + '/issues/701/comments']: () => ({ body: { id: 1 } }),
  });
  t.after(() => server.close());

  const result = await closeCanaryAlert({
    request: makeMockRequest(port),
    paginate: makeMockPaginate(port),
    token: 'test-token',
    owner: OWNER,
    repo: REPO,
  });

  assert.deepEqual(result, { action: 'closed', issueNumber: 701 });
  const patches = mutatingCalls.filter((call) => call.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.equal(patches[0].body.state, 'closed');
  const comments = mutatingCalls.filter((call) => call.url.endsWith('/comments'));
  assert.equal(comments.length, 1);
});

test('closeCanaryAlert is a no-op when there is nothing open to close', async (t) => {
  const { server, port, mutatingCalls } = await startMockServer({
    ['GET /repos/' + OWNER + '/' + REPO + '/issues']: () => ({ body: [] }),
  });
  t.after(() => server.close());

  const result = await closeCanaryAlert({
    request: makeMockRequest(port),
    paginate: makeMockPaginate(port),
    token: 'test-token',
    owner: OWNER,
    repo: REPO,
  });

  assert.deepEqual(result, { action: 'not-found' });
  assert.equal(mutatingCalls.length, 0);
});
