import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parse } from 'yaml';

const workflowPath = new URL('../workflows/pr-ready-reviewer-guard.yml', import.meta.url);
const workflow = parse(await readFile(workflowPath, 'utf8'));
const script = workflow.jobs['enforce-pr-state'].steps[0].with.script;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function runGuard({ changedFiles, action = 'opened' }) {
  const calls = [];
  const logs = [];
  const github = {
    paginate: async () => [
      {
        number: 42,
        node_id: 'PR_42',
        draft: true,
        requested_reviewers: [],
      },
    ],
    graphql: async (_query, variables) => {
      calls.push(['graphql', variables]);
      return {};
    },
    rest: {
      pulls: {
        get: async () => {
          calls.push(['get']);
          return { data: { changed_files: changedFiles } };
        },
        removeRequestedReviewers: async () => {
          calls.push(['remove-reviewer']);
        },
      },
    },
  };
  const core = {
    info: (message) => logs.push(message),
    warning: (message) => logs.push(message),
    error: (message) => logs.push(message),
    setFailed: (message) => {
      throw new Error(message);
    },
  };
  const context = {
    repo: { owner: 'nalfeo', repo: 'Crawler' },
    eventName: 'pull_request_target',
    payload: { action, pull_request: { number: 42 } },
  };
  const previousReviewer = process.env.REVIEWER_LOGIN;
  process.env.REVIEWER_LOGIN = 'nalfeo';
  try {
    await new AsyncFunction('github', 'core', 'context', script)(github, core, context);
  } finally {
    if (previousReviewer === undefined) {
      delete process.env.REVIEWER_LOGIN;
    } else {
      process.env.REVIEWER_LOGIN = previousReviewer;
    }
  }
  return { calls, logs };
}

test('keeps a zero-file pull request in draft', async () => {
  const { calls, logs } = await runGuard({ changedFiles: 0 });
  assert.equal(
    calls.some(([name]) => name === 'graphql'),
    false,
  );
  assert.ok(logs.some((message) => message.includes('no changed files')));
});

test('publishes a draft after GitHub reports at least one changed file', async () => {
  const { calls, logs } = await runGuard({ changedFiles: 2 });
  assert.equal(calls.filter(([name]) => name === 'graphql').length, 1);
  assert.ok(logs.some((message) => message.includes('with 2 changed file(s)')));
});

test('uses bounded changed-file retries only for the synchronized pull request', () => {
  assert.match(script, /context\.payload\.action === 'synchronize'/);
  assert.match(script, /context\.payload\.pull_request\?\.number === prNumber/);
  assert.match(script, /\[0, 1000, 2000\]/);
});
