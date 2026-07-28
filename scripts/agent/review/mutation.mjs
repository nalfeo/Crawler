// Scoped mutation-proof library.
//
// Purpose: prove that a test you just wrote can actually FAIL. The repo has
// accumulated a documented class of "vacuous" tests -- tests that pass without
// exercising the behaviour they name (see
// `.github/skills/perf-optimizer/references/measurement-recipes.md`). A test
// that cannot fail is indistinguishable from a passing one by looking at test
// output alone, so the only reliable detector is to break the source on purpose
// and confirm the suite notices.
//
// This module holds the pure logic (argument parsing, test-file resolution,
// report evaluation) so it can be unit-tested without invoking Stryker. The
// thin process wrapper lives in `mutation-cli.mjs`.
//
// PERFORMANCE NOTE (this is the whole design):
// Stryker re-runs its configured test suite once per mutant. Pointed at the
// full 1102-test unit suite, a single file took >82 minutes and never finished.
// Narrowed to just the test file(s) covering the target, the same mutant set
// completes in ~38 seconds -- Stryker's `perTest` coverage analysis only pays
// off once the suite is small enough for it to matter. So resolving a TIGHT set
// of covering tests is not an optimisation detail; it is the difference between
// a usable command and an unusable one.

import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';

/** Directory scanned when auto-deriving covering test files. */
export const TEST_ROOT = 'tests';

/** Where the Stryker json reporter is configured to write (stryker.config.json). */
export const MUTATION_REPORT_PATH = path.join('reports', 'mutation', 'mutation.json');

/** Mutant statuses Stryker considers "detected" (i.e. the suite noticed). */
const DETECTED = new Set(['Killed', 'Timeout']);
/** Statuses meaning the mutant survived a suite that was supposed to catch it. */
const UNDETECTED = new Set(['Survived', 'NoCoverage']);
/** Statuses meaning the mutant never produced a usable verdict. */
const INVALID = new Set(['CompileError', 'RuntimeError']);

const SOURCE_EXT_BODY = '\\.[cm]?[jt]sx?';
const SOURCE_EXT = new RegExp(`${SOURCE_EXT_BODY}$`);

export class UsageError extends Error {}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Split a mutate target into its file and optional inclusive line range.
 *
 * Accepts `src/a.ts` and `src/a.ts:10-40`. Windows absolute paths contain a
 * drive-letter colon, so the range suffix is only honoured when it actually
 * looks like `<digits>-<digits>`.
 */
export function parseTarget(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new UsageError('A mutate target is required, e.g. src/core/map/astar-grid.ts:295-335');
  }
  const value = raw.trim();
  const colon = value.lastIndexOf(':');
  if (colon > 0) {
    const suffix = value.slice(colon + 1);
    const match = /^(\d+)-(\d+)$/.exec(suffix);
    if (match) {
      const start = Number(match[1]);
      const end = Number(match[2]);
      if (start < 1) throw new UsageError(`Line range must start at 1 or later: ${suffix}`);
      if (end < start) throw new UsageError(`Line range end must not precede its start: ${suffix}`);
      return { file: value.slice(0, colon), startLine: start, endLine: end, spec: value };
    }
  }
  return { file: value, startLine: null, endLine: null, spec: value };
}

