import assert from 'node:assert/strict';
import test from 'node:test';

import { getWorkflowRunFreshness } from './freshness.mjs';

const context = {
  runId: 401,
  runNumber: 55,
  refName: 'main',
  repo: { owner: 'nalfeo', repo: 'Crawler' },
};

function createGithub(openIssues) {
  const calls = [];
  const github = {
    paginate: async (_method, params) => {
      calls.push(params);
      return openIssues;
    },
    rest: { issues: { listForRepo() {} } },
  };
  return { github, calls };
}

test('treats the current run as latest when no newer filed report exists', async () => {
  const { github, calls } = createGithub([
    {
      number: 12,
      title: 'nightly-mutation: 2026-07-11 regression',
      labels: [{ name: 'automation' }],
      body: '<!-- tracking-issue-run-number:54 -->\n<!-- tracking-issue-head-branch:main -->',
    },
    {
      number: 13,
      title: 'nightly-mutation: 2026-07-12 regression',
      labels: [{ name: 'automation' }],
      body: 'legacy issue without metadata',
    },
  ]);

  const freshness = await getWorkflowRunFreshness({
    github,
    context,
    titlePatterns: [/^nightly-mutation: \d{4}-\d{2}-\d{2} regression$/],
  });

  assert.equal(freshness.isLatest, true);
  assert.equal(freshness.newerIssue, null);
  assert.deepEqual(calls, [{ owner: 'nalfeo', repo: 'Crawler', state: 'open', per_page: 100 }]);
});

test('marks the run stale only when a newer filed report exists for the same branch', async () => {
  const newerIssue = {
    number: 19,
    title: 'docs-update: 2026-07-12 findings',
    labels: [{ name: 'automation' }],
    body: [
      '<!-- tracking-issue-run-id:409 -->',
      '<!-- tracking-issue-run-number:56 -->',
      '<!-- tracking-issue-head-branch:main -->',
      '',
      'report body',
    ].join('\n'),
  };
  const { github } = createGithub([
    newerIssue,
    {
      number: 18,
      title: 'docs-update: 2026-07-11 findings',
      labels: [{ name: 'automation' }],
      body: '<!-- tracking-issue-run-number:57 -->\n<!-- tracking-issue-head-branch:release -->',
    },
    {
      number: 17,
      title: 'docs-update: 2026-07-10 findings',
      labels: [{ name: 'automation' }],
      body: '<!-- tracking-issue-run-number:58 -->\n<!-- tracking-issue-head-branch:main -->',
      pull_request: { url: 'https://example.test/pr/17' },
    },
  ]);

  const freshness = await getWorkflowRunFreshness({
    github,
    context,
    titlePatterns: [/^docs-update: \d{4}-\d{2}-\d{2} findings$/],
  });

  assert.equal(freshness.isLatest, false);
  assert.deepEqual(freshness.newerIssue, newerIssue);
});

test('ignores issues without the automation label as freshness candidates', async () => {
  const { github } = createGithub([
    {
      number: 25,
      title: 'nightly-mutation: 2026-07-13 regression',
      labels: [],
      body: '<!-- tracking-issue-run-number:60 -->\n<!-- tracking-issue-head-branch:main -->',
    },
  ]);

  const freshness = await getWorkflowRunFreshness({
    github,
    context,
    titlePatterns: [/^nightly-mutation: \d{4}-\d{2}-\d{2} regression$/],
  });

  assert.equal(freshness.isLatest, true);
  assert.equal(freshness.newerIssue, null);
});
