import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface Workflow {
  on?: {
    issues?: { types?: string[] };
    schedule?: Array<{ cron?: string }>;
    workflow_run?: { workflows?: string[]; types?: string[] };
  };
  permissions?: { issues?: string };
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
}

function loadWorkflow(file: string): Workflow {
  return parse(readFileSync(path.join(REPO_ROOT, '.github/workflows', file), 'utf8')) as Workflow;
}

describe('epic workflows', () => {
  it('retries epic creation hourly while retaining review-resolution events', () => {
    const workflow = loadWorkflow('epic-create.yml');
    expect(workflow.on?.issues?.types).toEqual(['closed', 'reopened']);
    expect(workflow.on?.schedule).toContainEqual({ cron: '0 * * * *' });
    expect(workflow.permissions?.issues).toBe('write');
  });

  it('reprocesses managed epic nodes after creation and hourly', () => {
    const workflow = loadWorkflow('epic-reprocess.yml');
    expect(workflow.on?.workflow_run?.workflows).toEqual(['Epic Create']);
    expect(workflow.on?.workflow_run?.types).toEqual(['completed']);
    expect(workflow.on?.schedule).toContainEqual({ cron: '17 * * * *' });
    expect(workflow.permissions?.issues).toBe('write');
    expect(workflow.concurrency).toEqual({
      group: 'epic-reprocess',
      'cancel-in-progress': false,
    });
  });
});
