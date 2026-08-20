import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatReleaseBaselineLine,
  parseReleaseBaselineIndex,
  RELEASE_BASELINE_BRANCH,
  RELEASE_BASELINE_INDEX_PATH,
  resolveLatestReleaseBaseline,
  resolveLatestReleaseBaselineSafely,
  selectLatestReleaseBaseline,
} from './release-baseline.mjs';

const token = 'token';
const repository = 'nalfeo/Crawler';
const indexPath = `/repos/nalfeo/Crawler/contents/${RELEASE_BASELINE_INDEX_PATH}?ref=${RELEASE_BASELINE_BRANCH}`;

function entry(overrides = {}) {
  return {
    commit: 'a'.repeat(40),
    commitDate: '2026-08-20T07:29:59Z',
    capturedAt: '2026-08-20T08:45:32.263Z',
    runUrl: 'https://github.com/nalfeo/Crawler/actions/runs/32345869317',
    totalRuns: 300,
    path: `by-sha/${'a'.repeat(40)}.json`,
    legs: { floor1: { totalWins: 300, totalRuns: 300 } },
    ...overrides,
  };
}

function createRequestFn(body, { encode = false } = {}) {
  const calls = [];
  const requestFn = async (usedToken, path, options = {}) => {
    calls.push({ token: usedToken, path, options });
    if (path !== indexPath) throw new Error(`unexpected request: ${path}`);
    if (typeof body === 'function') return body();
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return encode
      ? { data: { content: Buffer.from(text, 'utf8').toString('base64'), encoding: 'base64' } }
      : { data: text };
  };
  return { requestFn, calls };
}

test('the newest release baseline is selected by commit date, not index order', () => {
  const older = entry({ commit: 'b'.repeat(40), commitDate: '2026-08-18T00:00:00Z' });
  const newer = entry({ commitDate: '2026-08-20T07:29:59Z' });
  const parsed = parseReleaseBaselineIndex(JSON.stringify([older, newer]));
  assert.equal(selectLatestReleaseBaseline(parsed).commit, newer.commit);
  assert.equal(selectLatestReleaseBaseline([]), null);
});

test('entries without a commit or payload path are ignored', () => {
  const parsed = parseReleaseBaselineIndex(
    JSON.stringify([{ commit: 'x' }, { path: 'by-sha/y.json' }, entry()]),
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].commit, 'a'.repeat(40));
});

test('a malformed index is rejected instead of silently resolving nothing', () => {
  assert.throws(() => parseReleaseBaselineIndex('{'), /not valid JSON/);
  assert.throws(() => parseReleaseBaselineIndex('{"commit":"a"}'), /must be an array/);
});

test('the resolver reads the baselines branch index and adds blob links', async () => {
  const { requestFn, calls } = createRequestFn([
    entry({ fun: { path: `by-sha/${'a'.repeat(40)}.fun-report.json` } }),
  ]);
  const baseline = await resolveLatestReleaseBaseline({ token, repository, requestFn });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].token, token);
  assert.equal(calls[0].path, indexPath);
  assert.equal(calls[0].options.method ?? 'GET', 'GET');
  assert.equal(baseline.branch, RELEASE_BASELINE_BRANCH);
  assert.equal(
    baseline.payloadUrl,
    `https://github.com/nalfeo/Crawler/blob/baselines/by-sha/${'a'.repeat(40)}.json`,
  );
  assert.equal(
    baseline.funReportUrl,
    `https://github.com/nalfeo/Crawler/blob/baselines/by-sha/${'a'.repeat(40)}.fun-report.json`,
  );
});

test('a base64 contents response is decoded', async () => {
  const { requestFn } = createRequestFn([entry()], { encode: true });
  const baseline = await resolveLatestReleaseBaseline({ token, repository, requestFn });
  assert.equal(baseline.commit, 'a'.repeat(40));
});

test('an empty index resolves to no baseline rather than throwing', async () => {
  const { requestFn } = createRequestFn([]);
  assert.equal(await resolveLatestReleaseBaseline({ token, repository, requestFn }), null);
});

test('the resolver validates its inputs', async () => {
  const { requestFn } = createRequestFn([entry()]);
  await assert.rejects(
    resolveLatestReleaseBaseline({ token: '', repository, requestFn }),
    /GITHUB_TOKEN/,
  );
  await assert.rejects(
    resolveLatestReleaseBaseline({ token, repository: 'nope', requestFn }),
    /owner\/repo/,
  );
});

test('a lookup failure never blocks the nightly issue', async () => {
  const { requestFn } = createRequestFn(() => {
    throw new Error('branch not found');
  });
  const failed = await resolveLatestReleaseBaselineSafely({ token, repository, requestFn });
  assert.equal(failed.status, 'unavailable');
  assert.equal(failed.baseline, null);
  assert.match(failed.reason, /branch not found/);

  const empty = await resolveLatestReleaseBaselineSafely({
    token,
    repository,
    requestFn: createRequestFn([]).requestFn,
  });
  assert.equal(empty.status, 'unavailable');
  assert.match(empty.reason, /no release baseline is published yet/);

  const ok = await resolveLatestReleaseBaselineSafely({
    token,
    repository,
    requestFn: createRequestFn([entry()]).requestFn,
  });
  assert.equal(ok.status, 'resolved');
  assert.equal(ok.baseline.commit, 'a'.repeat(40));
});

test('the rendered provenance line reports the payload shape without requiring one', () => {
  const line = formatReleaseBaselineLine({
    ...entry(),
    legs: { floor1: { totalWins: 300, totalRuns: 300 }, floor2: { totalWins: 41, totalRuns: 150 } },
    payloadUrl: 'https://example.invalid/payload.json',
    funReportUrl: null,
  });
  assert.match(line, /legs: floor1 300\/300, floor2 41\/150/);
  assert.match(line, /300 runs/);
  assert.doesNotMatch(line, /seeds\/weapon/);
  assert.match(formatReleaseBaselineLine(null), /Resolve it yourself/);
  assert.doesNotMatch(formatReleaseBaselineLine({ ...entry(), legs: undefined }), /legs:/);
});

test('the entrypoint resolves the git release baseline and never dispatches a sweep', async () => {
  const entrypoint = await (
    await import('node:fs/promises')
  ).readFile(new URL('./run.mjs', import.meta.url), 'utf8');
  assert.match(entrypoint, /resolveLatestReleaseBaselineSafely/);
  assert.doesNotMatch(entrypoint, /dispatches/);
});
