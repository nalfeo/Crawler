import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it, vi } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/ci-recovery-review-wake-bridge.yml');

interface WorkflowStep {
  name?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: { script?: string; 'github-token'?: string };
}

interface WorkflowJob {
  if?: string;
  needs?: string;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps?: WorkflowStep[];
}

interface WorkflowDoc {
  name: string;
  on: {
    workflow_run: { workflows?: string[]; types?: string[]; branches?: string[] };
  };
  permissions: Record<string, string>;
  jobs: {
    inspect: WorkflowJob;
    dispatch: WorkflowJob;
  };
}

function loadWorkflow(): { doc: WorkflowDoc; raw: string } {
  const raw = readFileSync(WORKFLOW_PATH, 'utf8');
  return { doc: parse(raw) as WorkflowDoc, raw };
}

describe('CI Recovery trusted review wake bridge', () => {
  it('listens only to completed router runs without a branch filter or self-trigger', () => {
    const { doc } = loadWorkflow();
    expect(doc.name).toBe('CI Recovery Review Wake Bridge');
    expect(Object.keys(doc.on)).toEqual(['workflow_run']);
    expect(doc.on.workflow_run.workflows).toEqual(['CI Recovery Router']);
    expect(doc.on.workflow_run.types).toEqual(['completed']);
    expect(doc.on.workflow_run.branches).toBeUndefined();
    expect(doc.on.workflow_run.workflows).not.toContain(doc.name);
  });

  it('separates read-only inspection from the write-capable dispatch job', () => {
    const { doc, raw } = loadWorkflow();
    expect(doc.permissions).toEqual({});
    expect(doc.jobs.inspect.permissions).toEqual({
      actions: 'read',
      contents: 'read',
      'pull-requests': 'read',
    });
    expect(doc.jobs.inspect.if).toContain("conclusion == 'action_required'");
    expect(doc.jobs.dispatch.permissions).toEqual({ actions: 'write' });
    expect(doc.jobs.dispatch.needs).toBe('inspect');
    expect(doc.jobs.dispatch.if).toContain('needs.inspect.outputs.pr_number');
    expect(raw).not.toContain('APP_PRIVATE_KEY');
    expect(raw).not.toContain('CRAWLER_CI_PAT');
    expect(raw).not.toContain('create-github-app-token');
  });

  it('dispatches exactly one targeted CI Recovery reconciliation', async () => {
    const { doc } = loadWorkflow();
    const step = doc.jobs.dispatch.steps?.find(
      (candidate) => candidate.name === 'Dispatch exact PR recovery',
    );
    expect(step?.uses).toBe('actions/github-script@v7');
    expect(step?.with?.['github-token']).toBe('${{ secrets.GITHUB_TOKEN }}');
    const script = step?.with?.script;
    if (!script) throw new Error('dispatch script not found');

    const createWorkflowDispatch = vi.fn().mockResolvedValue({});
    const github = { rest: { actions: { createWorkflowDispatch } } };
    const context = { repo: { owner: 'nalfeo', repo: 'Crawler' } };
    vi.stubEnv('DEFAULT_BRANCH', 'main');
    vi.stubEnv('PR_NUMBER', '42');
    vi.stubEnv('RECOVERY_TRIGGER', 'trusted-review-wake:pull_request_review:run-123');
    try {
      const execute = new Function(
        'github',
        'context',
        `return (async () => {\n${script}\n})();`,
      ) as (githubArg: unknown, contextArg: unknown) => Promise<void>;
      await execute(github, context);
    } finally {
      vi.unstubAllEnvs();
    }

    expect(createWorkflowDispatch).toHaveBeenCalledTimes(1);
    expect(createWorkflowDispatch).toHaveBeenCalledWith({
      owner: 'nalfeo',
      repo: 'Crawler',
      workflow_id: 'ci-recovery.yml',
      ref: 'main',
      inputs: {
        operation: 'reconcile',
        pr_number: '42',
        trigger: 'trusted-review-wake:pull_request_review:run-123',
        lease_id: '',
      },
    });
  });
});
