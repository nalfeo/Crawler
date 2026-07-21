import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mergeRunStatusResults,
  parseGitHubRepository,
  sanitizeErrorText,
  statusCountGapWarning,
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
