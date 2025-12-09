import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/g2b-seed-issues.yml');

interface WorkflowDoc {
  on: {
    workflow_dispatch?: unknown;
    push?: unknown;
  };
  jobs: {
    seed?: {
      if?: string;
      steps?: Array<{
        name?: string;
        env?: Record<string, string>;
        run?: string;
        with?: Record<string, string>;
      }>;
    };
  };
}

describe('g2b seed issues workflow trust boundary', () => {
  it('runs only via workflow_dispatch and fences mutations to the default branch', () => {
    const raw = readFileSync(WORKFLOW_PATH, 'utf8');
    const doc = parse(raw) as WorkflowDoc;
    expect(doc.on.workflow_dispatch).toBeDefined();
    expect(doc.on.push).toBeUndefined();
    expect(doc.jobs.seed?.if).toContain('github.event.repository.default_branch');
    expect(doc.jobs.seed?.if).toContain("github.ref == format('refs/heads/{0}'");
  });

  it('checks out the trusted default branch and runs the reviewed seed script', () => {
    const raw = readFileSync(WORKFLOW_PATH, 'utf8');
    const doc = parse(raw) as WorkflowDoc;
    const steps = doc.jobs.seed?.steps ?? [];
    const checkout = steps.find((step) => step.name === 'Checkout trusted workflow script');
    expect(checkout?.with?.ref).toBe('${{ github.event.repository.default_branch }}');
    expect(checkout?.with?.['persist-credentials']).toBe(false);

    const seed = steps.find(
      (step) => step.name === 'Seed G2-B asset-request issues from pinned definitions',
    );
    expect(seed?.env?.GH_TOKEN).toBe('${{ secrets.CRAWLER_CI_PAT }}');
    expect(seed?.run).toBe('npx tsx .github/scripts/g2b-seed-issues/run.ts');
    expect(raw).not.toContain('|| secrets.GITHUB_TOKEN');
  });
});
