import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOWS = [
  '.github/workflows/ai-sweep.yml',
  '.github/workflows/ai-sweep-recover.yml',
  '.github/workflows/weapon-sweep.yml',
] as const;

interface WorkflowJob {
  concurrency?: {
    group?: string;
    'cancel-in-progress'?: boolean;
    queue?: string;
  };
  strategy?: {
    'max-parallel'?: string | number;
    matrix?: unknown;
  };
  steps?: Array<{ run?: string }>;
  'timeout-minutes'?: number;
}

interface WorkflowDoc {
  permissions?: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
}

function loadWorkflow(relativePath: string): WorkflowDoc {
  return parse(readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')) as WorkflowDoc;
}

describe('queue-aware broad sweep admission', () => {
  for (const workflowPath of WORKFLOWS) {
    it(`${workflowPath} gives every job a non-cancelling global semaphore token`, () => {
      const doc = loadWorkflow(workflowPath);
      expect(doc.permissions).toMatchObject({
        contents: 'read',
        actions: 'read',
        'pull-requests': 'read',
        issues: 'read',
      });
      for (const [name, job] of Object.entries(doc.jobs)) {
        const group = job.concurrency?.group ?? '';
        expect(group, `${name} group`).toMatch(/^crawler-sweep-slot-/);
        expect(
          group === 'crawler-sweep-slot-0' ||
            (group.includes('${{ matrix.') && group.includes('sweepSlot')),
          `${name} group uses slot zero or a matrix sweepSlot`,
        ).toBe(true);
        expect(job.concurrency?.['cancel-in-progress'], `${name} cancellation`).toBe(false);
        expect(job.concurrency?.queue, `${name} queue policy`).toBe('max');
      }
    });

    it(`${workflowPath} dynamically caps every matrix from its assigned slot set`, () => {
      const doc = loadWorkflow(workflowPath);
      const matrixJobs = Object.entries(doc.jobs).filter(
        ([, job]) => job.strategy?.matrix !== undefined,
      );
      expect(matrixJobs.length).toBeGreaterThan(0);
      for (const [name, job] of matrixJobs) {
        expect(String(job.strategy?.['max-parallel']), `${name} max-parallel`).toContain(
          'max_parallel',
        );
        expect(job.concurrency?.group, `${name} matrix token`).toContain('sweepSlot');
      }
    });

    it(`${workflowPath} invokes the shared fail-closed budget probe`, () => {
      const doc = loadWorkflow(workflowPath);
      const budgetJobs = Object.entries(doc.jobs).filter(([, job]) =>
        (job.steps ?? []).some((step) =>
          (step.run ?? '').includes('node .github/scripts/sweep-budget.mjs'),
        ),
      );
      expect(budgetJobs.length).toBeGreaterThan(0);
      for (const [name, job] of budgetJobs) {
        expect(job['timeout-minutes'], `${name} timeout`).toBeGreaterThan(0);
        expect(job['timeout-minutes'], `${name} timeout`).toBeLessThanOrEqual(15);
      }
    });
  }
});
