#!/usr/bin/env node
/**
 * Deterministic, advisory task routing for Codex work. This tool reports a
 * recommendation; it does not read or change Codex app, account, or project
 * settings.
 */

export const TASK_CLASSES = [
  'narrow-telemetry-report',
  'routine-tooling-docs',
  'bounded-implementation',
  'complex-escalated',
] as const;

export type TaskClass = (typeof TASK_CLASSES)[number];
export type ReasoningEffort = 'low' | 'medium';

export interface TaskRoute {
  readonly model: 'gpt-5.6-luna' | 'gpt-5.6-terra' | 'gpt-5.6-sol';
  readonly reasoningEffort: ReasoningEffort;
  readonly maxModelToolLoops: number;
  readonly escalationCondition: string;
  readonly evidenceRequired: boolean;
}

export const TASK_ROUTES: Readonly<Record<TaskClass, TaskRoute>> = {
  'narrow-telemetry-report': {
    model: 'gpt-5.6-luna',
    reasoningEffort: 'low',
    maxModelToolLoops: 3,
    escalationCondition:
      'The requested report needs edits, diagnosis beyond named evidence, or a broader task class.',
    evidenceRequired: false,
  },
  'routine-tooling-docs': {
    model: 'gpt-5.6-terra',
    reasoningEffort: 'low',
    maxModelToolLoops: 5,
    escalationCondition:
      'The work becomes a bounded implementation or cannot finish within the loop cap.',
    evidenceRequired: false,
  },
  'bounded-implementation': {
    model: 'gpt-5.6-terra',
    reasoningEffort: 'medium',
    maxModelToolLoops: 8,
    escalationCondition:
      'Recorded failed attempts, cross-system scope, or an unresolved high-risk decision justify reclassification.',
    evidenceRequired: false,
  },
  'complex-escalated': {
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    maxModelToolLoops: 10,
    escalationCondition:
      'Stop and reframe when the evidence no longer supports the declared complex scope or the loop cap is reached.',
    evidenceRequired: true,
  },
};

export interface RouteRequest {
  readonly taskClass: TaskClass;
  readonly evidence?: string;
}

export interface RouteRecommendation {
  readonly schema: 'crawler-task-routing/v1';
  readonly taskClass: TaskClass;
  readonly route: TaskRoute;
  readonly evidence: string | null;
  readonly advisory: 'Does not apply Codex app settings.';
}

function isTaskClass(value: string): value is TaskClass {
  return (TASK_CLASSES as readonly string[]).includes(value);
}

export function routeTask(request: RouteRequest): RouteRecommendation {
  const route = TASK_ROUTES[request.taskClass];
  const evidence = request.evidence?.trim();
  if (route.evidenceRequired && !evidence) {
    throw new Error(
      `Task class "${request.taskClass}" requires recorded complexity/escalation evidence via --evidence.`,
    );
  }
  return {
    schema: 'crawler-task-routing/v1',
    taskClass: request.taskClass,
    route,
    evidence: evidence || null,
    advisory: 'Does not apply Codex app settings.',
  };
}

export function parseArgs(argv: readonly string[]): { request: RouteRequest; json: boolean } {
  let taskClass: TaskClass | undefined;
  let evidence: string | undefined;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--class') {
      const value = argv[++index];
      if (!value) throw new Error('Missing value for --class.');
      if (!isTaskClass(value)) {
        throw new Error(`Unsupported task class "${value}". Choose: ${TASK_CLASSES.join(', ')}.`);
      }
      taskClass = value;
    } else if (arg === '--evidence') {
      evidence = argv[++index];
      if (!evidence?.trim()) throw new Error('Missing value for --evidence.');
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--help' || arg === '-h') {
      throw new Error('HELP');
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!taskClass) throw new Error('Missing required --class.');
  return { request: { taskClass, evidence }, json };
}

export function renderRecommendation(recommendation: RouteRecommendation): string {
  const { route } = recommendation;
  return [
    `task class: ${recommendation.taskClass}`,
    `model: ${route.model}; reasoning: ${route.reasoningEffort}; max model/tool loops: ${route.maxModelToolLoops}`,
    `escalate when: ${route.escalationCondition}`,
    `evidence: ${recommendation.evidence ?? 'not required'}`,
    `telemetry: schema=${recommendation.schema} class=${recommendation.taskClass} model=${route.model} reasoning=${route.reasoningEffort} loops=${route.maxModelToolLoops}`,
    `advisory: ${recommendation.advisory}`,
  ].join('\n');
}

export function main(argv = process.argv.slice(2)): number {
  try {
    const { request, json } = parseArgs(argv);
    const recommendation = routeTask(request);
    process.stdout.write(
      `${json ? JSON.stringify(recommendation) : renderRecommendation(recommendation)}\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof Error && error.message === 'HELP') {
      process.stdout.write(
        `Usage: npm run task:route -- --class <${TASK_CLASSES.join('|')}> [--evidence <reference>] [--json]\n`,
      );
      return 0;
    }
    process.stderr.write(`task-route: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

if (process.argv[1]?.endsWith('task-routing.ts')) process.exitCode = main();
