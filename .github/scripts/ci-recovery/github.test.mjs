import assert from 'node:assert/strict';
import test from 'node:test';

import { listReviewThreads } from './github.mjs';

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
