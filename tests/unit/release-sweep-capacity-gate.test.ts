/**
 * Deterministic wiring guard for the release-sweep capacity gate
 * (nalfeo/Crawler#3774).
 *
 * The gate only saves runners if BOTH sweep jobs actually consult it, and its
 * "this sweep can claim the whole pool" rationale only holds while the report
 * matrix really is that wide and that parallel. A source-level parity check is
 * the only way to catch a matrix resize or a dropped `if:` — the workflow
 * itself can never be exercised locally.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

interface WorkflowJob {
  needs?: string[];
  if?: string;
  outputs?: Record<string, string>;
  strategy?: {
    'max-parallel'?: number;
    matrix?: { include?: Array<Record<string, string | number>> };
  };
  steps?: Array<{ name?: string; run?: string; env?: Record<string, string> }>;
}

function read(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

const workflow = parse(read('.github/workflows/deploy.yml')) as {
  jobs: Record<string, WorkflowJob>;
};

function job(id: string): WorkflowJob {
  const found = workflow.jobs[id];
  expect(found, `deploy.yml must define the ${id} job`).toBeDefined();
  return found as WorkflowJob;
}

describe('release sweep capacity gate wiring', () => {
  it('runs the admission script and exposes a should_sweep output', () => {
    const gate = job('sweep-capacity-gate');
    // The output must end in a literal 'true' so a never-provisioned runner —
    // where neither step writes a verdict — still fails open.
    expect(gate.outputs?.should_sweep).toContain('steps.admission.outputs.should_sweep');
    expect(gate.outputs?.should_sweep).toMatch(/\|\|\s*'true'\s*}}$/);
    const runs = (gate.steps ?? []).map((step) => step.run ?? '').join('\n');
    expect(runs).toContain('node .github/scripts/release-sweep-admission.mjs');
    // A manual deploy is an explicit operator decision and must never be
    // capacity-skipped.
    expect(runs).toContain('workflow_dispatch');
  });

  it('gates both sweep jobs on the capacity verdict', () => {
    for (const jobId of ['release-report-sweep', 'baseline-sweep']) {
      const sweep = job(jobId);
      expect(sweep.needs, `${jobId} must depend on sweep-capacity-gate`).toContain(
        'sweep-capacity-gate',
      );
      expect(sweep.if, `${jobId} must honor the capacity verdict`).toContain(
        "needs.sweep-capacity-gate.outputs.should_sweep == 'true'",
      );
    }
  });

  it('assumes exactly the peak runner footprint the sweep matrix can create', () => {
    const source = read('.github/scripts/release-sweep-admission.mjs');
    const declared = source.match(/RELEASE_SWEEP_PEAK_RUNNERS = (\d+);/)?.[1];
    expect(
      declared,
      'release-sweep-admission.mjs must declare RELEASE_SWEEP_PEAK_RUNNERS',
    ).toBeDefined();
    const strategy = job('release-report-sweep').strategy;
    expect(strategy?.['max-parallel']).toBe(Number(declared));
    expect((strategy?.matrix?.include ?? []).length).toBeGreaterThanOrEqual(Number(declared));
  });

  it('wires both operator knobs into the gate step', () => {
    const env = Object.assign(
      {},
      ...(job('sweep-capacity-gate').steps ?? []).map((step) => step.env ?? {}),
    ) as Record<string, string>;
    expect(env.RELEASE_SWEEP_MIN_INTERVAL_HOURS).toContain('vars.RELEASE_SWEEP_MIN_INTERVAL_HOURS');
    expect(env.RELEASE_SWEEP_MAX_COMPETING_DEMAND).toContain(
      'vars.RELEASE_SWEEP_MAX_COMPETING_DEMAND',
    );
  });
});
