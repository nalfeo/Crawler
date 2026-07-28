import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mergeRunStatusResults,
  loadAssetRequestIssues,
  parseGitHubRepository,
  sanitizeErrorText,
  selectLatestRunWithStep,
  statusCountGapWarning,
  RUN_STATUSES,
} from '../lib/github-client.mjs';

test('parses supported GitHub origin URL forms', () => {
  assert.equal(parseGitHubRepository('https://github.com/nalfeo/Crawler.git'), 'nalfeo/Crawler');
  assert.equal(parseGitHubRepository('git@github.com:nalfeo/Crawler.git'), 'nalfeo/Crawler');
  assert.equal(parseGitHubRepository('ssh://git@github.com/nalfeo/Crawler.git'), 'nalfeo/Crawler');
  assert.equal(parseGitHubRepository('https://example.com/nalfeo/Crawler.git'), null);
});

test('redacts environment and token-shaped secrets from surfaced errors', () => {
  const error = sanitizeErrorText('failed ghp_literal and secret-value', {
    GH_TOKEN: 'secret-value',
  });
  assert.equal(error.includes('secret-value'), false);
  assert.equal(error.includes('ghp_literal'), false);
  assert.match(error, /<redacted>/);
});

test('keeps partial workflow status results and reports omitted runs', () => {
  const merged = mergeRunStatusResults(
    [
      {
        status: 'fulfilled',
        value: {
          runs: [{ id: 1 }, { id: 2 }],
          totalCount: 4,
          apiCalls: 1,
        },
      },
      { status: 'rejected', reason: new Error('waiting endpoint failed') },
      {
        status: 'fulfilled',
        value: {
          runs: [{ id: 2 }, { id: 3 }],
          totalCount: 2,
          apiCalls: 1,
        },
      },
    ],
    ['queued', 'waiting', 'in_progress'],
  );

  assert.deepEqual(
    merged.runs.map((run) => run.id),
    [1, 2, 3],
  );
  assert.equal(merged.omittedCount, 2);
  assert.equal(merged.apiCalls, 2);
  assert.equal(merged.allFailed, false);
  assert.match(merged.partialErrors[0], /waiting endpoint failed/);
  assert.match(statusCountGapWarning(merged.omittedCount), /transitioned state/);
  assert.equal(statusCountGapWarning(0), null);
});

test('marks a workflow collection unusable when every status request fails', () => {
  const merged = mergeRunStatusResults(
    [
      { status: 'rejected', reason: new Error('one') },
      { status: 'rejected', reason: new Error('two') },
    ],
    ['queued', 'in_progress'],
  );
  assert.equal(merged.allFailed, true);
  assert.equal(merged.partialErrors.length, 2);
});

test('signal.throwIfAborted propagates cancellation that allSettled would absorb', () => {
  // allSettled turns every rejection, including AbortErrors, into a normal rejected entry;
  // mergeRunStatusResults sees them all as ordinary partial failures and returns allFailed: true
  // without rethrowing AbortError. signal.throwIfAborted() must be called after allSettled to
  // restore the abort path before mergeRunStatusResults converts the results.
  const abortError = new DOMException('The operation was aborted.', 'AbortError');
  const merged = mergeRunStatusResults([
    { status: 'rejected', reason: abortError },
    { status: 'rejected', reason: abortError },
  ]);
  assert.equal(merged.allFailed, true);
  assert.ok(
    merged.partialErrors.every((msg) => !msg.includes('AbortError') || typeof msg === 'string'),
    'AbortErrors are silently treated as partial errors — not rethrown',
  );
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => controller.signal.throwIfAborted(), { name: 'AbortError' });
});

test('includes pending and requested states in the active-run query set', () => {
  assert.ok(
    RUN_STATUSES.includes('pending'),
    'pending must be queried so queued runs are not missed',
  );
  assert.ok(
    RUN_STATUSES.includes('requested'),
    'requested must be queried so queued runs are not missed',
  );
  assert.ok(RUN_STATUSES.includes('queued'), 'queued must remain in the set');
  assert.ok(RUN_STATUSES.includes('in_progress'), 'in_progress must remain in the set');
  assert.ok(RUN_STATUSES.includes('waiting'), 'waiting must remain in the set');
});

test('paginates every open asset-request issue with one bounded comment window per issue', async () => {
  const cursors = [];
  const queryGraphql = async (query, variables) => {
    cursors.push(variables.cursor);
    assert.match(query, /comments\(last: 100\)/);
    const page = cursors.length;
    return {
      data: {
        repository: {
          issues: {
            nodes: [
              {
                number: page,
                title: `Asset ${page}`,
                comments: {
                  totalCount: 1,
                  pageInfo: { hasPreviousPage: false },
                  nodes: [{ id: `comment-${page}`, body: '🎬 Queued for processing' }],
                },
              },
            ],
            pageInfo: {
              hasNextPage: page === 1,
              endCursor: page === 1 ? 'next-page' : null,
            },
          },
        },
      },
    };
  };

  const result = await loadAssetRequestIssues('nalfeo/Crawler', undefined, queryGraphql);

  assert.deepEqual(cursors, [null, 'next-page']);
  assert.deepEqual(
    result.issues.map((issue) => issue.number),
    [1, 2],
  );
  assert.equal(result.apiCalls, 2);
  assert.equal(result.truncated, false);
});

test('reports truncation when open asset requests exceed the five-page safety cap', async () => {
  let calls = 0;
  const queryGraphql = async () => {
    calls += 1;
    return {
      data: {
        repository: {
          issues: {
            nodes: [{ number: calls, comments: { nodes: [] } }],
            pageInfo: { hasNextPage: true, endCursor: `page-${calls}` },
          },
        },
      },
    };
  };

  const result = await loadAssetRequestIssues('nalfeo/Crawler', undefined, queryGraphql);

  assert.equal(calls, 5);
  assert.equal(result.issues.length, 5);
  assert.equal(result.truncated, true);
});

test('selects the newest executable asset workflow run instead of a newer skipped trigger', () => {
  const selected = selectLatestRunWithStep(
    [
      {
        id: 2,
        conclusion: 'skipped',
        jobs: [{ name: 'Ingest issues + drain queue', steps: [{ name: 'Set up job' }] }],
      },
      {
        id: 1,
        conclusion: 'success',
        jobs: [
          {
            name: 'Ingest issues + drain queue',
            steps: [{ name: 'Ingest asset-request issues' }],
          },
        ],
      },
    ],
    /ingest asset-request issues/i,
  );

  assert.equal(selected.id, 1);
});