/** Parse CLI argv (excluding node + script). */
export function parseArgs(argv) {
  const options = {
    target: null,
    tests: [],
    maxSurvivors: 0,
    typeCheck: false,
    concurrency: 4,
    json: false,
    help: false,
  };
  const rest = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takeValue = (name) => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new UsageError(`${name} requires a value`);
      }
      i += 1;
      return next;
    };

    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--type-check') options.typeCheck = true;
    else if (arg === '--tests') {
      options.tests.push(
        ...takeValue('--tests')
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean),
      );
    } else if (arg === '--max-survivors') {
      const value = Number(takeValue('--max-survivors'));
      if (!Number.isInteger(value) || value < 0) {
        throw new UsageError('--max-survivors requires a non-negative integer');
      }
      options.maxSurvivors = value;
    } else if (arg === '--concurrency') {
      const value = Number(takeValue('--concurrency'));
      if (!Number.isInteger(value) || value < 1) {
        throw new UsageError('--concurrency requires a positive integer');
      }
      options.concurrency = value;
    } else if (arg.startsWith('--')) {
      throw new UsageError(`Unknown option: ${arg}`);
    } else rest.push(arg);
  }

  if (options.help) return options;
  if (rest.length === 0) {
    throw new UsageError('A mutate target is required, e.g. src/core/map/astar-grid.ts:295-335');
  }
  if (rest.length > 1) {
    throw new UsageError(
      `Expected a single mutate target, received ${rest.length}: ${rest.join(' ')}`,
    );
  }
  options.target = parseTarget(rest[0]);
  return options;
}

/**
 * Recursively list test files under `root`, returning POSIX-style paths.
 *
 * Uses `lstat` rather than `stat` so directory symlinks are not traversed: a
 * symlink cycle under `tests/` would otherwise recurse to a stack overflow. A
 * skipped symlinked directory can only ever cause auto-derivation to find fewer
 * tests, which fails loudly ("could not auto-derive"), never silently green.
 */
