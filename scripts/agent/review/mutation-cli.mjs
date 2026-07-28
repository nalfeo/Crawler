#!/usr/bin/env node
// Thin process wrapper around Stryker for scoped, in-session mutation proofs.
//
//   npm run test:mutate -- <file>[:<start>-<end>] [--tests <glob>[,<glob>]] [options]
//
// See `mutation.mjs` for the rationale and the pure logic. This file only does
// I/O: resolve the covering tests, delete any stale report, invoke Stryker, then
// evaluate the report it produced.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  MUTATION_REPORT_PATH,
  TEST_ROOT,
  UsageError,
  collectTestFiles,
  deriveTestFiles,
  evaluateReport,
  formatSummary,
  parseArgs,
} from './mutation.mjs';

const STRYKER_BIN = path.join('node_modules', '@stryker-mutator', 'core', 'bin', 'stryker.js');

const USAGE = `
Prove a test can actually fail, by deliberately breaking the source under it.

Usage:
  npm run test:mutate -- <file>[:<start>-<end>] [options]

Examples:
  npm run test:mutate -- src/core/map/astar-grid.ts:295-335 \\
    --tests tests/ecs/astar-grid-equivalence.test.ts
  npm run test:mutate -- src/core/map/astar-grid.ts        # auto-derive tests

Options:
  --tests <globs>        Comma-separated test files/globs that cover the target.
                         STRONGLY preferred: suite size dominates runtime.
  --max-survivors <n>    Tolerated surviving mutants (default 0).
  --type-check           Enable Stryker's TypeScript checker (slower).
  --concurrency <n>      Stryker worker count (default 4).
  --json                 Emit the machine-readable verdict as JSON on stdout.
                         All diagnostics (Stryker logs, auto-derive status) are
                         routed to stderr so stdout carries only the JSON payload.
  -h, --help             Show this help.

Exit codes: 0 = every mutant detected (or within --max-survivors tolerance);
1 = survivors above tolerance, ignored mutants, no-coverage mutants, mutants
without a verdict, or no mutants at all.

Scope the LINE RANGE to the code you changed. Mutating a whole file re-runs the
suite for every mutant in it and is dramatically slower.
`.trim();

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) fail(`${error.message}\n\n${USAGE}`);
    throw error;
  }

  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const { target } = options;
  if (!existsSync(target.file)) fail(`Mutate target does not exist: ${target.file}`);
  if (!existsSync(STRYKER_BIN))
    fail(`Stryker is not installed at ${STRYKER_BIN}. Run \`npm install\`.`);

  let tests = options.tests;
  const derived = tests.length === 0;
  if (derived) {
    tests = deriveTestFiles(target.file, collectTestFiles(TEST_ROOT));
    if (tests.length === 0) {
      fail(
        `Could not auto-derive a test file covering ${target.file}.\n` +
          `Pass --tests explicitly, e.g. --tests tests/unit/<area>/<name>.test.ts`,
      );
    }
    const msg = `Auto-derived covering tests: ${tests.join(', ')}\n`;
    // In --json mode stdout must carry only the final JSON payload.
    if (options.json) process.stderr.write(msg);
    else process.stdout.write(msg);
  }

  // A stale report from a previous run would let a crashed Stryker read as a
  // clean pass -- the exact "silent green" failure this command exists to catch.
  rmSync(MUTATION_REPORT_PATH, { force: true });

  const args = [
    STRYKER_BIN,
    'run',
    '--mutate',
    target.spec,
    '--reporters',
    'json,clear-text',
    '--concurrency',
    String(options.concurrency),
  ];
  if (!options.typeCheck) args.push('--checkers', '');

  // In --json mode stdout must be reserved for the final machine-readable
  // payload: route Stryker's own stdout (clear-text reporter + progress) to
  // stderr so callers can reliably parse the JSON without stripping log noise.
  const childStdio = options.json ? ['inherit', 'pipe', 'inherit'] : 'inherit';

  const started = Date.now();
  const run = spawnSync(process.execPath, args, {
    stdio: childStdio,
    env: { ...process.env, STRYKER_TEST_INCLUDE: tests.join(',') },
  });
  // Forward Stryker's captured stdout to our stderr when in --json mode so
  // progress / reporter lines stay visible but don't pollute the JSON stream.
  if (options.json && run.stdout != null && run.stdout.length > 0) {
    process.stderr.write(run.stdout);
  }
  const elapsedSec = Math.round((Date.now() - started) / 1000);

  if (run.error) fail(`Failed to launch Stryker: ${run.error.message}`);

  if (!existsSync(MUTATION_REPORT_PATH)) {
    fail(
      `Stryker exited with code ${run.status} and wrote no report to ${MUTATION_REPORT_PATH}.\n` +
        'Treat this as a failure, not a pass -- no mutant was ever evaluated.',
    );
  }

  let report;
  try {
    report = JSON.parse(readFileSync(MUTATION_REPORT_PATH, 'utf8'));
  } catch (error) {
    fail(`Could not parse ${MUTATION_REPORT_PATH}: ${error.message}`);
  }

  const result = evaluateReport(report, { maxSurvivors: options.maxSurvivors });

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ ...result, elapsedSec, tests, derived, target: target.spec }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(
      `\n${formatSummary(result, { target: target.spec, tests, derived, maxSurvivors: options.maxSurvivors })}\nelapsed: ${elapsedSec}s\n`,
    );
  }

  process.exit(result.ok ? 0 : 1);
}

main();
