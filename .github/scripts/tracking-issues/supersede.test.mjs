import assert from 'node:assert/strict';
import test from 'node:test';

import { supersedeTrackingIssues } from './supersede.mjs';

const context = { repo: { owner: 'nalfeo', repo: 'Crawler' } };

function createGithub(openIssues, { commentError } = {}) {
  const comments = [];
  const updates = [];
  const github = {
    paginate: async (_method, params) => {
      assert.deepEqual(params, {
        owner: 'nalfeo',
        repo: 'Crawler',
        state: 'open',
        per_page: 100,
      });
      return openIssues;
    },
    rest: {
      issues: {
        listForRepo() {},
        async createComment(params) {
          if (commentError) {
            throw commentError;
          }
          comments.push(params);
        },
        async update(params) {
          updates.push(params);
        },
      },
    },
  };
  return { github, comments, updates };
}

test('closes only older reports in the requested stream', async () => {
  const { github, comments, updates } = createGithub([
    {
      number: 12,
      title: 'nightly-mutation: 2026-07-12 regression',
      labels: [{ name: 'automation' }],
    },
    {
      number: 11,
      title: 'nightly-mutation: 2026-07-11 regression',
      labels: [{ name: 'automation' }],
    },
    {
      number: 10,
      title: 'nightly-mutation: baseline update needed',
      labels: [{ name: 'automation' }],
    },
    {
      number: 9,
      title: 'nightly-mutation: 2026-07-09 regression',
      labels: [{ name: 'automation' }],
      pull_request: { url: 'https://example.test/pr/9' },
    },
    { number: 8, title: 'docs-update: 2026-07-08 findings', labels: [{ name: 'automation' }] },
  ]);

  const closed = await supersedeTrackingIssues({
    github,
    context,
    keepIssueNumber: 12,
    titlePatterns: [/^nightly-mutation: \d{4}-\d{2}-\d{2} regression$/],
  });

  assert.deepEqual(closed, [11]);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].issue_number, 11);
  assert.match(comments[0].body, /Superseded by #12/);
  assert.deepEqual(updates, [
    {
      owner: 'nalfeo',
      repo: 'Crawler',
      issue_number: 11,
      state: 'closed',
      state_reason: 'not_planned',
    },
  ]);
});

test('treats legacy Chronicle and docs-update titles as one stream', async () => {
  const { github, updates } = createGithub([
    { number: 22, title: 'docs-update: 2026-07-12 findings', labels: [{ name: 'automation' }] },
    {
      number: 21,
      title: '[Chronicle] Agent-OS Telemetry Report — 2026-07-06',
      labels: [{ name: 'automation' }],
    },
    { number: 20, title: 'docs-update: scheduled report', labels: [{ name: 'automation' }] },
  ]);

  const closed = await supersedeTrackingIssues({
    github,
    context,
    keepIssueNumber: 22,
    titlePatterns: [
      /^\[Chronicle\] Agent-OS Telemetry Report\b/,
      /^docs-update: \d{4}-\d{2}-\d{2} findings$/,
    ],
  });

  assert.deepEqual(closed, [21]);
  assert.deepEqual(
    updates.map((update) => update.issue_number),
    [21],
  );
});

test('is a no-op when no older matching report remains', async () => {
  const { github, comments, updates } = createGithub([
    { number: 32, title: 'docs-update: 2026-07-12 findings', labels: [{ name: 'automation' }] },
  ]);

  const closed = await supersedeTrackingIssues({
    github,
    context,
    keepIssueNumber: 32,
    titlePatterns: [/^docs-update: \d{4}-\d{2}-\d{2} findings$/],
  });

  assert.deepEqual(closed, []);
  assert.deepEqual(comments, []);
  assert.deepEqual(updates, []);
});

test('propagates cleanup failures so a retry can supersede the duplicate', async () => {
  const error = new Error('GitHub API unavailable');
  const { github, updates } = createGithub(
    [
      { number: 42, title: 'docs-update: 2026-07-12 findings', labels: [{ name: 'automation' }] },
      { number: 41, title: 'docs-update: 2026-07-12 findings', labels: [{ name: 'automation' }] },
    ],
    { commentError: error },
  );

  await assert.rejects(
    supersedeTrackingIssues({
      github,
      context,
      keepIssueNumber: 42,
      titlePatterns: [/^docs-update: \d{4}-\d{2}-\d{2} findings$/],
    }),
    error,
  );
  assert.deepEqual(updates, []);
});

test('does not close user-authored issues that lack the automation label', async () => {
  const { github, comments, updates } = createGithub([
    { number: 52, title: 'docs-update: 2026-07-12 findings', labels: [{ name: 'automation' }] },
    { number: 51, title: 'docs-update: 2026-07-11 findings', labels: [] },
  ]);

  const closed = await supersedeTrackingIssues({
    github,
    context,
    keepIssueNumber: 52,
    titlePatterns: [/^docs-update: \d{4}-\d{2}-\d{2} findings$/],
  });

  assert.deepEqual(closed, []);
  assert.deepEqual(comments, []);
  assert.deepEqual(updates, []);
});
