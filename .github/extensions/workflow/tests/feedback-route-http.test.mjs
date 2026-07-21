/**
 * Real-HTTP integration test for the `/api/feedback` route's full guard chain
 * (token + origin + content-type) plus persistence semantics, exercised
 * through a REAL `node:http` server + REAL client connections — not just the
 * source-text regex assertions in `extension-security-guards.test.mjs`.
 *
 * The route handler here is a byte-for-byte port of extension.mjs's
 * `/api/feedback` handler (same shared modules, same guard order, same status
 * codes) so a regression in the real route would show up here too; it can't
 * import `extension.mjs` directly because that file performs a top-level
 * `joinSession()` SDK side effect on import.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, before, after } from 'node:test';

import { saveFeedback } from '../../shared/sprite-feedback-store.mjs';
import {
  isJsonContentType,
  isTrustedMutationOrigin,
  readJsonBody,
  tokensMatch,
} from '../../shared/sprite-feedback-request.mjs';

const MUTATION_TOKEN = 'test-mutation-token';

function startServer(feedbackPath) {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/feedback') {
      res.writeHead(404);
      res.end();
      return;
    }
    const entry = {
      url: `http://127.0.0.1:${server.address().port}/`,
      mutationToken: MUTATION_TOKEN,
    };
    if (!isTrustedMutationOrigin(req, entry)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden-origin' }));
      return;
    }
    if (!tokensMatch(req.headers['x-workflow-mutation-token'], entry.mutationToken)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden', message: 'Invalid mutation token.' }));
      return;
    }
    if (!isJsonContentType(req)) {
      res.writeHead(415, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unsupported-media-type' }));
      return;
    }
    readJsonBody(req)
      .then((payload) => {
        let feedback;
        try {
          feedback = saveFeedback(feedbackPath, payload);
        } catch (error) {
          if (error?.code === 'invalid-feedback') {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'bad-request', message: error.message }));
            return;
          }
          throw error;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ feedback }));
      })
      .catch((error) => {
        const tooLarge = error?.code === 'body-too-large';
        res.writeHead(tooLarge ? 413 : 400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: tooLarge ? 'body-too-large' : 'bad-request',
            message: tooLarge ? error.message : 'Feedback payload must be valid JSON.',
          }),
        );
      });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function post(url, body, headers) {
  return fetch(url, { method: 'POST', headers, body }).then(async (response) => ({
    status: response.status,
    json: await response.json(),
  }));
}

let root;
let feedbackPath;
let server;
let url;

before(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'workflow-feedback-route-'));
  feedbackPath = path.join(root, 'sprite-review-feedback.json');
  server = await startServer(feedbackPath);
  url = `http://127.0.0.1:${server.address().port}/api/feedback`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
});

test('a request with no Origin header is rejected as forbidden-origin', async () => {
  const result = await post(
    url,
    JSON.stringify({
      briefId: 'b',
      runId: 'r',
      variantIndex: 0,
      kind: 'judge',
      criterion: 'x',
      verdict: 'up',
    }),
    { 'content-type': 'application/json', 'x-workflow-mutation-token': MUTATION_TOKEN },
  );
  assert.equal(result.status, 403);
  assert.equal(result.json.error, 'forbidden-origin');
});

test('a request with a mismatched mutation token is rejected as forbidden', async () => {
  const result = await post(
    url,
    JSON.stringify({
      briefId: 'b',
      runId: 'r',
      variantIndex: 0,
      kind: 'judge',
      criterion: 'x',
      verdict: 'up',
    }),
    {
      'content-type': 'application/json',
      origin: new URL(url).origin,
      'x-workflow-mutation-token': 'wrong-token',
    },
  );
  assert.equal(result.status, 403);
  assert.equal(result.json.error, 'forbidden');
});

test('a non-JSON content-type is rejected as unsupported-media-type', async () => {
  const result = await post(url, 'plain text', {
    'content-type': 'text/plain',
    origin: new URL(url).origin,
    'x-workflow-mutation-token': MUTATION_TOKEN,
  });
  assert.equal(result.status, 415);
  assert.equal(result.json.error, 'unsupported-media-type');
});

test('a fully-authorized request persists feedback, and reload shows only the confirmed value', async () => {
  const result = await post(
    url,
    JSON.stringify({
      briefId: 'goblin',
      runId: 'run-1',
      variantIndex: 2,
      kind: 'judge',
      criterion: 'readability',
      verdict: 'up',
      comment: 'Looks great',
    }),
    {
      'content-type': 'application/json',
      origin: new URL(url).origin,
      'x-workflow-mutation-token': MUTATION_TOKEN,
    },
  );
  assert.equal(result.status, 200);
  assert.equal(result.json.feedback.verdict, 'up');
  assert.equal(result.json.feedback.comment, 'Looks great');

  const onDisk = JSON.parse(readFileSync(feedbackPath, 'utf8'));
  const entries = Object.values(onDisk.entries);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].comment, 'Looks great');
});

test('confirming a deselected thumb with an empty comment deletes the persisted entry', async () => {
  // First persist a real entry...
  await post(
    url,
    JSON.stringify({
      briefId: 'goblin',
      runId: 'run-2',
      variantIndex: 0,
      kind: 'sensor',
      criterion: 'palette',
      verdict: 'down',
      comment: 'False positive',
    }),
    {
      'content-type': 'application/json',
      origin: new URL(url).origin,
      'x-workflow-mutation-token': MUTATION_TOKEN,
    },
  );
  // ...then confirm a deselected thumb (verdict: null) with an empty comment —
  // this is exactly what the renderer sends when a criterion's draft thumb is
  // deselected (the comment box hides and its draft value is cleared too).
  const result = await post(
    url,
    JSON.stringify({
      briefId: 'goblin',
      runId: 'run-2',
      variantIndex: 0,
      kind: 'sensor',
      criterion: 'palette',
      verdict: null,
      comment: '',
    }),
    {
      'content-type': 'application/json',
      origin: new URL(url).origin,
      'x-workflow-mutation-token': MUTATION_TOKEN,
    },
  );
  assert.equal(result.status, 200);
  assert.equal(result.json.feedback, null);

  const onDisk = JSON.parse(readFileSync(feedbackPath, 'utf8'));
  const stillHasGoblinRun2 = Object.values(onDisk.entries).some(
    (e) => e.briefId === 'goblin' && e.runId === 'run-2',
  );
  assert.equal(stillHasGoblinRun2, false, 'the deleted entry must not survive on disk');
});

test('an invalid payload (missing required fields) is a 400 bad-request', async () => {
  const result = await post(url, JSON.stringify({ briefId: 'goblin' }), {
    'content-type': 'application/json',
    origin: new URL(url).origin,
    'x-workflow-mutation-token': MUTATION_TOKEN,
  });
  assert.equal(result.status, 400);
  assert.equal(result.json.error, 'bad-request');
});

// ---- subjectType: sheet | brief (discriminated union, same route/store) ---

test('a subjectType:"sheet" payload persists sheet-level feedback, distinct from criterion feedback', async () => {
  const result = await post(
    url,
    JSON.stringify({
      subjectType: 'sheet',
      briefId: 'goblin',
      runId: 'run-sheet-1',
      sheet: 'sheet-01.png',
      verdict: 'up',
      comment: 'Great composition',
    }),
    {
      'content-type': 'application/json',
      origin: new URL(url).origin,
      'x-workflow-mutation-token': MUTATION_TOKEN,
    },
  );
  assert.equal(result.status, 200);
  assert.equal(result.json.feedback.subjectType, 'sheet');
  assert.equal(result.json.feedback.sheet, 'sheet-01.png');
  assert.equal(result.json.feedback.verdict, 'up');
});

test('a subjectType:"brief" payload persists brief-level feedback, keyed by briefId+runId only', async () => {
  const result = await post(
    url,
    JSON.stringify({
      subjectType: 'brief',
      briefId: 'goblin',
      runId: 'run-brief-1',
      verdict: 'down',
      comment: 'Brief is too vague',
    }),
    {
      'content-type': 'application/json',
      origin: new URL(url).origin,
      'x-workflow-mutation-token': MUTATION_TOKEN,
    },
  );
  assert.equal(result.status, 200);
  assert.equal(result.json.feedback.subjectType, 'brief');
  assert.equal(result.json.feedback.verdict, 'down');
  assert.equal(result.json.feedback.variantIndex, undefined);
});

test('a sheet feedback payload missing "sheet" is a 400 bad-request', async () => {
  const result = await post(
    url,
    JSON.stringify({
      subjectType: 'sheet',
      briefId: 'goblin',
      runId: 'run-sheet-2',
      verdict: 'up',
    }),
    {
      'content-type': 'application/json',
      origin: new URL(url).origin,
      'x-workflow-mutation-token': MUTATION_TOKEN,
    },
  );
  assert.equal(result.status, 400);
  assert.equal(result.json.error, 'bad-request');
});
