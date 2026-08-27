import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface WorkflowStep {
  id?: string;
  name?: string;
  env?: Record<string, string>;
  run?: string;
}

interface WorkflowJob {
  outputs?: Record<string, string>;
  steps?: WorkflowStep[];
}

interface WorkflowDoc {
  jobs: Record<string, WorkflowJob>;
}

function loadDeployWorkflow(): WorkflowDoc {
  const raw = readFileSync(path.join(REPO_ROOT, '.github/workflows/deploy.yml'), 'utf8');
  return parse(raw) as WorkflowDoc;
}

function getJob(doc: WorkflowDoc, name: string): WorkflowJob {
  const job = doc.jobs[name];
  if (!job) throw new Error(`job "${name}" not found in deploy.yml`);
  return job;
}

function getStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = (job.steps ?? []).find((entry) => entry.name === name);
  if (!step) throw new Error(`step "${name}" not found`);
  return step;
}

describe('deploy.yml baseline comment targeting', () => {
  it('exports deploy-selected PR numbers as a deploy job output', () => {
    const doc = loadDeployWorkflow();
    const deploy = getJob(doc, 'deploy');
    const selectedStep = getStep(deploy, 'Select released PR targets');

    expect(selectedStep.id).toBe('released-prs');
    expect(deploy.outputs?.released_pr_numbers).toContain('steps.released-prs.outputs.pr_numbers');
  });

  it('wires baseline comment step to deploy output, not global released-label query', () => {
    const doc = loadDeployWorkflow();
    const baseline = getJob(doc, 'baseline-sweep');
    const step = getStep(baseline, 'Comment baseline win-rate on released PR');
    const run = String(step.run ?? '');
    const deployEnv = step.env?.DEPLOY_PR_NUMBERS ?? '';

    expect(deployEnv).toContain('needs.deploy.outputs.released_pr_numbers');
    expect(run).toContain('$DEPLOY_PR_NUMBERS');
    expect(run).not.toContain('--label "released"');
    expect(run).not.toContain('gh pr list');
  });

  it('provides Pages, repository, and baseline data context for the rich report link', () => {
    const doc = loadDeployWorkflow();
    const deploy = getJob(doc, 'deploy');
    const baseline = getJob(doc, 'baseline-sweep');
    const step = getStep(baseline, 'Comment baseline win-rate on released PR');

    expect(deploy.outputs?.pages_url).toContain('steps.deploy-url.outputs.page_url');
    expect(step.env?.PAGES_URL).toContain('needs.deploy.outputs.pages_url');
    expect(step.env?.BASELINE_REPO).toContain('github.repository');
    expect(step.env?.BASELINES_DIR).toContain('baselines-wt');
    expect(step.env?.FUN_REPORT_JSON).toContain('.cache/baseline/fun-report.json');
  });
});
