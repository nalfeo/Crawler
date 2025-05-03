#!/usr/bin/env node

import process from 'node:process';
import {
  applyGithubAudit,
  auditGithub,
  buildMaterializationPlan,
  createGhRunner,
  findRepoRoot,
  loadAndValidateEpic,
  type Diagnostic,
} from './epic-status-lib.js';

interface CliOptions {
  readonly epicId: string;
  readonly github: boolean;
  readonly reconcile: boolean;
  readonly materializationPlan: boolean;
  readonly json: boolean;
}

function parseArgs(args: ReadonlyArray<string>): CliOptions {
  const epicId = args.find((arg) => !arg.startsWith('--'));
  if (!epicId) {
    throw new Error(
      'Usage: npm run epic:status -- floor-2-equipment [--github] [--reconcile] [--materialization-plan] [--json]',
    );
  }
  const allowed = new Set([epicId, '--github', '--reconcile', '--materialization-plan', '--json']);
  const unknown = args.filter((arg) => !allowed.has(arg));
  if (unknown.length > 0) throw new Error(`Unknown arguments: ${unknown.join(', ')}`);
  return {
    epicId,
    github: args.includes('--github'),
    reconcile: args.includes('--reconcile'),
    materializationPlan: args.includes('--materialization-plan'),
    json: args.includes('--json'),
  };
}

function renderDiagnostics(label: string, diagnostics: ReadonlyArray<Diagnostic>): string[] {
  if (diagnostics.length === 0) return [`${label}: none`];
  return [
    `${label}: ${diagnostics.length}`,
    ...diagnostics.map(
      (diagnostic) =>
        `  - [${diagnostic.code}]${diagnostic.node_id ? ` ${diagnostic.node_id}:` : ''} ${diagnostic.message}`,
    ),
  ];
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = findRepoRoot(process.cwd());
  let result = loadAndValidateEpic(options.epicId, repoRoot);

  if (options.github) {
    if (!result.state) {
      result = {
        ...result,
        errors: [
          ...result.errors,
          {
            code: 'github.no-state',
            message: 'GitHub audit requires a schema-valid state manifest',
          },
        ],
        release_ready: false,
      };
    } else {
      const audit = auditGithub(result.state, createGhRunner());
      result = applyGithubAudit(result, audit);
    }
  }

  const payload = {
    epic_id: options.epicId,
    valid: result.errors.length === 0,
    release_ready: result.release_ready,
    ready_queue: result.ready_queue,
    blockers: result.blockers,
    errors: result.errors,
    warnings: result.warnings,
    reconciliation: options.reconcile ? result.proposal : undefined,
    materialization_plan:
      options.materializationPlan && result.state && result.errors.length === 0
        ? buildMaterializationPlan(result.state)
        : undefined,
    writes_performed: false,
  };

  if (options.json || options.reconcile || options.materializationPlan) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    const lines = [
      `Epic: ${options.epicId}`,
      `Offline schema/DAG: ${result.errors.length === 0 ? 'valid' : 'invalid'}`,
      `Release ready: ${result.release_ready ? 'yes' : 'no'}`,
      `Ready queue: ${result.ready_queue.length > 0 ? result.ready_queue.join(', ') : '(empty)'}`,
      ...renderDiagnostics('Errors', [...result.errors]),
      ...renderDiagnostics('Warnings', [...result.warnings]),
      ...renderDiagnostics('Blockers', [...result.blockers]),
      'Writes performed: no',
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
  }
  process.exitCode = result.errors.length > 0 ? 1 : 0;
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `epic:status failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
}
