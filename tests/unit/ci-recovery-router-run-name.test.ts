import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/ci-recovery-router.yml');

interface WorkflowDoc {
  name: string;
  'run-name'?: string;
  jobs: Record<string, { name?: string }>;
}

function loadWorkflow(): { doc: WorkflowDoc; raw: string } {
  const raw = readFileSync(WORKFLOW_PATH, 'utf8');
  return { doc: parse(raw) as WorkflowDoc, raw };
}

describe('CI Recovery Router parked-run identity', () => {
  it('keeps the workflow name stable so the bridge run.name gate still matches', () => {
    const { doc } = loadWorkflow();
    expect(doc.name).toBe('CI Recovery Router');
  });

  it('does not depend on run-name because action-required runs park before YAML evaluation', () => {
    const { doc } = loadWorkflow();
    expect(doc['run-name']).toBeUndefined();
  });

  it('names the route job so its check run is recognisable as recovery-owned', () => {
    // The job name becomes the PR check-run name. When it was unset the check
    // was literally "route", which reconcile.mjs classified as a PR ci-failure
    // blocker the recovery agent could never clear (PR #2952 loop incident).
    const { doc } = loadWorkflow();
    expect(doc.jobs.route.name?.toLowerCase()).toContain('ci recovery');
  });

  it('binds review events through REST evidence rather than the mutable display title', () => {
    const bridge = readFileSync(
      path.join(REPO_ROOT, '.github/scripts/ci-recovery/review-wake-bridge.mjs'),
      'utf8',
    );
    expect(bridge).not.toContain('display_title');
    expect(bridge).not.toContain('sourcePrFromRunName');
    expect(bridge).toContain('/pulls/${number}/comments');
    expect(bridge).toContain('/pulls/${number}/reviews');
  });
});
