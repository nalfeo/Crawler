import assert from 'node:assert/strict';
import test from 'node:test';
import {
  _createListClient,
  BaselineRunNotFoundError,
  createLruCache,
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
  const raw = {
    id: 1,
    status: 'completed',
    conclusion: 'success',
    head_branch: 'main',
    head_sha: 'abc',
    created_at: '2026-07-17T00:00:00Z',
    updated_at: '2026-07-17T01:00:00Z',
    html_url: 'https://github.com/nalfeo/Crawler/actions/runs/1',
    event: 'workflow_dispatch',
    run_attempt: 1,
  };
  const mockRunGhJson = async (args) => {
    assert.ok(args.some((a) => a.includes('weapon-sweep.yml/runs')));
    return { workflow_runs: [raw] };
  };
  const { listWeaponSweepRuns } = _createListClient(mockRunGhJson);
  const runs = await listWeaponSweepRuns('nalfeo/Crawler', new AbortController().signal);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].workflowType, 'weapon-sweep');
  assert.equal(runs[0].id, 1);
});

test('listAiSweepRuns tags all returned runs with workflowType ai-sweep', async () => {
  const raw = {
    id: 2,
    status: 'in_progress',
    conclusion: null,
    head_branch: 'main',
    head_sha: 'def',
    created_at: '2026-07-17T00:00:00Z',
    updated_at: '2026-07-17T01:00:00Z',
    html_url: 'https://github.com/nalfeo/Crawler/actions/runs/2',
    event: 'workflow_dispatch',
    run_attempt: 1,
  };
  const mockRunGhJson = async (args) => {
    assert.ok(args.some((a) => a.includes('ai-sweep.yml/runs')));
    return { workflow_runs: [raw] };
  };
  const { listAiSweepRuns } = _createListClient(mockRunGhJson);
  const runs = await listAiSweepRuns('nalfeo/Crawler', new AbortController().signal);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].workflowType, 'ai-sweep');
  assert.equal(runs[0].id, 2);
});

test('listAllSweepRuns combines weapon and AI runs sorted newest first', async () => {
  const weaponRaw = {
    id: 10,
    status: 'completed',
    conclusion: 'success',
    head_branch: 'main',
    head_sha: 'aaa',
    created_at: '2026-07-16T00:00:00Z',
    updated_at: '2026-07-16T01:00:00Z',
    html_url: 'https://github.com/nalfeo/Crawler/actions/runs/10',
    event: 'workflow_dispatch',
    run_attempt: 1,
  };
  const aiRaw = {
    id: 20,
    status: 'completed',
    conclusion: 'success',
    head_branch: 'main',
    head_sha: 'bbb',
    created_at: '2026-07-17T00:00:00Z',
    updated_at: '2026-07-17T01:00:00Z',
    html_url: 'https://github.com/nalfeo/Crawler/actions/runs/20',
    event: 'workflow_dispatch',
    run_attempt: 1,
  };
  const mockRunGhJson = async (args) => {
    if (args.some((a) => a.includes('weapon-sweep.yml/runs')))
      return { workflow_runs: [weaponRaw] };
    if (args.some((a) => a.includes('ai-sweep.yml/runs'))) return { workflow_runs: [aiRaw] };
    throw new Error('Unexpected endpoint');
  };
  const { listAllSweepRuns } = _createListClient(mockRunGhJson);
  const runs = await listAllSweepRuns('nalfeo/Crawler', new AbortController().signal);
  assert.equal(runs.length, 2);
  // Newest first: ai run (2026-07-17) before weapon run (2026-07-16)
  assert.equal(runs[0].id, 20);
  assert.equal(runs[0].workflowType, 'ai-sweep');
  assert.equal(runs[1].id, 10);
  assert.equal(runs[1].workflowType, 'weapon-sweep');
});

test('listAllSweepRuns propagates weapon-sweep endpoint rejection', async () => {
  const mockRunGhJson = async (args) => {
    if (args.some((a) => a.includes('weapon-sweep.yml/runs'))) throw new Error('network error');
    return { workflow_runs: [] };
  };
  const { listAllSweepRuns } = _createListClient(mockRunGhJson);
  await assert.rejects(
    listAllSweepRuns('nalfeo/Crawler', new AbortController().signal),
    /network error/,
  );
});

