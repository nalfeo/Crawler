#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_OUTPUT_BUDGET,
  renderHandoffResults,
  retrieveHandoffs,
} from './handoff-retrieval.mjs';

function parseArgs(argv) {
  const budgetAt = argv.indexOf('--budget');
  const requestedBudget = budgetAt >= 0 ? Number(argv[budgetAt + 1]) : DEFAULT_OUTPUT_BUDGET;
  const queryParts = argv.filter(
    (value, index) => value !== '--' && value !== '--budget' && index !== budgetAt + 1,
  );
  return {
    query: queryParts.join(' ').trim(),
    budget: Number.isFinite(requestedBudget) ? requestedBudget : DEFAULT_OUTPUT_BUDGET,
  };
}

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
}

function main() {
  const { query, budget } = parseArgs(process.argv.slice(2));
  if (!query) {
    process.stderr.write('Usage: npm run handoffs:find -- <system-or-topic> [--budget <1-2000>]\n');
    process.exitCode = 2;
    return;
  }
  const root = repoRoot();
  const index = readFileSync(path.join(root, 'docs/knowledge/handoffs/INDEX.md'), 'utf8');
  const candidates = retrieveHandoffs(index, query, new Map()).slice(0, 10);
  const contents = new Map();
  for (const entry of candidates) {
    const absolute = path.join(root, entry.path);
    if (existsSync(absolute)) contents.set(entry.path, readFileSync(absolute, 'utf8'));
  }
  const refreshed = new Map(
    retrieveHandoffs(index, query, contents).map((entry) => [entry.path, entry]),
  );
  const results = candidates.map((entry) => refreshed.get(entry.path) ?? entry);
  process.stdout.write(`${renderHandoffResults(query, results, budget)}\n`);
}

main();
