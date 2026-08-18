import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

/**
 * Deterministic wiring coverage for the surface-targeted E2E visual routing
 * introduced in #1698. A typo in a job condition, `needs` entry, or Vitest
 * project name can silently turn an intended visual gate into an allowed skip,
 * so we assert the structural invariants of ci.yml directly rather than relying
 * on future model consistency.
 *
 * Specifically this verifies:
 *  - Each routed job (test-e2e-game / test-e2e-assets / test-e2e-devtools) is
 *    present in merge-gate's `needs` array.
 *  - Each job's `if:` condition references the correct surface flag.
 *  - Each job invokes the correct Vitest project (--project e2e-game etc.).
 *  - The merge-gate `check` calls each job with allow_skipped=true ("true").
 *  - The schedule override in the `changes` job sets all three visual flags.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CI_YML = path.join(REPO_ROOT, '.github/workflows/ci.yml');
const SETUP_NODE_ACTION_YML = path.join(REPO_ROOT, '.github/actions/setup-node/action.yml');

interface WorkflowStep {
  name?: string;
  if?: string | boolean;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  name?: string;
  if?: string | boolean;
  needs?: string | string[];
  'timeout-minutes'?: number;
  steps?: WorkflowStep[];
}

interface WorkflowDoc {
  jobs: Record<string, WorkflowJob>;
}

interface SetupNodeAction {
  runs: {
    steps: WorkflowStep[];
  };
}

function loadCi(): { doc: WorkflowDoc; raw: string } {
  const raw = readFileSync(CI_YML, 'utf8');
  return { doc: parse(raw) as WorkflowDoc, raw };
}

function getJob(doc: WorkflowDoc, name: string): WorkflowJob {
  const job = doc.jobs[name];
  if (!job) throw new Error(`job "${name}" not found in ci.yml`);
  return job;
}

function loadSetupNodeAction(): SetupNodeAction {
  return parse(readFileSync(SETUP_NODE_ACTION_YML, 'utf8')) as SetupNodeAction;
}

const E2E_JOBS = [
  {
    jobId: 'test-e2e-game',
    flag: 'game_visual_touched',
    project: 'e2e-game',
  },
  {
    jobId: 'test-e2e-assets',
    flag: 'asset_visual_touched',
    project: 'e2e-assets',
  },
  {
    jobId: 'test-e2e-devtools',
    flag: 'devtool_visual_touched',
    project: 'e2e-devtools',
  },
] as const;

const PLAYWRIGHT_JOBS = ['check-lightweight', ...E2E_JOBS.map(({ jobId }) => jobId)] as const;

describe('ci.yml — surface-targeted E2E visual routing wiring (#1698)', () => {
  it('parses ci.yml and finds merge-gate and all three e2e jobs', () => {
    const { doc } = loadCi();
    expect(doc.jobs['merge-gate']).toBeDefined();
    for (const { jobId } of E2E_JOBS) {
      expect(doc.jobs[jobId], `job ${jobId} must exist`).toBeDefined();
    }
  });

  it('merge-gate needs all three e2e jobs', () => {
    const { doc } = loadCi();
    const needs = getJob(doc, 'merge-gate').needs;
    const needsArr = Array.isArray(needs) ? needs : [needs];
    for (const { jobId } of E2E_JOBS) {
      expect(needsArr, `merge-gate must need ${jobId}`).toContain(jobId);
    }
  });

  it.each(E2E_JOBS)('$jobId if-condition references $flag', ({ jobId, flag }) => {
    const { doc } = loadCi();
    const condition = String(getJob(doc, jobId).if ?? '');
    expect(condition, `${jobId} must gate on ${flag}`).toContain(flag);
  });

  it.each(E2E_JOBS)('$jobId run step invokes --project $project', ({ jobId, project }) => {
    const { doc } = loadCi();
    const steps = getJob(doc, jobId).steps ?? [];
    const runStep = steps.find((s) => s.run?.includes('vitest') && s.run?.includes('--project'));
    expect(runStep, `${jobId} must have a vitest --project step`).toBeDefined();
    expect(runStep!.run, `${jobId} must invoke --project ${project}`).toContain(
      `--project ${project}`,
    );
  });

  it.each(PLAYWRIGHT_JOBS)('%s has a 20-minute job timeout', (jobId) => {
    const { doc } = loadCi();
    expect(getJob(doc, jobId)['timeout-minutes']).toBe(20);
  });

  it('bounds Playwright system dependency installation while retaining cache-aware browser installation', () => {
    const steps = loadSetupNodeAction().runs.steps;
    const dependencyInstall = steps.find(
      (step) => step.name === 'Install Playwright system dependencies',
    );
    const browserInstall = steps.find((step) => step.name === 'Install Playwright browser');

    expect(dependencyInstall?.run).toContain(
      'timeout --kill-after=30s 10m npx playwright install-deps chromium',
    );
    expect(dependencyInstall?.run).toContain('[ "$status" -eq 124 ] || [ "$status" -eq 137 ]');
    expect(browserInstall?.if).toContain("steps.pw-cache.outputs.cache-hit != 'true'");
    expect(browserInstall?.run).toBe('npx playwright install chromium');
  });

  it('merge-gate check calls each e2e job with allow_skipped semantics ("true")', () => {
    const { raw } = loadCi();
    // The merge-gate step uses `check "Label" "${{ needs.job.result }}" "true"` for
    // skippable jobs. Verify each e2e job result is checked with the "true" flag.
    for (const { jobId } of E2E_JOBS) {
      const pattern = new RegExp(`needs\\.${jobId}\\.result[^\\n]*"true"`);
      expect(raw, `merge-gate must check ${jobId} with allow_skipped=true`).toMatch(pattern);
    }
  });

  it('schedule override in changes job sets all three visual flags to true', () => {
    const { raw } = loadCi();
    // When triggered by schedule, all visual surfaces must run regardless of diff.
    expect(raw).toContain('game_visual_touched=true');
    expect(raw).toContain('asset_visual_touched=true');
    expect(raw).toContain('devtool_visual_touched=true');
  });
});
