import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/merge-train-validate.yml');

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface MatrixInclude {
  gate: string;
  command: string;
}

interface WorkflowJob {
  needs?: string[];
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
  strategy?: {
    'fail-fast'?: boolean;
    matrix?: {
      include?: MatrixInclude[];
      shard?: number[];
    };
  };
  'timeout-minutes'?: number;
}

interface WorkflowDoc {
  permissions?: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
}

function loadWorkflow(): WorkflowDoc {
  return parse(readFileSync(WORKFLOW_PATH, 'utf8')) as WorkflowDoc;
}

const CANDIDATE_JOB_IDS = ['static', 'unit-tests', 'sprite-tests', 'health', 'security'];

describe('merge-train candidate validation sharding', () => {
  it('maps every legacy gate exactly once without affected-only filtering', () => {
    const jobs = loadWorkflow().jobs;
    expect(jobs.static?.strategy?.matrix?.include).toEqual([
      { gate: 'source-typecheck', command: 'npm run typecheck:src' },
      { gate: 'authoritative-lint', command: 'npm run lint' },
    ]);
    expect(jobs['unit-tests']?.strategy?.matrix?.shard).toEqual([1, 2, 3]);
    expect(jobs['sprite-tests']?.strategy?.matrix?.shard).toEqual([1, 2, 3, 4]);
    expect(jobs.health?.strategy?.matrix?.include).toEqual([
      { gate: 'physics-def-sync', command: 'npm run check:physics-defs-sync' },
      { gate: 'size-coverage', command: 'npm run check:size-coverage' },
      { gate: 'weight-coverage', command: 'npm run check:weight-coverage' },
    ]);

    const candidateYaml = JSON.stringify(
      Object.fromEntries(CANDIDATE_JOB_IDS.map((jobId) => [jobId, jobs[jobId]])),
    );
    expect(candidateYaml.match(/npm run security:check/g)).toHaveLength(1);
    expect(candidateYaml.match(/--project unit/g)).toHaveLength(1);
    expect(candidateYaml.match(/--project sprites/g)).toHaveLength(1);
    expect(candidateYaml).not.toMatch(/--changed|affected/i);
  });

  it('runs every matrix cell after a sibling failure and gives every job a timeout', () => {
    const jobs = loadWorkflow().jobs;
    for (const jobId of ['static', 'unit-tests', 'sprite-tests', 'health']) {
      expect(jobs[jobId]?.strategy?.['fail-fast'], jobId).toBe(false);
    }
    for (const jobId of [...CANDIDATE_JOB_IDS, 'publish']) {
      expect(jobs[jobId]?.['timeout-minutes'], jobId).toBeGreaterThan(0);
    }
  });

  it('keeps candidate execution read-only and the trusted publisher checkout-free', () => {
    const doc = loadWorkflow();
    expect(doc.permissions).toEqual({ contents: 'read' });

    for (const jobId of CANDIDATE_JOB_IDS) {
      const job = doc.jobs[jobId];
      expect(job?.permissions, jobId).toBeUndefined();
      expect(JSON.stringify(job), jobId).not.toMatch(
        /APP_ID|APP_PRIVATE_KEY|steps\.app-token|checks:\s*write/,
      );
      const checkout = job?.steps?.find((step) => step.uses?.startsWith('actions/checkout'));
      expect(checkout?.with?.ref, jobId).toBe('${{ github.event.repository.default_branch }}');
      expect(checkout?.with?.['persist-credentials'], jobId).toBe(false);
      const materialize = job?.steps?.find(
        (step) => step.name === 'Materialize immutable candidate',
      );
      expect(materialize?.env?.CANDIDATE_REF, jobId).toBe('${{ inputs.candidate_ref }}');
      expect(materialize?.env?.CANDIDATE_SHA, jobId).toBe('${{ inputs.candidate_sha }}');
      expect(materialize?.run, jobId).toBe(
        'bash .github/scripts/merge-train/materialize-candidate.sh',
      );
    }

    const publish = doc.jobs.publish;
    expect(publish?.permissions?.checks).toBe('write');
    expect(publish?.steps?.some((step) => step.uses?.startsWith('actions/checkout'))).toBe(false);
  });

  it('requires every candidate job before publishing the aggregate result', () => {
    const publish = loadWorkflow().jobs.publish;
    expect(publish?.needs).toEqual(CANDIDATE_JOB_IDS);
    const publishStep = publish?.steps?.find(
      (step) => step.name === 'Publish immutable candidate result',
    );
    expect(publishStep?.with?.script).toContain(
      "const expectedJobs = ['static', 'unit-tests', 'sprite-tests', 'health', 'security'];",
    );
  });

  it('records elapsed job timing after each candidate outcome', () => {
    const jobs = loadWorkflow().jobs;
    for (const jobId of CANDIDATE_JOB_IDS) {
      const steps = jobs[jobId]?.steps ?? [];
      expect(steps[0]?.name, jobId).toBe('Start job timing');
      const report = steps.find((step) => step.name === 'Report job timing');
      expect(report?.if, jobId).toBe('always()');
      expect(report?.run, jobId).toContain('GITHUB_STEP_SUMMARY');
      expect(report?.run, jobId).toContain('elapsed_seconds');
    }
  });
});
