import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface WorkflowStep {
  name?: string;
  uses?: string;
  with?: Record<string, string>;
}

interface DocsUpdateWorkflow {
  jobs: Record<string, { steps?: WorkflowStep[] }>;
}

function loadWorkflow(): DocsUpdateWorkflow {
  return parse(
    readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'docs-update.yml'), 'utf8'),
  ) as DocsUpdateWorkflow;
}

describe('docs-update workflow', () => {
  it('publishes the automation PR with CRAWLER_CI_PAT to avoid parked same-app CI', () => {
    const workflow = loadWorkflow();
    const openPr = workflow.jobs['docs-update']?.steps?.find(
      (step) => step.name === 'Open docs automation PR',
    );

    expect(openPr?.uses).toBe('peter-evans/create-pull-request@v7');
    expect(openPr?.with?.token).toBe('${{ secrets.CRAWLER_CI_PAT }}');
  });
});
