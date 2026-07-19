#!/usr/bin/env node
/**
 * epic-materialize — Materialize child GitHub issues for the floor-2-equipment epic.
 *
 * Usage:
 *   npm run epic:materialize -- floor-2-equipment --dry-run
 *   npm run epic:materialize -- floor-2-equipment --confirm
 *
 * Flags:
 *   --dry-run   (default) Print the materialization plan without any GitHub writes.
 *               Exactly matches the output of `npm run epic:status -- --materialization-plan`.
 *   --confirm   Execute: create all missing child issues via the GitHub API,
 *               then record the new issue numbers in a single atomic write to
 *               epic-state.json, then re-run the offline validation.
 *
 * Properties:
 *   - Idempotent: existing issues (same title + labels) are never duplicated.
 *   - Requires explicit --confirm; no silent bulk writes.
 *   - The Producer (this script) is the sole writer of epic-state.json.
 *   - Child agents must not edit the global epic state.
 */

import process from 'node:process';
import {
  buildMaterializationPlan,
  createGhWriteRunner,
  findRepoRoot,
  loadAndValidateEpic,
  materializeChildIssues,
  patchEpicStateIssues,
  type MaterializationOutcome,
} from './epic-status-lib.js';

interface CliOptions {
  readonly epicId: string;
  readonly dryRun: boolean;
  readonly confirm: boolean;
  readonly json: boolean;
}

function parseArgs(args: ReadonlyArray<string>): CliOptions {
  const epicId = args.find((arg) => !arg.startsWith('--'));
  if (!epicId) {
    throw new Error(
      'Usage: npm run epic:materialize -- floor-2-equipment [--dry-run | --confirm] [--json]',
    );
  }
  const allowed = new Set([epicId, '--dry-run', '--confirm', '--json']);
  const unknown = args.filter((arg) => !allowed.has(arg));
  if (unknown.length > 0) throw new Error(`Unknown arguments: ${unknown.join(', ')}`);

  const dryRun = args.includes('--dry-run');
  const confirm = args.includes('--confirm');
  if (dryRun && confirm) {
    throw new Error('--dry-run and --confirm are mutually exclusive');
  }
  return {
    epicId,
    dryRun: dryRun || !confirm, // default to dry-run when neither flag is passed
    confirm,
    json: args.includes('--json'),
  };
}

