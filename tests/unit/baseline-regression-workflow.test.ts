import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface WorkflowStep {
  name?: string;
  id?: string;
  if?: string;
  env?: Record<string, string>;
  run?: string;
}

interface WorkflowDoc {
  jobs: Record<
    string,
    {
      concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
      steps?: WorkflowStep[];
    }
  >;
}

function baselineSweepJob(): WorkflowDoc['jobs'][string] | undefined {
  const workflow = parse(
    readFileSync(path.join(REPO_ROOT, '.github/workflows/deploy.yml'), 'utf8'),
  ) as WorkflowDoc;
  return workflow.jobs['baseline-sweep'];
}

function baselineSteps(): WorkflowStep[] {
  return baselineSweepJob()?.steps ?? [];
}

describe('release baseline regression workflow', () => {
  it('detects only after publishing and files before diagnostic upload', () => {
    const steps = baselineSteps();
    const publish = steps.findIndex((step) => step.name === 'Publish to baselines branch');
    const balance = steps.findIndex(
      (step) => step.name === 'File nightly balance issue for release baseline',
    );
    const detect = steps.findIndex((step) => step.name === 'Detect baseline win-rate regression');
    const file = steps.findIndex(
      (step) => step.name === 'File regression issue and assign Copilot',
    );
    const upload = steps.findIndex((step) => step.name === 'Upload baseline as artifact');
    expect(publish).toBeGreaterThanOrEqual(0);
    expect(balance).toBeGreaterThan(publish);
    expect(detect).toBeGreaterThan(balance);
    expect(file).toBeGreaterThan(detect);
    expect(upload).toBeGreaterThan(file);
  });

  it('files the deduped nightly balance issue for every published release baseline', () => {
    const steps = baselineSteps();
    const file = steps.find(
      (step) => step.name === 'File nightly balance issue for release baseline',
    );
    expect(file?.env?.GITHUB_TOKEN).toContain('secrets.GITHUB_TOKEN');
    expect(file?.env?.CRAWLER_CI_PAT).toContain('secrets.CRAWLER_CI_PAT');
    expect(file?.run).toBe('node .github/scripts/nightly-balance-issue/run.mjs');
  });

  it('gates filing on the detector output and scopes both required tokens to that step', () => {
    const steps = baselineSteps();
    const detect = steps.find((step) => step.name === 'Detect baseline win-rate regression');
    const file = steps.find((step) => step.name === 'File regression issue and assign Copilot');
    expect(detect?.id).toBe('baseline-regression');
    expect(detect?.run).toContain('baseline-regression-check.ts');
    expect(file?.if).toBe("steps.baseline-regression.outputs.regression == 'true'");
    expect(file?.env?.GITHUB_TOKEN).toContain('secrets.GITHUB_TOKEN');
    expect(file?.env?.CRAWLER_CI_PAT).toContain('secrets.CRAWLER_CI_PAT');
    expect(file?.run).toContain('baseline-regression-issue.mjs');
  });

  it('serializes concurrent sweeps for the same release without cancelling either run', () => {
    const concurrency = baselineSweepJob()?.concurrency;
    expect(concurrency?.group).toBe(
      'baseline-sweep-${{ github.event.workflow_run.head_sha || github.sha }}',
    );
    expect(concurrency?.['cancel-in-progress']).toBe(false);
  });
});
