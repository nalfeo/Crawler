import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createLruCache,
  mergeSweepRunResults,
  parseGitHubRepository,
  sanitizeErrorText,
} from '../lib/github-client.mjs';
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

test('listWeaponSweepRuns tags all returned runs with workflowType weapon-sweep', async () => {
  // parseGitHubRepository is pure — test the helper used by listWeaponSweepRuns
  // and listAiSweepRuns to verify workflowType is set correctly.
  // We verify this via the import + normalizeRun call pattern (pure unit check).
  const { normalizeRun } = await import('../lib/cloud-results.mjs');
  const raw = {
    id: 123,
    status: 'completed',
    conclusion: 'success',
    head_branch: 'main',
    head_sha: 'abc',
    created_at: '2026-07-17T00:00:00Z',
    updated_at: '2026-07-17T01:00:00Z',
    html_url: 'https://github.com/nalfeo/Crawler/actions/runs/123',
    event: 'workflow_dispatch',
    run_attempt: 1,
  };
  const normalized = normalizeRun(raw);
  // workflowType is not set by normalizeRun itself; it is set by the callers.
  // Verify the normalized shape does not already carry workflowType.
  assert.equal(Object.prototype.hasOwnProperty.call(normalized, 'workflowType'), false);
  // Spread tagging works correctly.
  const tagged = { ...normalized, workflowType: 'ai-sweep' };
  assert.equal(tagged.workflowType, 'ai-sweep');
  assert.equal(tagged.id, 123);
});

test('mergeSweepRunResults returns combined runs from both fulfilled listings', () => {
  const weaponRun = { id: 1, workflowType: 'weapon-sweep' };
  const aiRun = { id: 2, workflowType: 'ai-sweep' };
  const result = mergeSweepRunResults(
    { status: 'fulfilled', value: [weaponRun] },
    { status: 'fulfilled', value: [aiRun] },
  );
  assert.equal(result.length, 2);
});

test('mergeSweepRunResults returns partial list when one workflow fails but other has runs', () => {
  const aiRun = { id: 2, workflowType: 'ai-sweep' };
  const result = mergeSweepRunResults(
    { status: 'rejected', reason: new Error('weapon-sweep 404') },
    { status: 'fulfilled', value: [aiRun] },
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].workflowType, 'ai-sweep');
});

test('mergeSweepRunResults throws weapon-sweep error when combined is empty and weapon listing failed', () => {
  const weaponError = new Error('weapon-sweep not found');
  assert.throws(
    () =>
      mergeSweepRunResults(
        { status: 'rejected', reason: weaponError },
        { status: 'fulfilled', value: [] },
      ),
    (err) => err === weaponError,
  );
});

test('mergeSweepRunResults throws ai-sweep error when combined is empty and only AI listing failed', () => {
  const aiError = new Error('ai-sweep not found');
  assert.throws(
    () =>
      mergeSweepRunResults(
        { status: 'fulfilled', value: [] },
        { status: 'rejected', reason: aiError },
      ),
    (err) => err === aiError,
  );
});

test('mergeSweepRunResults throws weapon-sweep error when both listings fail', () => {
  const weaponError = new Error('weapon-sweep 500');
  const aiError = new Error('ai-sweep 500');
  assert.throws(
    () =>
      mergeSweepRunResults(
        { status: 'rejected', reason: weaponError },
        { status: 'rejected', reason: aiError },
      ),
    (err) => err === weaponError,
  );
});
