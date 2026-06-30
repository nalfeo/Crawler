import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { githubPaginate } from '../utils.mjs';

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_TOKEN = process.env.GITHUB_TOKEN;

function makeResponse({ body, link = null, ok = true, status = 200, text = '' }) {
  return {
    ok,
    status,
    async json() {
      return body;
    },
    async text() {
      return text;
    },
    headers: {
      get(name) {
        return name.toLowerCase() === 'link' ? link : null;
      },
    },
  };
}

function mockFetchSequence(pages) {
  let call = 0;
  global.fetch = async () => {
    const page = pages[call];
    call += 1;
    if (!page) {
      throw new Error('fetch called more times than pages provided');
    }
    return makeResponse(page);
  };
}

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_TOKEN === undefined) {
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GITHUB_TOKEN = ORIGINAL_TOKEN;
  }
});

test('githubPaginate follows Link rel="next" across pages and concatenates via extract', async () => {
  process.env.GITHUB_TOKEN = 'test-token';
  mockFetchSequence([
    {
      body: { check_runs: [{ id: 1 }, { id: 2 }] },
      link: '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"',
    },
    { body: { check_runs: [{ id: 3 }] }, link: null },
  ]);

  const items = await githubPaginate('/x?per_page=100', { extract: (page) => page.check_runs });
  assert.deepEqual(
    items.map((item) => item.id),
    [1, 2, 3],
  );
});

test('githubPaginate returns a single page when there is no next link (bare array)', async () => {
  process.env.GITHUB_TOKEN = 'test-token';
  mockFetchSequence([{ body: [{ id: 'a' }], link: null }]);

  const items = await githubPaginate('/comments?per_page=100');
  assert.deepEqual(items, [{ id: 'a' }]);
});

test('githubPaginate respects maxPages as a runaway guard', async () => {
  process.env.GITHUB_TOKEN = 'test-token';
  // Every page advertises a next link; the guard must stop at maxPages.
  global.fetch = async () =>
    makeResponse({ body: [{ id: 1 }], link: '<https://api.github.com/x?page=next>; rel="next"' });

  const items = await githubPaginate('/x', { maxPages: 3 });
  assert.equal(items.length, 3);
});

test('githubPaginate throws when GITHUB_TOKEN is unset', async () => {
  delete process.env.GITHUB_TOKEN;
  await assert.rejects(() => githubPaginate('/x'), /GITHUB_TOKEN is required/);
});

test('githubPaginate surfaces a non-ok response as an error', async () => {
  process.env.GITHUB_TOKEN = 'test-token';
  global.fetch = async () => makeResponse({ body: {}, ok: false, status: 403, text: 'forbidden' });
  await assert.rejects(() => githubPaginate('/x'), /failed \(403\)/);
});

test('githubPaginate skips a non-array extract result instead of throwing', async () => {
  process.env.GITHUB_TOKEN = 'test-token';
  // A wrapped payload paginated without an extract that returns the inner array
  // (or a key that is missing) yields a non-array — it must be skipped, not crash.
  mockFetchSequence([{ body: { check_runs: [{ id: 1 }] }, link: null }]);
  const items = await githubPaginate('/x');
  assert.deepEqual(items, []);
});
