import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveLandedPr } from './resolve-landed-pr.mjs';

const REPOSITORY = 'nalfeo/Crawler';
const SHA = 'a'.repeat(40);

function requestFrom(routes) {
  return async (_token, path) => {
    if (!(path in routes)) throw new Error(`unexpected request: ${path}`);
    const route = routes[path];
    if (route instanceof Error) throw route;
    return { data: route };
  };
}

function resolveWith(routes) {
  return resolveLandedPr({
    sha: SHA,
    repository: REPOSITORY,
    token: 'test-token',
    requestFn: requestFrom(routes),
  });
}

const commitPath = `/repos/nalfeo/Crawler/commits/${SHA}`;
const pullsPath = `${commitPath}/pulls`;

test('resolver keeps corroborated merge-train trailers ahead of every inference candidate', async () => {
  const result = await resolveWith({
    [commitPath]: { commit: { message: 'subject\n\nMerge-Train-PR: 417\n' } },
    '/repos/nalfeo/Crawler/pulls/417': { number: 417, merged: true, merge_commit_sha: SHA },
  });

  assert.deepEqual(result, { number: '417', apiFailed: false });
});

test('resolver gives deploy, release sweep, and manual preview attribution to an open matching head', async () => {
  const result = await resolveWith({
    [commitPath]: { commit: { message: 'ordinary preview commit' } },
    [pullsPath]: [
      { number: 12, state: 'closed', merged: false, merge_commit_sha: 'b'.repeat(40) },
      { number: 13, state: 'closed', merged: true, merge_commit_sha: 'c'.repeat(40) },
      { number: 99, state: 'open', merged: false, head: { sha: SHA } },
    ],
  });

  assert.deepEqual(result, { number: '99', apiFailed: false });
});

test('resolver keeps an exact GitHub merge record ahead of an open matching head', async () => {
  const result = await resolveWith({
    [commitPath]: { commit: { message: 'ordinary landed commit' } },
    [pullsPath]: [
      { number: 99, state: 'open', merged: false, head: { sha: SHA } },
      { number: 417, state: 'closed', merged: true, merge_commit_sha: SHA },
    ],
  });

  assert.deepEqual(result, { number: '417', apiFailed: false });
});

test('resolver returns a clean no-match instead of attributing an unrelated closed association', async () => {
  const result = await resolveWith({
    [commitPath]: { commit: { message: 'ordinary commit' } },
    [pullsPath]: [{ number: 12, state: 'closed', merged: false, merge_commit_sha: 'b'.repeat(40) }],
  });

  assert.deepEqual(result, { number: '', apiFailed: false });
});

test('resolver preserves an API failure when inference cannot complete', async () => {
  const result = await resolveWith({
    [commitPath]: { commit: { message: 'ordinary commit' } },
    [pullsPath]: new Error('GitHub unavailable'),
  });

  assert.deepEqual(result, { number: '', apiFailed: true });
});
