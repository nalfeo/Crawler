import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface GoobersActionsWorkflow {
  on: {
    issues?: { types?: string[] };
    schedule?: Array<{ cron?: string }>;
    workflow_dispatch?: unknown;
  };
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs: {
    run?: {
      if?: string;
      name?: string;
      env?: Record<string, string>;
      steps?: Array<{
        name?: string;
        uses?: string;
        env?: Record<string, string>;
        run?: string;
        with?: Record<string, string | boolean>;
      }>;
    };
  };
}

interface GoobersDefinition {
  spec: {
    runControls?: { maxRepasses?: number };
    tasks: Array<{
      name: string;
      retry?: { maxAttempts?: number; backoffSeconds?: number };
    }>;
    gates: Array<{
      name: string;
      agentic?: { retry?: { maxAttempts?: number; backoffSeconds?: number } };
    }>;
  };
}

function loadYaml<T>(...segments: string[]): T {
  return parse(readFileSync(path.join(REPO_ROOT, ...segments), 'utf8')) as T;
}

describe('Goobers automatic dispatch and recovery', () => {
  it('runs for the exact approval label and performs an hourly recovery sweep', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');

    expect(workflow.on.issues?.types).toEqual(['labeled']);
    expect(workflow.on.schedule).toEqual([{ cron: '37 * * * *' }]);
    expect(workflow.on.workflow_dispatch).toBeDefined();
    expect(workflow.jobs.run?.if).toContain("github.event.label.name == 'goobers:approved'");
    expect(workflow.jobs.run?.if).toContain("github.event.issue.state == 'open'");
    expect(workflow.concurrency).toEqual({
      group: 'goobers-run',
      'cancel-in-progress': false,
    });
  });

  it('uses trusted pinned defaults outside manual dispatches', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const job = workflow.jobs.run;
    const checkout = job?.steps?.find((step) => step.name === 'Checkout');
    const install = job?.steps?.find((step) => step.name === 'Install Copilot CLI');
    const upload = job?.steps?.find((step) => step.name === 'Upload run journal');

    expect(job?.name).toContain("inputs.workflow || 'crawler-feature-pr'");
    expect(job?.env).toMatchObject({
      GOOBERS_VERSION: "${{ inputs.goobers_version || 'v0.2.2' }}",
      GOOBERS_WORKFLOW: "${{ inputs.workflow || 'crawler-feature-pr' }}",
    });
    expect(checkout?.with).toEqual({
      ref: '${{ github.event.repository.default_branch }}',
      'persist-credentials': false,
    });
    expect(install?.env?.COPILOT_CLI_VERSION).toBe("${{ inputs.copilot_cli_version || '1.0.80' }}");
    expect(upload?.with?.name).toContain("inputs.workflow || 'crawler-feature-pr'");
  });

  it('bounds same-run retries without retrying claim or provider mutations', () => {
    const definition = loadYaml<GoobersDefinition>(
      '.goobers',
      'gaggles',
      'crawler',
      'workflows',
      'crawler-feature-pr.yaml',
    );
    const tasks = new Map(definition.spec.tasks.map((task) => [task.name, task]));
    const review = definition.spec.gates.find((gate) => gate.name === 'review');
    const runStep = loadYaml<GoobersActionsWorkflow>(
      '.github',
      'workflows',
      'goobers-run.yml',
    ).jobs.run?.steps?.find((step) => step.name === 'Run the workflow');

    expect(definition.spec.runControls?.maxRepasses).toBe(2);
    for (const name of ['plan', 'implement']) {
      expect(tasks.get(name)?.retry).toEqual({ maxAttempts: 2, backoffSeconds: 30 });
    }
    for (const name of ['query-backlog', 'push-branch', 'open-pr', 'close-out']) {
      expect(tasks.get(name)?.retry).toBeUndefined();
    }
    expect(review?.agentic?.retry).toEqual({ maxAttempts: 2, backoffSeconds: 30 });
    expect(runStep?.run).not.toMatch(/\b(for|while|until)\b/);
  });
});
