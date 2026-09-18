import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface WorkflowJob {
  if?: string | boolean;
  steps?: Array<{ name?: string; if?: string | boolean }>;
}

interface Workflow {
  jobs: Record<string, WorkflowJob>;
}

function workflow(file: string): Workflow {
  return parse(
    readFileSync(path.join(REPO_ROOT, '.github', 'workflows', file), 'utf8'),
  ) as Workflow;
}

describe('Copilot automation kill switches', () => {
  it.each([
    ['issue-copilot-intake.yml', 'intake'],
    ['epic-reprocess.yml', 'reprocess'],
    ['ci-recovery-incidents.yml', 'route-incident'],
    ['ci-recovery.yml', 'reconcile'],
    ['goobers-run.yml', 'reserve'],
    ['pr-ready-reviewer-guard.yml', 'enforce-pr-state'],
  ])('disables %s at its entry job', (file, job) => {
    expect(String(workflow(file).jobs[job]?.if)).toMatch(/^(?:\$\{\{ false \}\}|false(?: &&|$))/);
  });

  it.each([
    ['nightly-mutation.yml', 'mutation-score', 'Create baseline update issue for copilot'],
    ['deploy.yml', 'baseline-sweep', 'File regression issue and assign Copilot'],
    ['deploy.yml', 'baseline-sweep', 'File report-only leg win-rate issue and assign Copilot'],
  ])('disables the Copilot step in %s', (file, job, stepName) => {
    const step = workflow(file).jobs[job]?.steps?.find(({ name }) => name === stepName);
    expect(step?.if).toBe('${{ false }}');
  });
});
