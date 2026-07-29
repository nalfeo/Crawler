/**
 * CLI for the set-piece composition gate.
 *
 *   npm run setpiece:score                 # score every set piece
 *   npm run setpiece:score -- <id> [<id>]  # score specific set pieces
 *   npm run setpiece:score -- --json       # machine-readable report
 *   npm run setpiece:score -- --fail-on-violation   # exit 1 when any check fails
 *
 * Read-only. Never mutates set-piece data.
 */
import {
  getAllSetPieceDefs,
  getSetPieceDef,
  type SetPieceDef,
} from '../../../src/shared/set-piece-types.js';
import { DEFAULT_THRESHOLDS, scoreSetPiece, type CompositionReport } from './composition-score.js';

interface CliOptions {
  readonly ids: readonly string[];
  readonly json: boolean;
  readonly failOnViolation: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const ids: string[] = [];
  let json = false;
  let failOnViolation = false;
  for (const arg of argv) {
    if (arg === '--json') json = true;
    else if (arg === '--fail-on-violation') failOnViolation = true;
    else if (!arg.startsWith('--')) ids.push(arg);
  }
  return { ids, json, failOnViolation };
}

function resolveDefs(ids: readonly string[]): SetPieceDef[] {
  if (ids.length === 0) return getAllSetPieceDefs();
  const defs: SetPieceDef[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const def = getSetPieceDef(id);
    if (def) defs.push(def);
    else missing.push(id);
  }
  if (missing.length > 0) {
    console.error(`Unknown set piece id(s): ${missing.join(', ')}`);
    const known = getAllSetPieceDefs()
      .map((d) => d.id)
      .join(', ');
    console.error(`Known ids: ${known}`);
    process.exit(2);
  }
  return defs;
}

function printReport(report: CompositionReport): void {
  const status = report.passed ? '\u2705 PASS' : '\u274c FAIL';
  console.log(
    `\n${status}  ${report.setPieceId}  (${report.width}x${report.height} tiles)  ` +
      `${report.passedCount}/${report.totalCount} checks`,
  );
  for (const check of report.checks) {
    const mark = check.pass ? '  \u2713' : '  \u2717';
    console.log(`${mark} ${check.label}`);
    console.log(`      ${check.detail}`);
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const defs = resolveDefs(options.ids);
  const reports = defs.map((def) => scoreSetPiece(def, DEFAULT_THRESHOLDS));

  if (options.json) {
    console.log(JSON.stringify({ thresholds: DEFAULT_THRESHOLDS, reports }, null, 2));
  } else {
    for (const report of reports) printReport(report);
    const passing = reports.filter((r) => r.passed).length;
    console.log(`\n${'-'.repeat(60)}`);
    console.log(`${passing}/${reports.length} set pieces pass the composition gate.`);
    if (passing < reports.length) {
      console.log('Failing pieces need a dressing pass (see `set-piece-dress` skill).');
    }
  }

  if (options.failOnViolation && reports.some((r) => !r.passed)) process.exit(1);
}

main();
