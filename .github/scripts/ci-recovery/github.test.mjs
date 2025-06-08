import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { listReviewThreads } from './github.mjs';

const MODULE_URL = new URL('./github.mjs', import.meta.url).href;
let importCounter = 0;

function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

async function importRequestWithApiBase(port) {
  process.env.GITHUB_API_URL = `http://127.0.0.1:${port}`;
  process.env.GITHUB_GRAPHQL_URL = `http://127.0.0.1:${port}/graphql`;
  importCounter += 1;
  return import(`${MODULE_URL}?t=${importCounter}`);
}

test('paginates review threads and review history with independent cursors', async () => {
  const calls = [];
  const graphql = async (_token, _query, variables) => {
    calls.push(variables);
    if (calls.length === 1) {
      return {
        repository: {
          pullRequest: {
            id: 'PR_42',
            assignees: { nodes: [] },
            reviewThreads: {
              pageInfo: { hasNextPage: true, endCursor: 'THREAD_1' },
              nodes: [{ id: 'THREAD_A' }],
            },
            reviews: {
              pageInfo: { hasNextPage: true, endCursor: 'REVIEW_1' },
              nodes: [{ id: 'REVIEW_A' }],
            },
          },
        },
      };
    }
    return {
      repository: {
        pullRequest: {
          id: 'PR_42',
          assignees: { nodes: [] },
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ id: 'THREAD_B' }],
          },
          reviews: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ id: 'REVIEW_B' }],
          },
        },
      },
    };
  };

  const result = await listReviewThreads('token', 'nalfeo', 'Crawler', 42, graphql);

  assert.deepEqual(
    result.threads.map(({ id }) => id),
    ['THREAD_A', 'THREAD_B'],
  );
  assert.deepEqual(
    result.reviews.map(({ id }) => id),
    ['REVIEW_A', 'REVIEW_B'],
  );
  assert.deepEqual(calls[1], {
    owner: 'nalfeo',
    repo: 'Crawler',
    number: 42,
    threadCursor: 'THREAD_1',
    reviewCursor: 'REVIEW_1',
    includeThreads: true,
    includeReviews: true,
  });
});

test('request preserves HTTP status/details when GitHub returns a non-JSON error page', async (t) => {
  const { server, port } = await startServer((req, res) => {
    if (req.url === '/repos/test-owner/test-repo/pulls/42') {
      res.writeHead(502, { 'Content-Type': 'text/html' });
      res.end('<!DOCTYPE html><html><body>temporary upstream failure</body></html>');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  t.after(() => server.close());

  const { request: requestFromFreshImport } = await importRequestWithApiBase(port);

  await assert.rejects(
    () => requestFromFreshImport('token', '/repos/test-owner/test-repo/pulls/42'),
    (error) => {
      assert.equal(error.status, 502);
      assert.match(error.message, /failed \(502\)/);
      assert.match(error.message, /temporary upstream failure/);
      assert.equal(typeof error.body, 'string');
      assert.match(error.body, /<!DOCTYPE html>/);
      return true;
    },
  );
});

test('request rejects a non-JSON success body instead of returning null data', async (t) => {
  const { server, port } = await startServer((req, res) => {
    if (req.url === '/repos/test-owner/test-repo/pulls/42') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!DOCTYPE html><html><body>unexpected success page</body></html>');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  t.after(() => server.close());

  const { request: requestFromFreshImport } = await importRequestWithApiBase(port);

  await assert.rejects(
    () => requestFromFreshImport('token', '/repos/test-owner/test-repo/pulls/42'),
    (error) => {
      assert.equal(error.status, 200);
      assert.match(error.message, /returned non-JSON success \(200\)/);
      assert.match(error.message, /unexpected success page/);
      return true;
    },
  );
});
