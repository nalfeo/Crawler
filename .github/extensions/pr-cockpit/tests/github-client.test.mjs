import assert from 'node:assert/strict';
import test from 'node:test';

import { parseGitHubRepository, sanitizeErrorText } from '../lib/github-client.mjs';

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
