import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/epic-drift-audit.yml');

interface WorkflowPathsTrigger {
  branches?: string[];
  paths?: string[];
}

interface WorkflowDoc {
  on: {
    pull_request?: WorkflowPathsTrigger;
    push?: WorkflowPathsTrigger;
    schedule?: Array<{ cron: string }>;
    workflow_dispatch?: unknown;
  };
}

const EXPECTED_PATHS = [
  'docs/knowledge/epics/floor-2-equipment/**',
  'scripts/agent/epics/**',
  'tests/unit/agent/epic-status.test.ts',
  'tests/unit/agent/epic-status-inaccessible-commit.test.ts',
  '.github/workflows/epic-drift-audit.yml',
];

function loadWorkflow(): WorkflowDoc {
  return parse(readFileSync(WORKFLOW_PATH, 'utf8')) as WorkflowDoc;
}

describe('Epic Drift Audit workflow trigger relevance', () => {
  it('keeps pull_request and push path filters scoped to floor-2-equipment control-plane inputs', () => {
    const doc = loadWorkflow();
    expect(doc.on.pull_request?.paths).toEqual(EXPECTED_PATHS);
    expect(doc.on.push?.paths).toEqual(EXPECTED_PATHS);
  });

  it('does not include broad docs or package manifest triggers in PR/push paths', () => {
    const doc = loadWorkflow();
    for (const trigger of [doc.on.pull_request, doc.on.push]) {
      const paths = trigger?.paths ?? [];
      expect(paths).not.toContain('docs/knowledge/epics/**');
      expect(paths).not.toContain('package.json');
      expect(paths).not.toContain('package-lock.json');
    }
  });

  it('preserves scheduled and manual drift audit triggers', () => {
    const doc = loadWorkflow();
    expect(doc.on.schedule).toEqual([{ cron: '23 10 * * 1' }]);
    expect(doc.on.workflow_dispatch).not.toBeUndefined();
  });
});
