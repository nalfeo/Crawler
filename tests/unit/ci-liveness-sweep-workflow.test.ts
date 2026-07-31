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

  it('serializes sweeps via concurrency group', () => {
    const { doc } = loadWorkflow();
    const job = doc.jobs?.['reconcile-liveness'];
    expect(job?.concurrency?.group).toBe('crawler-ci-liveness-sweep');
    expect(job?.concurrency?.queue).toBe('max');
    expect(job?.concurrency?.['cancel-in-progress']).toBe(false);
    // Closed-fence reclamation fan-out is bounded via the router's reaper pass
    // (selectReaperBatch combined pool), not a direct step in the sweep.
    // The sweep dispatches the router which handles it under REAPER_LANE_CAP.
  });

  it('triggers router/coordinator, parked-check backstop, and disposition detection', () => {
    const { raw } = loadWorkflow();
    expect(raw).toContain("workflow_id: 'ci-recovery-router.yml'");
    expect(raw).toContain("workflow_id: 'ci-conflict-coordinator.yml'");
    // Closed-fence reclaim is routed through the router's reaper pass rather than
    // dispatched directly from the sweep (verified in router.test.mjs).
    expect(raw).toContain("workflow_id: 'action-required-retrigger.yml'");
    expect(raw).toContain("workflow_id: 'ci-pr-disposition.yml'");
  });
});
