import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
const WORKFLOW_PATH = path.join(
  ROOT,
  '.goobers/gaggles/crawler/workflows/crawler-pr-remediation.yaml',
);

interface WorkflowDefinition {
  metadata: { name: string };
  spec: {
    gaggle: string;
    start: string;
    triggers: Array<{ type: string; events?: string[]; schedule?: string }>;
    readiness: { maxConcurrentRuns: number; maxRunsPerHour: number };
    tasks: Array<{
      name: string;
      goober?: string;
      next?: string;
      run?: { command?: string[]; script?: string; workspace?: string };
      inputs?: Record<string, string>;
      inputsFrom?: Record<string, string>;
      capabilities?: string[];
      policyActions?: string[];
    }>;
    gates: Array<{ name: string; branches: Record<string, string> }>;
  };
}

const loadWorkflow = (): WorkflowDefinition =>
  parse(readFileSync(WORKFLOW_PATH, 'utf8')) as WorkflowDefinition;

describe('crawler-pr-remediation workflow', () => {
  it('is an autonomous, serialized Crawler reconciliation lane', () => {
    const workflow = loadWorkflow();

    expect(workflow.metadata.name).toBe('crawler-pr-remediation');
    expect(workflow.spec.gaggle).toBe('crawler');
    expect(workflow.spec.triggers).toContainEqual({
      type: 'webhook',
      events: ['pull_request'],
    });
    expect(workflow.spec.triggers).toContainEqual(
      expect.objectContaining({ type: 'schedule', schedule: '37 * * * *' }),
    );
    expect(workflow.spec.readiness).toEqual({ maxConcurrentRuns: 1, maxRunsPerHour: 2 });
    expect(workflow.spec.start).toBe('verify-lifecycle-ownership');
  });

  it('fails closed until every mutated lifecycle lane belongs to Goobers', () => {
    const workflow = loadWorkflow();
    const tasks = new Map(workflow.spec.tasks.map((task) => [task.name, task]));
    const gates = new Map(workflow.spec.gates.map((gate) => [gate.name, gate]));
    const ownership = tasks.get('verify-lifecycle-ownership');

    expect(ownership?.run?.script).toContain('LIFECYCLE_OWNER_CI_RECOVERY');
    expect(ownership?.run?.script).toContain('LIFECYCLE_OWNER_REVIEW_THREADS');
    expect(ownership?.run?.script).toContain('LIFECYCLE_OWNER_BRANCH_UPDATE');
    expect(ownership?.run?.script).toContain('GOOBERS_CRED_GITHUB_PR_WRITE');
    expect(ownership?.run?.script).toContain('repo="${GITHUB_REPOSITORY:-nalfeo/Crawler}"');
    expect(ownership?.run?.script).toContain("owner\" != 'goobers'");
    expect(ownership?.next).toBe('lifecycle-ownership-gate');
    expect(gates.get('lifecycle-ownership-gate')?.branches).toEqual({
      pass: 'update-behind-pr',
      fail: 'ownership-not-transferred',
    });
  });

  it('collects CI and conflict evidence before bounded agentic repair', () => {
    const workflow = loadWorkflow();
    const tasks = new Map(workflow.spec.tasks.map((task) => [task.name, task]));

    expect(tasks.get('gather-pr-context')?.run?.command).toEqual(['goobers', 'gather-pr-context']);
    expect(tasks.get('gather-ci-failures')?.run?.command).toEqual([
      'goobers',
      'gather-ci-failures',
    ]);
    expect(tasks.get('rebase-pr')?.inputs?.remediate).toContain('conflict');
    expect(tasks.get('rebase-pr')?.inputs?.remediate).toContain('failing-ci');
    expect(tasks.get('remediation-checkpoint')?.inputs).toMatchObject({
      conflictBudget: '2',
      failingCIBudget: '2',
    });
    expect(tasks.get('implement')?.goober).toBe('coder');
  });

  it('fences mutations and validates before publication', () => {
    const workflow = loadWorkflow();
    const tasks = new Map(workflow.spec.tasks.map((task) => [task.name, task]));

    for (const guard of [
      'guard-before-agent-context',
      'guard-before-implement',
      'guard-before-review',
      'guard-before-local-ci',
      'guard-before-push',
    ]) {
      expect(tasks.get(guard)?.run?.command).toEqual(['goobers', 'pr-claim']);
    }
    expect(tasks.get('local-ci')?.run?.script).toContain('npm ci --ignore-scripts');
    expect(tasks.get('local-ci')?.run?.script).toContain('npm run verify:fast');
    expect(tasks.get('capture-review-patch')?.run).toEqual({
      command: ['git', 'diff', 'origin/main...HEAD'],
      workspace: 'repo',
    });
    for (const publisher of ['publish-review-rework', 'publish-review-rejection']) {
      expect(tasks.get(publisher)?.run?.command).toEqual([
        'goobers',
        'apply-verdict',
        '--gate',
        'review',
      ]);
      expect(tasks.get(publisher)?.inputsFrom).toMatchObject({
        selectedNumber: 'gather-pr-context.selectedNumber',
        selectedHeadSha: 'remediation-checkpoint.headSha',
        selectedBaseSha: 'rebase-pr.rebaseBaseSha',
      });
      expect(tasks.get(publisher)?.capabilities).toContain('provider:pr:write');
      expect(tasks.get(publisher)?.policyActions).toContain('publish-review');
    }
    expect(tasks.get('local-ci')?.next).toBe('local-gate');
    expect(tasks.get('push-remediated')?.run?.command).toEqual(['goobers', 'push-remediated']);
    expect(tasks.get('push-remediated')?.policyActions).toContain('push-pr-branch');
    expect(tasks.get('release-escalated-claim')?.next).toBe('@escalate');
  });

  it('repasses repairable failures and parks unsafe outcomes', () => {
    const workflow = loadWorkflow();
    const gates = new Map(workflow.spec.gates.map((gate) => [gate.name, gate]));

    expect(gates.get('local-gate')?.branches).toMatchObject({
      pass: 'guard-before-push',
      fail: 'guard-before-implement',
      infra: 'park-infrastructure-failure',
      escalate: 'park-escalated',
    });
    expect(gates.get('review')?.branches).toMatchObject({
      pass: 'guard-before-local-ci',
      'needs-changes': 'publish-review-rework',
      fail: 'publish-review-rejection',
      escalate: 'publish-review-rejection',
    });
  });

  it('uses the Codex harness for every participating Crawler goober', () => {
    for (const name of ['coder', 'producer', 'reviewer']) {
      const definition = parse(
        readFileSync(
          path.join(ROOT, `.goobers/gaggles/crawler/goobers/${name}/goober.yaml`),
          'utf8',
        ),
      ) as { spec: { harness: string; workflows: string[] } };
      expect(definition.spec.harness).toBe('codex');
      if (name !== 'producer') {
        expect(definition.spec.workflows).toContain('crawler-pr-remediation');
      }
    }
  });
});
