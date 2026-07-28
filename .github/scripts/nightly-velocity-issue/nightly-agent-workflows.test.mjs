import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function readWorkflow(relativePath) {
  const workflow = await readFile(new URL(relativePath, import.meta.url), 'utf8');
  return workflow.replaceAll('\r\n', '\n');
}

function assertTrustedFilerWorkflow({ workflow, cron, concurrencyGroup, runCommand }) {
  assert.match(workflow, new RegExp(`- cron: '${cron.replaceAll('*', '\\*')}'`));
  assert.match(workflow, /\n  workflow_dispatch:\s*\n/);
  assert.match(
    workflow,
    new RegExp(`concurrency:\\n  group: ${concurrencyGroup}\\n  cancel-in-progress: false`),
  );
  assert.match(workflow, /permissions:\n  contents: read\n  issues: write/);
  assert.match(workflow, /timeout-minutes: 10/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, new RegExp(`run: ${runCommand.replaceAll('.', '\\.')}`));

  const executionStep = workflow.indexOf('- name: File nightly');
  assert.ok(executionStep > 0);
  assert.equal(workflow.slice(0, executionStep).includes('CRAWLER_CI_PAT'), false);
  assert.equal(workflow.match(/^\s+CRAWLER_CI_PAT:/gm)?.length, 1);
  assert.equal(workflow.match(/\$\{\{ secrets\.CRAWLER_CI_PAT \}\}/g)?.length, 1);
  assert.equal(workflow.match(/^\s+GITHUB_TOKEN:/gm)?.length, 1);
  assert.equal(workflow.match(/\$\{\{ secrets\.GITHUB_TOKEN \}\}/g)?.length, 1);
  assert.equal(workflow.includes('|| secrets.GITHUB_TOKEN'), false);
}

test('nightly velocity/perf workflows are staggered and use trusted filer execution', async () => {
  const velocityWorkflow = await readWorkflow('../../workflows/nightly-velocity-issue.yml');
  const perfWorkflow = await readWorkflow('../../workflows/nightly-perf-issue.yml');

  assert.match(velocityWorkflow, /- cron: '15 8 \* \* \*'/);
  assert.match(perfWorkflow, /- cron: '35 8 \* \* \*'/);
  assert.doesNotMatch(velocityWorkflow, /- cron: '0 8 \* \* \*'/);
  assert.doesNotMatch(perfWorkflow, /- cron: '0 8 \* \* \*'/);

  assertTrustedFilerWorkflow({
    workflow: velocityWorkflow,
    cron: '15 8 * * *',
    concurrencyGroup: 'nightly-velocity-issue-filer',
    runCommand: 'node .github/scripts/nightly-velocity-issue/run.mjs',
  });
  assertTrustedFilerWorkflow({
    workflow: perfWorkflow,
    cron: '35 8 * * *',
    concurrencyGroup: 'nightly-perf-issue-filer',
    runCommand: 'node .github/scripts/nightly-perf-issue/run.mjs',
  });
});
