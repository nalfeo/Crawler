import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface WorkflowStep {
  name?: string;
  id?: string;
  uses?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}

interface DocsUpdateWorkflow {
  on?: Record<string, unknown>;
  jobs: Record<string, { steps?: WorkflowStep[] }>;
}

function loadWorkflow(): DocsUpdateWorkflow {
  return parse(
    readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'docs-update.yml'), 'utf8'),
  ) as DocsUpdateWorkflow;
}

describe('docs-update workflow', () => {
  it('runs from merge-train completion instead of raw main pushes or a schedule', () => {
    const workflow = loadWorkflow();
    const workflowRun = workflow.on?.workflow_run as
      | { workflows?: string[]; types?: string[]; branches?: string[] }
      | undefined;

    expect(workflowRun?.workflows).toEqual(['Merge Train']);
    expect(workflowRun?.types).toEqual(['completed']);
    expect(workflowRun?.branches).toEqual(['main']);
    expect(workflow.on).not.toHaveProperty('push');
    expect(workflow.on).not.toHaveProperty('schedule');
  });

  it('delegates payload gating to the tested helper before installing dependencies', () => {
    const steps = loadWorkflow().jobs['docs-update']?.steps ?? [];
    const detectIndex = steps.findIndex(
      (step) => step.name === 'Detect non-doc merge-train payload',
    );
    const installIndex = steps.findIndex((step) => step.name === 'Install dependencies');
    const detectStep = steps[detectIndex];

    expect(detectIndex).toBeGreaterThan(-1);
    expect(installIndex).toBeGreaterThan(detectIndex);
    expect(detectStep?.run).toContain('.github/scripts/docs-update-payload-gate.mjs');
    expect(detectStep?.env?.WORKFLOW_RUN_CONCLUSION).toContain('workflow_run.conclusion');
    expect(detectStep?.env?.WORKFLOW_RUN_EVENT).toContain('workflow_run.event');
    expect(detectStep?.env?.LANDED_SHA).toContain('workflow_run.head_sha');
  });

  it('checks out the landed merge-train SHA before classifying its files', () => {
    const checkout = loadWorkflow().jobs['docs-update']?.steps?.find(
      (step) => step.uses === 'actions/checkout@v4',
    );

    expect(checkout?.with?.ref).toContain('github.event.workflow_run.head_sha');
  });

  it('runs the lore provenance gate before other docs checks', () => {
    const steps = loadWorkflow().jobs['docs-update']?.steps ?? [];
    const loreIndex = steps.findIndex((step) => step.name === 'Validate lore canon and provenance');
    const readmeIndex = steps.findIndex(
      (step) => step.name === 'Check README vs package.json scripts',
    );
    const loreStep = steps[loreIndex];

    expect(loreIndex).toBeGreaterThan(-1);
    expect(loreStep?.run).toContain('scripts/agent/docs/check-lore-canon.ts');
    expect(loreStep?.id).toBe('lore_canon');
    expect(loreStep).not.toHaveProperty('continue-on-error');
    expect(loreIndex).toBeLessThan(readmeIndex);
  });

  it('does not open an automation PR when lore validation fails', () => {
    const detect = loadWorkflow().jobs['docs-update']?.steps?.find(
      (step) => step.name === 'Detect docs automation changes',
    );

    expect(detect?.if).toContain("steps.lore_canon.outcome == 'success'");
  });

  it('publishes the automation PR with CRAWLER_CI_PAT to avoid parked same-app CI', () => {
    const workflow = loadWorkflow();
    const openPr = workflow.jobs['docs-update']?.steps?.find(
      (step) => step.name === 'Open docs automation PR',
    );
    const retryPr = workflow.jobs['docs-update']?.steps?.find(
      (step) => step.name === 'Retry docs automation PR after branch race',
    );

    expect(openPr?.uses).toBe('peter-evans/create-pull-request@v7');
    expect(openPr?.with?.token).toBe('${{ secrets.CRAWLER_CI_PAT }}');
    expect(retryPr?.uses).toBe('peter-evans/create-pull-request@v7');
    expect(retryPr?.with?.token).toBe('${{ secrets.CRAWLER_CI_PAT }}');
  });

  it('prunes stale remote refs before opening the automation PR', () => {
    const workflow = loadWorkflow();
    const steps = workflow.jobs['docs-update']?.steps ?? [];
    const pruneIndex = steps.findIndex((step) => step.name === 'Prune stale remote tracking refs');
    const openPrIndex = steps.findIndex((step) => step.name === 'Open docs automation PR');
    const pruneStep = steps[pruneIndex];

    expect(pruneStep?.if).toContain("steps.payload.outputs.run == 'true'");
    expect(pruneStep?.run).toBe('git fetch --prune origin');
    expect(pruneIndex).toBeGreaterThan(-1);
    expect(openPrIndex).toBeGreaterThan(-1);
    expect(pruneIndex).toBeLessThan(openPrIndex);
  });
});