test('listAllSweepRuns propagates ai-sweep endpoint rejection', async () => {
  const mockRunGhJson = async (args) => {
    if (args.some((a) => a.includes('ai-sweep.yml/runs'))) throw new Error('ai endpoint error');
    return { workflow_runs: [] };
  };
  const { listAllSweepRuns } = _createListClient(mockRunGhJson);
  await assert.rejects(
    listAllSweepRuns('nalfeo/Crawler', new AbortController().signal),
    /ai endpoint error/,
  );
});

test('getBaselineSweepRun tags a deploy.yml run with workflowType baseline-sweep', async () => {
  const raw = {
    id: 42,
    path: '.github/workflows/deploy.yml',
    status: 'completed',
    conclusion: 'success',
    head_branch: 'main',
    head_sha: 'abc',
    created_at: '2026-08-13T00:00:00Z',
    updated_at: '2026-08-13T01:00:00Z',
    html_url: 'https://github.com/nalfeo/Crawler/actions/runs/42',
    event: 'workflow_run',
    run_attempt: 1,
  };
  const mockRunGhJson = async (args) => {
    assert.ok(args.some((a) => a.includes('actions/runs/42')));
    return raw;
  };
  const { getBaselineSweepRun } = _createListClient(mockRunGhJson);
  const run = await getBaselineSweepRun('nalfeo/Crawler', 42, new AbortController().signal);
  assert.equal(run.id, 42);
  assert.equal(run.workflowType, 'baseline-sweep');
});

test('getBaselineSweepRun rejects a run id that resolves to a different workflow', async () => {
  const mockRunGhJson = async () => ({
    id: 43,
    path: '.github/workflows/weapon-sweep.yml',
    status: 'completed',
    conclusion: 'success',
  });
  const { getBaselineSweepRun } = _createListClient(mockRunGhJson);
  await assert.rejects(
    getBaselineSweepRun('nalfeo/Crawler', 43, new AbortController().signal),
    /not a "Deploy to GitHub Pages" workflow run/,
  );
});

test('getBaselineSweepRun throws BaselineRunNotFoundError for wrong-workflow run', async () => {
  const mockRunGhJson = async () => ({
    id: 43,
    path: '.github/workflows/weapon-sweep.yml',
    status: 'completed',
    conclusion: 'success',
  });
  const { getBaselineSweepRun } = _createListClient(mockRunGhJson);
  const error = await getBaselineSweepRun('nalfeo/Crawler', 43, new AbortController().signal).catch(
    (e) => e,
  );
  assert.ok(
    error instanceof BaselineRunNotFoundError,
    `expected BaselineRunNotFoundError, got ${error?.constructor?.name}`,
  );
  assert.match(error.message, /not a "Deploy to GitHub Pages" workflow run/);
});

test('getBaselineSweepRun throws BaselineRunNotFoundError for HTTP 404 not-found run', async () => {
  const mockRunGhJson = async () => {
    throw new Error(
      'gh command failed: HTTP 404: Not Found (https://api.github.com/repos/nalfeo/Crawler/actions/runs/99999)',
    );
  };
  const { getBaselineSweepRun } = _createListClient(mockRunGhJson);
  const error = await getBaselineSweepRun(
    'nalfeo/Crawler',
    99999,
    new AbortController().signal,
  ).catch((e) => e);
  assert.ok(
    error instanceof BaselineRunNotFoundError,
    `expected BaselineRunNotFoundError, got ${error?.constructor?.name}`,
  );
  assert.match(error.message, /not found/i);
});

test('getBaselineSweepRun propagates operational errors (auth, network, rate-limit)', async () => {
  const mockRunGhJson = async () => {
    throw new Error('gh command failed: HTTP 401 authentication failed');
  };
  const { getBaselineSweepRun } = _createListClient(mockRunGhJson);
  const error = await getBaselineSweepRun('nalfeo/Crawler', 55, new AbortController().signal).catch(
    (e) => e,
  );
  assert.ok(
    !(error instanceof BaselineRunNotFoundError),
    'auth error must not become BaselineRunNotFoundError',
  );
  assert.match(error.message, /HTTP 401/);
});