function renderOutcome(outcome: MaterializationOutcome): string {
  const issueRef =
    outcome.issue_number !== null ? ` → #${outcome.issue_number} (${outcome.issue_url})` : '';
  return `  [${outcome.status.padEnd(8)}] ${outcome.node_id}: ${outcome.title}${issueRef}`;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = findRepoRoot(process.cwd());

  // Load and validate the epic state (offline only; GitHub audit is not required
  // to build or execute the materialization plan).
  const result = loadAndValidateEpic(options.epicId, repoRoot);

  if (!result.state) {
    process.stderr.write(
      `epic:materialize: epic state is schema-invalid; cannot proceed.\n` +
        `Errors:\n${result.errors.map((e) => `  [${e.code}] ${e.message}`).join('\n')}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const state = result.state;

  // Non-schema errors (e.g. git-verification failures in shallow clones) are
  // reported as warnings but do not block materialization.
  if (result.errors.length > 0) {
    process.stderr.write(
      `epic:materialize: offline validation has ${result.errors.length} non-schema error(s):\n` +
        `${result.errors.map((e) => `  [${e.code}] ${e.message}`).join('\n')}\n` +
        `Proceeding with materialization plan (state is schema-valid).\n`,
    );
  }

  const plan = buildMaterializationPlan(state);

  // --- DRY-RUN ---
  if (options.dryRun) {
    const dryRunPayload = {
      epic_id: options.epicId,
      mode: 'dry-run',
      plan_count: plan.length,
      materialization_plan: plan,
    };

    if (options.json) {
      process.stdout.write(`${JSON.stringify(dryRunPayload, null, 2)}\n`);
    } else {
      process.stdout.write(
        [
          `Epic: ${options.epicId}`,
          `Mode: dry-run`,
          `Issues to create: ${plan.length}`,
          ...(plan.length > 0
            ? plan.map((p) => `  - ${p.node_id}: ${p.title}`)
            : ['  (none — all nodes already have issues)']),
          '',
          'Run with --confirm to create the issues.',
        ].join('\n') + '\n',
      );
    }
    process.exitCode = 0;
    return;
  }

  // --- CONFIRM (WRITE) ---
  if (plan.length === 0) {
    const payload = {
      epic_id: options.epicId,
      mode: 'confirm',
      created_count: 0,
      existing_count: 0,
      outcomes: [],
      message: 'All nodes already have materialized issues. No writes performed.',
    };
    if (options.json) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      process.stdout.write(
        `epic:materialize: All nodes already have materialized issues. No writes performed.\n`,
      );
    }
    process.exitCode = 0;
    return;
  }

  process.stderr.write(
    `epic:materialize: creating ${plan.length} child issue(s) for ${options.epicId}…\n`,
  );

  const runner = createGhWriteRunner();
  const materializationResult = materializeChildIssues(state, runner, { dryRun: false });

  // Build the issue map for the state patch (created + existing outcomes).
  const issueMap = new Map<string, { number: number; url: string }>();
  for (const outcome of materializationResult.outcomes) {
    if (outcome.issue_number !== null && outcome.issue_url !== null) {
      issueMap.set(outcome.node_id, {
        number: outcome.issue_number,
        url: outcome.issue_url,
      });
    }
  }

  // Single atomic state update — Producer is the sole writer of epic-state.json.
  if (issueMap.size > 0) {
    patchEpicStateIssues(repoRoot, options.epicId, issueMap);
    process.stderr.write(
      `epic:materialize: updated epic-state.json with ${issueMap.size} issue reference(s).\n`,
    );
  }

  // Re-run offline validation so the operator can see the updated status.
  const postResult = loadAndValidateEpic(options.epicId, repoRoot);

  // Non-git-verification errors in the post-run state are a real problem.
  const postRunHardErrors = postResult.errors.filter(
    (e) => e.code !== 'evidence.git-verification-failed',
  );
  if (postRunHardErrors.length > 0) {
    process.stderr.write(
      `epic:materialize: post-run validation has ${postRunHardErrors.length} error(s):\n` +
        `${postRunHardErrors.map((e) => `  [${e.code}] ${e.message}`).join('\n')}\n` +
        `The epic-state.json write may be invalid. Review before committing.\n`,
    );
    process.exitCode = 1;
  }

  const missingMaterialization = postResult.blockers.filter(
    (b) => b.code === 'materialization.missing-child-issue',
  );

  const payload = {
    epic_id: options.epicId,
    mode: 'confirm',
    created_count: materializationResult.created_count,
    existing_count: materializationResult.existing_count,
    outcomes: materializationResult.outcomes,
    post_run_hard_errors: postRunHardErrors.length,
    post_run_missing_materialization: missingMaterialization.length,
    writes_performed: true,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    const lines = [
      `Epic: ${options.epicId}`,
      `Mode: confirm`,
      `Created: ${materializationResult.created_count}`,
      `Existing (skipped): ${materializationResult.existing_count}`,
      'Outcomes:',
      ...materializationResult.outcomes.map(renderOutcome),
      '',
      `Post-run validation errors (non-git): ${postRunHardErrors.length}`,
      `Post-run missing materialization blockers: ${missingMaterialization.length}`,
      missingMaterialization.length === 0 && postRunHardErrors.length === 0
        ? `  ✓ State update complete. Commit epic-state.json, then run:\n  npm run epic:status -- ${options.epicId} --github --reconcile`
        : `  ⚠ Review errors above before committing.`,
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
  }

  // Exit code set to 1 above if there were post-run hard errors.
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `epic:materialize failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
}
