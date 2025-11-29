#!/usr/bin/env node

import process from 'node:process';
import {
  auditGithub,
  buildMaterializationPlan,
  createGhRunner,
  findRepoRoot,
  loadAndValidateEpic,
  type Diagnostic,
  type ReconciliationProposal,
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

function mergeProposal(
  left: ReconciliationProposal,
  right: ReconciliationProposal,
): ReconciliationProposal {
  return {
    repo_patch: [...left.repo_patch, ...right.repo_patch],
    operator_actions: [...left.operator_actions, ...right.operator_actions],
  };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = findRepoRoot(process.cwd());
  const offline = loadAndValidateEpic(options.epicId, repoRoot);
  let errors = [...offline.errors];
  let warnings = [...offline.warnings];
  let proposal = offline.proposal;

  if (options.github) {
    if (!offline.state) {
      errors.push({
        code: 'github.no-state',
        message: 'GitHub audit requires a schema-valid state manifest',
      });
    } else {
      const audit = auditGithub(offline.state, createGhRunner());
      errors = [...errors, ...audit.errors];
      warnings = [...warnings, ...audit.warnings];
      proposal = mergeProposal(proposal, audit.proposal);
    }
  }

  const releaseReady = offline.release_ready && errors.length === 0;
  const payload = {
    epic_id: options.epicId,
    valid: errors.length === 0,
    release_ready: releaseReady,
    ready_queue: offline.ready_queue,
    blockers: offline.blockers,
    errors,
    warnings,
    reconciliation: options.reconcile ? proposal : undefined,
    materialization_plan:
      options.materializationPlan && offline.state && offline.errors.length === 0
        ? buildMaterializationPlan(offline.state)
        : undefined,
    writes_performed: false,
  };

  if (options.json || options.reconcile || options.materializationPlan) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    const lines = [
      `Epic: ${options.epicId}`,
      `Offline schema/DAG: ${offline.errors.length === 0 ? 'valid' : 'invalid'}`,
      `Release ready: ${releaseReady ? 'yes' : 'no'}`,
      `Ready queue: ${offline.ready_queue.length > 0 ? offline.ready_queue.join(', ') : '(empty)'}`,
      ...renderDiagnostics('Errors', errors),
      ...renderDiagnostics('Warnings', warnings),
      ...renderDiagnostics('Blockers', offline.blockers),
      'Writes performed: no',
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
  }
  process.exitCode = errors.length > 0 ? 1 : 0;
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `epic:status failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
}
