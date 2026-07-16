import assert from 'node:assert/strict';
import test from 'node:test';
import { createLruCache, parseGitHubRepository, sanitizeErrorText } from '../lib/github-client.mjs';
import { tokensMatch } from '../lib/http-security.mjs';

test('parses supported GitHub origin URL forms', () => {
  assert.equal(parseGitHubRepository('https://github.com/nalfeo/Crawler.git'), 'nalfeo/Crawler');
  assert.equal(parseGitHubRepository('git@github.com:nalfeo/Crawler.git'), 'nalfeo/Crawler');
  assert.equal(parseGitHubRepository('ssh://git@github.com/nalfeo/Crawler.git'), 'nalfeo/Crawler');
  assert.equal(parseGitHubRepository('https://example.com/nalfeo/Crawler.git'), null);
});

test('redacts environment and recognizable GitHub tokens from surfaced errors', () => {
  const classicTokenShape = `${'gh' + 'o_'}testtoken123`;
  const refreshTokenShape = `${'gh' + 'r_'}0123456789abcdef`;
  const text = sanitizeErrorText(
    `request failed for secret-value and ${classicTokenShape} and ${refreshTokenShape}`,
    { GH_TOKEN: 'secret-value' },
  );
  assert.equal(text.includes('secret-value'), false);
  assert.equal(text.includes('gho_'), false);
  assert.equal(text.includes('ghr_'), false);
  assert.match(text, /<redacted>/);
});

test('rejects same-character-count tokens with different UTF-8 byte lengths', () => {
  const expected = 'a'.repeat(48);
  assert.equal(tokensMatch(expected, expected), true);
  assert.equal(tokensMatch(`${'a'.repeat(46)}äb`, expected), false);
});

test('LRU cache evicts oldest entry when size exceeds maximum', () => {
  const cache = createLruCache(3);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  assert.equal(cache.size, 3);
  cache.set('d', 4);
  assert.equal(cache.size, 3);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('d'), 4);
});

test('LRU cache promotes hit entries so they are not evicted first', () => {
  const cache = createLruCache(2);
  cache.set('x', 10);
  cache.set('y', 20);
  cache.get('x'); // touch x — now y is the oldest
  cache.set('z', 30); // y should be evicted, not x
  assert.equal(cache.get('y'), undefined);
  assert.equal(cache.get('x'), 10);
  assert.equal(cache.get('z'), 30);
});

test('LRU cache set overwrites existing entry without growing over max', () => {
  const cache = createLruCache(2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('a', 99); // update, not grow
  assert.equal(cache.size, 2);
  assert.equal(cache.get('a'), 99);
});
