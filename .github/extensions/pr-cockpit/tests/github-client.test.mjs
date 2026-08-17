import assert from 'node:assert/strict';
import test from 'node:test';

import { listCheckRuns, parseGitHubRepository, sanitizeErrorText } from '../lib/github-client.mjs';

test('parses supported GitHub origin URL forms', () => {
  assert.equal(parseGitHubRepository('https://github.com/nalfeo/Crawler.git'), 'nalfeo/Crawler');
  assert.equal(parseGitHubRepository('git@github.com:nalfeo/Crawler.git'), 'nalfeo/Crawler');
  assert.equal(parseGitHubRepository('ssh://git@github.com/nalfeo/Crawler.git'), 'nalfeo/Crawler');
  assert.equal(parseGitHubRepository('https://example.com/nalfeo/Crawler.git'), null);
});

test('redacts env and token-shaped secrets in surfaced errors', () => {
  const text = sanitizeErrorText('failed secret-value github_pat_example and gho_example', {
    GITHUB_TOKEN: 'secret-value',
  });
  assert.equal(text.includes('secret-value'), false);
  assert.equal(text.includes('github_pat_'), false);
  assert.equal(text.includes('gho_'), false);
  assert.match(text, /<redacted>/);
});

test('paginates check runs with per_page=100 so required checks are not hidden', async () => {
  const calls = [];
  const runJson = async (args) => {
    const endpoint = args.at(-1);
    calls.push(endpoint);
    assert.match(endpoint, /per_page=100/);
    if (endpoint.endsWith('page=1')) {
      return {
        check_runs: Array.from({ length: 100 }, (_, index) => ({ name: `check-${index}` })),
      };
    }
    return { check_runs: [{ name: 'merge-train', status: 'completed', conclusion: 'failure' }] };
  };

  const runs = await listCheckRuns('nalfeo/Crawler', 'abc123', undefined, runJson);

  assert.equal(calls.length, 2);
  assert.equal(runs.length, 101);
  assert.equal(runs.at(-1).name, 'merge-train');
});