export function collectTestFiles(root, deps = {}) {
  const readdir = deps.readdirSync ?? readdirSync;
  const stat = deps.lstatSync ?? lstatSync;
  const found = [];

  const walk = (dir) => {
    let entries;
    try {
      entries = readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules') continue;
      const full = path.join(dir, entry);
      let info;
      try {
        info = stat(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) walk(full);
      else if (/\.(test|spec)\.[cm]?ts$/.test(entry)) found.push(full.split(path.sep).join('/'));
    }
  };

  walk(root);
  return found.sort();
}

/**
 * Best-effort auto-derivation of the test files covering `targetFile`.
 *
 * Deliberately conservative: it matches an import specifier ending in the
 * target's basename. A barrel re-export will not match, which is exactly why
 * `--tests` exists and why `evaluateReport` hard-fails on NoCoverage mutants --
 * a bad derivation must surface as a loud failure, never as a clean score.
 */
export function deriveTestFiles(targetFile, testFiles, deps = {}) {
  const read = deps.readFileSync ?? ((file) => readFileSync(file, 'utf8'));
  const base = path.basename(targetFile).replace(SOURCE_EXT, '');
  if (!base) return [];
  const needle = new RegExp(`[/'"\`]${escapeRegExp(base)}(${SOURCE_EXT_BODY})?['"\`]`);
  return testFiles.filter((file) => {
    try {
      return needle.test(read(file));
    } catch {
      return false;
    }
  });
}

/**
 * Tally a Stryker json report into a pass/fail verdict.
 *
 * Exit-worthy failures, in the order they are reported:
 *  - no mutants at all (the run proved nothing)
 *  - NoCoverage mutants (the chosen tests do not exercise the target -- the
 *    vacuity failure this command exists to catch, one level up)
 *  - CompileError/RuntimeError mutants (no verdict was produced)
 *  - survivors above `maxSurvivors` (a real gap in the tests)
 */
export function evaluateReport(report, options = {}) {
  const maxSurvivors = options.maxSurvivors ?? 0;
  const counts = { killed: 0, timeout: 0, survived: 0, noCoverage: 0, invalid: 0, ignored: 0 };
  const survivors = [];
  const uncovered = [];

  const files = report && typeof report === 'object' ? (report.files ?? {}) : {};
  for (const [file, entry] of Object.entries(files)) {
    for (const mutant of entry?.mutants ?? []) {
      const status = mutant?.status;
      const where = `${file}:${mutant?.location?.start?.line ?? '?'}`;
      const label = `${mutant?.mutatorName ?? 'Mutant'} at ${where}`;
      if (DETECTED.has(status)) {
        if (status === 'Killed') counts.killed += 1;
        else counts.timeout += 1;
      } else if (UNDETECTED.has(status)) {
        if (status === 'Survived') {
          counts.survived += 1;
          survivors.push(label);
        } else {
          counts.noCoverage += 1;
          uncovered.push(label);
        }
      } else if (INVALID.has(status)) counts.invalid += 1;
      else if (status === 'Ignored') counts.ignored += 1;
    }
  }

  const detected = counts.killed + counts.timeout;
  const undetected = counts.survived + counts.noCoverage;
  const valid = detected + undetected;
  const total = valid + counts.invalid + counts.ignored;
  const score = valid === 0 ? null : (detected / valid) * 100;

  const failures = [];
  // `valid`, not `total`: Ignored/errored mutants inflate `total` without ever
  // producing a verdict, so a report of nothing but ignored mutants would
  // otherwise print PASS having proven nothing -- the exact silent-green failure
  // this command exists to catch.
  if (valid === 0) {
    failures.push(
      total === 0
        ? 'No mutants were generated. The run proved nothing -- check the target path and line range.'
        : `All ${total} mutant(s) were ignored or errored, so not one produced a usable verdict. The run ` +
            'proved nothing -- check for `// Stryker disable` comments or excluded mutators in range.',
    );
  }
  // Separate check from `valid === 0`: even in a mixed report (e.g. Killed +
  // Ignored), the Ignored mutants were never applied, so a range containing
  // `// Stryker disable` comments can silently escape coverage.  Fail loudly
  // regardless of how many other mutants were killed.
  if (counts.ignored > 0) {
    failures.push(
      `${counts.ignored} mutant(s) were IGNORED and never applied. The run may cover only part of the ` +
        'target -- check for `// Stryker disable` comments or excluded mutators in range.',
    );
  }
  if (counts.noCoverage > 0) {
    failures.push(
      `${counts.noCoverage} mutant(s) had NO COVERAGE: the selected tests never execute this code, so a green run here would be meaningless. First: ${uncovered[0]}`,
    );
  }
  if (counts.invalid > 0) {
    failures.push(
      `${counts.invalid} mutant(s) produced no verdict (compile/runtime error) and cannot count as killed.`,
    );
  }
  if (counts.survived > maxSurvivors) {
    failures.push(
      `${counts.survived} mutant(s) SURVIVED (allowed ${maxSurvivors}): the tests pass with the source deliberately broken. First: ${survivors[0]}`,
    );
  }

  return {
    counts,
    detected,
    undetected,
    valid,
    total,
    score,
    survivors,
    uncovered,
    failures,
    ok: failures.length === 0,
  };
}

/** Render a short human summary of an `evaluateReport` result. */
export function formatSummary(result, context = {}) {
  const { counts, score } = result;
  const maxSurvivors = context.maxSurvivors ?? 0;
  const lines = [];
  if (context.target) lines.push(`target: ${context.target}`);
  if (context.tests?.length) {
    lines.push(`tests:  ${context.tests.join(', ')}${context.derived ? '  (auto-derived)' : ''}`);
  }
  lines.push(
    `mutants: ${result.total} total | ${counts.killed} killed | ${counts.timeout} timeout | ` +
      `${counts.survived} survived | ${counts.noCoverage} no-coverage | ${counts.invalid} invalid | ` +
      `${counts.ignored} ignored`,
  );
  lines.push(`score:   ${score === null ? 'n/a' : `${score.toFixed(2)}%`}`);
  if (result.ok) {
    const passMsg =
      maxSurvivors > 0
        ? `PASS: within the configured survivor tolerance (≤${maxSurvivors} surviving mutant(s) allowed).`
        : 'PASS: every mutant in scope was detected by the selected tests.';
    lines.push(passMsg);
  } else {
    lines.push('FAIL:');
    for (const failure of result.failures) lines.push(`  - ${failure}`);
    if (result.survivors.length > 1) {
      lines.push('  surviving mutants:');
      for (const survivor of result.survivors) lines.push(`    * ${survivor}`);
    }
  }
  return lines.join('\n');
}
