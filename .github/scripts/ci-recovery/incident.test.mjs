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

test('does not auto-close an open incident on a train-fast-path (docs_only) push success', async (t) => {
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/issues`]: () => ({ body: [OPEN_INCIDENT] }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [trustedTrainCheck()] },
    }),
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, pushRun());

  if (!assertSuccessfulExit(t, code, stderr, '', true)) return;
  assert.match(stdout, /skip auto-close .*reason=train-fast-path-success/);
  assert.deepEqual(mutatingCalls, [], 'must not PATCH/close the incident issue');
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

test('routes a genuine push failure to a new/updated incident even with an unrelated trusted train check present', async (t) => {
  const { server, port, mutatingCalls } = await startServer({
    [`GET /repos/${OWNER}/${REPO}/issues`]: () => ({ body: [] }),
    [`GET /repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`]: () => ({
      body: { check_runs: [trustedTrainCheck()] },
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
  assert.ok(
    mutatingCalls.some(
      (call) => call.method === 'POST' && call.url === `/repos/${OWNER}/${REPO}/issues`,
    ),
    'expected a new incident issue to be created for the genuine failure',
  );
});
