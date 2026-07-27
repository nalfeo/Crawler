import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/ci-liveness-sweep.yml');

interface WorkflowDoc {
  on?: { schedule?: Array<{ cron?: string }>; workflow_dispatch?: unknown };
  jobs?: {
    'reconcile-liveness'?: {
      concurrency?: { group?: string; queue?: string; 'cancel-in-progress'?: boolean };
      steps?: Array<{ name?: string }>;
    };
  };
}

function loadWorkflow(): { doc: WorkflowDoc; raw: string } {
  const raw = readFileSync(WORKFLOW_PATH, 'utf8');
  return { doc: parse(raw) as WorkflowDoc, raw };
}

describe('CI liveness sweep workflow', () => {
  it('runs on a periodic cadence and manual dispatch', () => {
    const { doc } = loadWorkflow();
    expect(doc.on?.schedule?.[0]?.cron).toBe('*/10 * * * *');
    expect(doc.on?.workflow_dispatch).toBeDefined();
  });

  it('serializes sweeps and keeps closed-owner reclamation fan-out bounded', () => {
    const { doc } = loadWorkflow();
    const job = doc.jobs?.['reconcile-liveness'];
    expect(job?.concurrency?.group).toBe('crawler-ci-liveness-sweep');
    expect(job?.concurrency?.queue).toBe('max');
    expect(job?.concurrency?.['cancel-in-progress']).toBe(false);
    expect(job?.steps?.some((step) => step.name === 'Reclaim closed/merged owner fences')).toBe(
      true,
    );
  });

  it('triggers router/coordinator and the closed-owner fence reconcile path', () => {
    const { raw } = loadWorkflow();
    expect(raw).toContain("workflow_id: 'ci-recovery-router.yml'");
    expect(raw).toContain("workflow_id: 'ci-conflict-coordinator.yml'");
    expect(raw).toContain("workflow_id: 'ci-recovery.yml'");
    expect(raw).toContain("trigger: 'liveness-sweep:closed-owner-fence'");
    expect(raw).toContain("workflow_id: 'ci-pr-disposition.yml'");
  });
});
