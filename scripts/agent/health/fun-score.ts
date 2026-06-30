#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { normalizeFunSessions, parseFunScoreArgs, scoreFunSessions } from './fun-score-lib.js';

function main(): void {
  const args = parseFunScoreArgs(process.argv);
  const raw = readFileSync(args.inputPath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  const sessions = normalizeFunSessions(parsed);
  const report = scoreFunSessions(sessions, {
    minOverall: args.minOverall,
    minDimension: args.minDimension,
  });

  const output = JSON.stringify(report, null, 2);
  process.stdout.write(`${output}\n`);
  if (args.outputPath) {
    writeFileSync(args.outputPath, `${output}\n`);
  }
  if (!report.gate.pass) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `fun-score failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(2);
}
