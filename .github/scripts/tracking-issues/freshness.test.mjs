import assert from 'node:assert/strict';
import test from 'node:test';

import { getWorkflowRunFreshness } from './freshness.mjs';

const context = {
  runId: 401,
  repo: { owner: 'nalfeo', repo: 'Crawler' },
};

function createGithub({ currentRun, workflowRuns }) {
  const calls = [];
  const github = {
    paginate: async (_method, params) => {
      calls.push({ type: 'list', params });
      return workflowRuns;
    },
    rest: {
      actions: {
        async getWorkflowRun(params) {
          calls.push({ type: 'get', params });
          return { data: currentRun };
        },
        listWorkflowRuns() {},
      },
    },
  };
  return { github, calls };
}

test('treats the highest matching run number as the latest run', async () => {
  const currentRun = {
    id: 401,
    workflow_id: 12,
    run_number: 55,
    event: 'schedule',
    head_branch: 'main',
  };
  const { github, calls } = createGithub({
    currentRun,
    workflowRuns: [
      currentRun,
      { id: 398, workflow_id: 12, run_number: 54, event: 'schedule', head_branch: 'main' },
    ],
  });

  const freshness = await getWorkflowRunFreshness({ github, context });

  assert.equal(freshness.isLatest, true);
  assert.equal(freshness.newerRun, null);
  assert.deepEqual(calls, [
    {
      type: 'get',
      params: { owner: 'nalfeo', repo: 'Crawler', run_id: 401 },
    },
    {
      type: 'list',
      params: {
        owner: 'nalfeo',
        repo: 'Crawler',
        workflow_id: 12,
        branch: 'main',
        per_page: 100,
      },
    },
  ]);
});

test('marks the run stale when a newer run for the same branch already exists', async () => {
  const currentRun = {
    id: 401,
    workflow_id: 12,
    run_number: 55,
    event: 'schedule',
    head_branch: 'main',
  };
  const newerRun = {
    id: 409,
    workflow_id: 12,
    run_number: 56,
    event: 'workflow_dispatch',
    head_branch: 'main',
  };
  const { github } = createGithub({
    currentRun,
    workflowRuns: [
      newerRun,
      currentRun,
      { id: 410, workflow_id: 12, run_number: 57, event: 'workflow_dispatch', head_branch: 'main' },
      { id: 411, workflow_id: 12, run_number: 58, event: 'schedule', head_branch: 'release' },
    ],
  });

  const freshness = await getWorkflowRunFreshness({ github, context });

  assert.equal(freshness.isLatest, false);
  assert.deepEqual(freshness.newerRun, newerRun);
});
