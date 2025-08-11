import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface WorkflowDoc {
  concurrency?: {
    group?: string;
    'cancel-in-progress'?: string | boolean;
  };
}

type WorkflowContext = {
  github: {
    workflow: string;
    event_name: string;
    ref: string;
    run_id: number;
    event: {
      pull_request: { number: number };
    };
  };
};

function loadWorkflow(relativePath: string): WorkflowDoc {
  const raw = readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
  return parse(raw) as WorkflowDoc;
}

function formatAction(template: string, ...args: unknown[]): string {
  return template.replaceAll(/\{(\d+)}/g, (_, index: string) => String(args[Number(index)] ?? ''));
}

function toJsExpression(expression: string): string {
  return expression.replace(/\bgithub\./g, 'ctx.github.');
}

function evaluateActionExpression(expression: string, ctx: WorkflowContext): unknown {
  const js = toJsExpression(expression);
  return new Function('ctx', 'format', `return (${js});`)(ctx, formatAction);
}

function renderActionTemplate(template: string, ctx: WorkflowContext): string {
  return template.replaceAll(/\${{\s*(.*?)\s*}}/g, (_, expression: string) =>
    String(evaluateActionExpression(expression, ctx)),
  );
}

function evaluateCancelInProgress(
  value: string | boolean | undefined,
  ctx: WorkflowContext,
): boolean {
  if (typeof value === 'boolean') return value;
  if (!value) return false;
  const match = value.match(/^\s*\${{\s*(.*?)\s*}}\s*$/);
  if (!match || !match[1]) throw new Error(`expected expression wrapper, got: ${value}`);
  return Boolean(evaluateActionExpression(match[1], ctx));
}

function context(overrides: Partial<WorkflowContext['github']>): WorkflowContext {
  return {
    github: {
      workflow: overrides.workflow ?? 'CI',
      event_name: overrides.event_name ?? 'pull_request',
      ref: overrides.ref ?? 'refs/heads/main',
      run_id: overrides.run_id ?? 1,
      event: {
        pull_request: {
          number: overrides.event?.pull_request.number ?? 42,
        },
      },
    },
  };
}

describe('PR workflow concurrency grouping', () => {
  const workflows = [
    { path: '.github/workflows/ci.yml', workflowName: 'CI' },
    { path: '.github/workflows/security-review.yml', workflowName: 'Security Review Loop' },
  ] as const;

  for (const workflow of workflows) {
    it(`${workflow.path} cancels superseded runs only for pull_request`, () => {
      const doc = loadWorkflow(workflow.path);
      const prCtx = context({
        workflow: workflow.workflowName,
        event_name: 'pull_request',
        run_id: 1001,
        ref: 'refs/pull/42/head',
      });
      const pushCtx = context({
        workflow: workflow.workflowName,
        event_name: 'push',
        run_id: 2001,
      });
      expect(evaluateCancelInProgress(doc.concurrency?.['cancel-in-progress'], prCtx)).toBe(true);
      expect(evaluateCancelInProgress(doc.concurrency?.['cancel-in-progress'], pushCtx)).toBe(
        false,
      );
    });

    it(`${workflow.path} keeps PR groups isolated and separate from non-PR runs`, () => {
      const doc = loadWorkflow(workflow.path);
      const groupTemplate = doc.concurrency?.group;
      if (!groupTemplate) throw new Error(`concurrency.group missing in ${workflow.path}`);

      const pr42HeadA = renderActionTemplate(
        groupTemplate,
        context({
          workflow: workflow.workflowName,
          event_name: 'pull_request',
          ref: 'refs/pull/42/head',
          run_id: 3001,
          event: { pull_request: { number: 42 } },
        }),
      );
      const pr42HeadB = renderActionTemplate(
        groupTemplate,
        context({
          workflow: workflow.workflowName,
          event_name: 'pull_request',
          ref: 'refs/pull/42/head',
          run_id: 3002,
          event: { pull_request: { number: 42 } },
        }),
      );
      const pr43 = renderActionTemplate(
        groupTemplate,
        context({
          workflow: workflow.workflowName,
          event_name: 'pull_request',
          ref: 'refs/pull/43/head',
          run_id: 3003,
          event: { pull_request: { number: 43 } },
        }),
      );
      const push = renderActionTemplate(
        groupTemplate,
        context({
          workflow: workflow.workflowName,
          event_name: 'push',
          ref: 'refs/heads/main',
          run_id: 4001,
        }),
      );
      const schedule = renderActionTemplate(
        groupTemplate,
        context({
          workflow: workflow.workflowName,
          event_name: 'schedule',
          ref: 'refs/heads/main',
          run_id: 4002,
        }),
      );
      const manual = renderActionTemplate(
        groupTemplate,
        context({
          workflow: workflow.workflowName,
          event_name: 'workflow_dispatch',
          ref: 'refs/heads/main',
          run_id: 4003,
        }),
      );

      expect(pr42HeadA).toBe(pr42HeadB);
      expect(pr42HeadA).not.toBe(pr43);
      expect(pr42HeadA).not.toBe(push);
      expect(push).not.toBe(schedule);
      expect(push).not.toBe(manual);
      expect(schedule).not.toBe(manual);
    });

    it(`${workflow.path} group is stable across workflow display-name changes`, () => {
      const doc = loadWorkflow(workflow.path);
      const groupTemplate = doc.concurrency?.group;
      if (!groupTemplate) throw new Error(`concurrency.group missing in ${workflow.path}`);

      const groupOriginalName = renderActionTemplate(
        groupTemplate,
        context({
          workflow: workflow.workflowName,
          event_name: 'pull_request',
          ref: 'refs/pull/42/head',
          run_id: 5001,
          event: { pull_request: { number: 42 } },
        }),
      );
      const groupRenamedWorkflow = renderActionTemplate(
        groupTemplate,
        context({
          workflow: `${workflow.workflowName} - Renamed`,
          event_name: 'pull_request',
          ref: 'refs/pull/42/head',
          run_id: 5001,
          event: { pull_request: { number: 42 } },
        }),
      );

      expect(groupOriginalName).toBe(groupRenamedWorkflow);
    });
  }
});
