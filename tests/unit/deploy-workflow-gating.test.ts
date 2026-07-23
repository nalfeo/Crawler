import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

/**
 * Regression coverage for a real review finding on deploy.yml: hourly
 * (schedule-triggered) `CI` runs also complete via `workflow_run` and
 * trigger this workflow. The `deploy` job is correctly gated to only run for
 * `push`-triggered CI completions (or a manual dispatch) so a scheduled
 * health run does not deploy anything.
 *
 * `baseline-sweep` declares `needs: deploy`, but GitHub Actions does NOT
 * cascade-skip a job that has its own explicit `if:` just because a job it
 * `needs` was skipped -- that only happens for the *default* (`success()`)
 * condition, or if the expression itself checks `needs.deploy.result`.
 * Before this fix, `baseline-sweep`'s own condition only checked
 * `workflow_run.conclusion == 'success'`, so it would still run a real
 * 100-seed sweep on every hourly CI success even though `deploy` (and thus
 * the actual Pages deploy) was skipped. Worse, because `baseline-sweep`
 * would then be the only job that ran (and it succeeds), the overall
 * workflow run's conclusion is `success`, not `skipped` -- which
 * `ci-recovery-incidents.yml` / `incident.mjs` would treat as a genuine
 * "Deploy to GitHub Pages" success and could use it to falsely auto-close a
 * real open deploy incident.
 *
 * The fix requires both jobs to share the identical push-only gate. This
 * test parses the real YAML (not a re-implementation) and asserts the two
 * `if:` expressions are exactly equal, so a future edit to one without the
 * other is caught even if the wording changes.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface WorkflowJob {
  if?: string;
  needs?: string | string[];
  outputs?: Record<string, string>;
  steps?: Array<{ id?: string; name?: string; run?: string; uses?: string; with?: Record<string, string | number | boolean> }>;
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

describe('deploy.yml job gating (scheduled CI must not run a live deploy or sweep)', () => {
  it('parses deploy.yml and finds release-gate, deploy, and baseline-sweep jobs', () => {
    const doc = loadDeployWorkflow();
    expect(doc.jobs['release-gate']).toBeDefined();
    expect(doc.jobs.deploy).toBeDefined();
    expect(doc.jobs['baseline-sweep']).toBeDefined();
  });

  it('gates both `deploy` and `baseline-sweep` on the identical push-only condition', () => {
    const doc = loadDeployWorkflow();
    const deployIf = String(getJob(doc, 'deploy').if).trim();
    const sweepIf = String(getJob(doc, 'baseline-sweep').if).trim();
    expect(sweepIf).toBe(deployIf);
  });

  it('requires both a successful conclusion AND a push event (not just a manual dispatch escape hatch)', () => {
    const doc = loadDeployWorkflow();
    for (const jobName of ['deploy', 'baseline-sweep']) {
      const condition = String(getJob(doc, jobName).if);
      expect(condition, jobName).toContain("needs.release-gate.outputs.should_run == 'true'");
      expect(condition, jobName).toContain("github.event_name == 'workflow_dispatch'");
      expect(condition, jobName).toContain("github.event.workflow_run.conclusion == 'success'");
      expect(condition, jobName).toContain("github.event.workflow_run.event == 'push'");
    }
  });

  it('keeps baseline-sweep depending on both release-gate and deploy jobs', () => {
    const doc = loadDeployWorkflow();
    expect(getJob(doc, 'baseline-sweep').needs).toEqual(['release-gate', 'deploy']);
  });

  it('resolves stale workflow_run releases via release-gate output', () => {
    const doc = loadDeployWorkflow();
    const gate = getJob(doc, 'release-gate');
    const gateStep = (gate.steps ?? []).find((step) => step.id === 'gate');
    const script = String(gateStep?.run ?? '');

    expect(gate.outputs?.should_run).toContain('steps.gate.outputs.should_run');
    expect(script).toContain('github.event.workflow_run.head_sha');
    expect(script).toContain('repos/${{ github.repository }}/commits/main');
    expect(script).toContain('should_run=false');
  });

  it('deploy job checkout is pinned to workflow_run head SHA (not current github.sha)', () => {
    const doc = loadDeployWorkflow();
    const deploy = getJob(doc, 'deploy');
    const checkoutStep = (deploy.steps ?? []).find((s) => s.uses?.startsWith('actions/checkout'));
    expect(checkoutStep, 'deploy must have a checkout step').toBeDefined();
    const ref = String(checkoutStep?.with?.ref ?? '');
    expect(ref, 'deploy checkout must pin ref to RUN_SHA').toContain(
      'github.event.workflow_run.head_sha',
    );
  });

  it('baseline-sweep checkout is pinned to workflow_run head SHA', () => {
    const doc = loadDeployWorkflow();
    const sweep = getJob(doc, 'baseline-sweep');
    const checkoutStep = (sweep.steps ?? []).find((s) => s.uses?.startsWith('actions/checkout'));
    expect(checkoutStep, 'baseline-sweep must have a checkout step').toBeDefined();
    const ref = String(checkoutStep?.with?.ref ?? '');
    expect(ref, 'baseline-sweep checkout must pin ref to RUN_SHA').toContain(
      'github.event.workflow_run.head_sha',
    );
  });
});
