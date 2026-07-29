import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  path.join(process.cwd(), '.github', 'workflows', 'theme-equipment.yml'),
  'utf8',
);
const workflow = parse(source) as {
  on?: Record<string, unknown>;
  concurrency?: Record<string, unknown>;
  jobs?: Record<string, { steps?: Array<{ name?: string; with?: Record<string, unknown> }> }>;
};

describe('theme-equipment workflow', () => {
  it('is manual, serialized, and grants the narrow paid/publish capabilities', () => {
    expect(workflow.on).toEqual({ workflow_dispatch: expect.any(Object) });
    expect(workflow.concurrency).toMatchObject({ 'cancel-in-progress': false });
    const encoded = JSON.stringify(workflow);
    expect(encoded).toContain('SPRITES_ALLOW_CI_THEME_PIPELINE');
    expect(encoded).toContain('SPRITES_ALLOW_CI_PIPELINE');
    expect(encoded).toContain('SPRITES_ALLOW_CI_THEME_PUBLISH');
    expect(encoded).toContain('CRAWLER_CI_PAT');
    expect(encoded).toContain('THEME_SET_ID');
    expect(encoded).toContain('THEME_PLAN_PATH');
    expect(source).not.toContain('"${{ inputs.set_id }}"');
    expect(source).not.toContain('"${{ inputs.plan_path }}"');
  });

  it('checks out full history for publish so the assets/queue merge finds a common ancestor', () => {
    const steps = workflow.jobs?.run?.steps ?? [];
    const publishCheckout = steps.find((step) => step.name === 'Checkout for publish');
    expect(publishCheckout).toBeDefined();
    // A shallow depth-1 clone makes `git merge` fail with "refusing to merge
    // unrelated histories" because the fetched assets/queue and main tips share
    // no common ancestor (queue-commit.ts). fetch-depth: 0 is required.
    expect(publishCheckout?.with?.['fetch-depth']).toBe(0);
  });
});
