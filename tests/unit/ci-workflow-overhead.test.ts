import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface WorkflowStep {
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  needs?: string[];
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
}

interface TriggerConfig {
  branches?: string[];
  paths?: string[];
}

interface WorkflowDoc {
  on: {
    pull_request?: TriggerConfig;
    push?: TriggerConfig;
  };
  jobs: Record<string, WorkflowJob>;
}

function loadWorkflow(relativePath: string): WorkflowDoc {
  return parse(readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')) as WorkflowDoc;
}

describe('ci workflow overhead reduction', () => {
  it('reuses one shared setup job for static validation and folds advisory coverage/build work', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml');

    expect(workflow.jobs['check-types-and-lint']).toBeUndefined();
    expect(workflow.jobs['check-format-and-labs']).toBeUndefined();
    expect(workflow.jobs['test-unit-coverage']).toBeUndefined();
    expect(workflow.jobs.build).toBeUndefined();

    const staticValidation = workflow.jobs['static-validation'];
    expect(staticValidation?.needs).toEqual(['changes']);
    expect(
      staticValidation?.steps?.filter((step) => step.uses === 'actions/checkout@v4'),
    ).toHaveLength(1);
    expect(
      staticValidation?.steps?.filter((step) => step.uses === './.github/actions/setup-node'),
    ).toHaveLength(1);
    expect(staticValidation?.steps?.find((step) => step.name === 'Types & Lint')).toBeTruthy();
    expect(staticValidation?.steps?.find((step) => step.name === 'Format check')).toBeTruthy();
    expect(staticValidation?.steps?.find((step) => step.name === 'Lab gate check')).toBeTruthy();
    expect(
      staticValidation?.steps?.find((step) => step.name === 'Orphaned-system wiring guard'),
    ).toBeTruthy();
    expect(
      staticValidation?.steps?.find((step) => step.name === 'Guard + review-ledger tests'),
    ).toBeTruthy();

    const advisory = workflow.jobs['ci-advisory'];
    expect(advisory?.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'write',
    });
    expect(advisory?.steps?.find((step) => step.name === 'Unit tests with coverage')).toBeTruthy();
    expect(advisory?.steps?.find((step) => step.name === 'Upload coverage summary')).toBeTruthy();
    expect(advisory?.steps?.find((step) => step.name === 'Coverage report comment')).toBeTruthy();
    expect(advisory?.steps?.find((step) => step.name === 'Build')).toBeTruthy();

    expect(workflow.jobs['merge-gate']?.needs).toContain('static-validation');
    expect(workflow.jobs['merge-gate']?.needs).not.toContain('check-types-and-lint');
    expect(workflow.jobs['merge-gate']?.needs).not.toContain('check-format-and-labs');
  });
});

describe('epic drift audit trigger scope', () => {
  it('limits PR/push runs to the Floor 2 equipment control plane and direct execution inputs', () => {
    const workflow = loadWorkflow('.github/workflows/epic-drift-audit.yml');
    const expectedPaths = [
      'docs/knowledge/epics/floor-2-equipment/**',
      'scripts/agent/epics/**',
      '.github/actions/setup-node/action.yml',
      'package.json',
      'package-lock.json',
      'tsconfig*.json',
      '.github/workflows/epic-drift-audit.yml',
    ];

    expect(workflow.on.pull_request?.paths).toEqual(expectedPaths);
    expect(workflow.on.push?.paths).toEqual(expectedPaths);
    expect(workflow.on.pull_request?.paths).not.toContain('docs/knowledge/epics/**');
    expect(workflow.on.pull_request?.paths).not.toContain('tests/unit/agent/epic-status.test.ts');
  });
});
