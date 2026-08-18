import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

/**
 * Regression coverage for a real review finding: `VITE_RUNS_INGEST_URL` (the
 * dev-build telemetry ingest endpoint) was added only to `deploy.yml`. Both
 * `promote-to-prod.yml` and `manual-preview.yml` also rebuild `staging/dev`
 * and publish it to `site/dev`, so running either would silently overwrite the
 * live dev site with a build where ingest is disabled.
 *
 * This parses the real YAML and asserts every workflow step that builds the
 * dev tier configures the same endpoint, so adding another dev publisher (or
 * changing the URL in one place) fails here instead of in production.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const DEV_PUBLISHING_WORKFLOWS = [
  '.github/workflows/deploy.yml',
  '.github/workflows/promote-to-prod.yml',
  '.github/workflows/manual-preview.yml',
];

interface WorkflowStep {
  name?: string;
  env?: Record<string, string>;
}

interface WorkflowDoc {
  jobs: Record<string, { steps?: WorkflowStep[] }>;
}

function devBuildSteps(relativePath: string): WorkflowStep[] {
  const doc = parse(readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')) as WorkflowDoc;
  return Object.values(doc.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .filter((step) => step.env?.DEPLOY_ENV === 'dev');
}

describe('dev-tier build workflows configure the ingest endpoint', () => {
  it.each(DEV_PUBLISHING_WORKFLOWS)('%s builds dev with VITE_RUNS_INGEST_URL', (workflow) => {
    const steps = devBuildSteps(workflow);
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(step.env?.VITE_RUNS_INGEST_URL).toBeTruthy();
    }
  });

  it('uses the identical endpoint in every dev build', () => {
    const urls = DEV_PUBLISHING_WORKFLOWS.flatMap((workflow) =>
      devBuildSteps(workflow).map((step) => step.env?.VITE_RUNS_INGEST_URL),
    );
    expect(new Set(urls).size).toBe(1);
  });
});
