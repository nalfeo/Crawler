/**
 * Fixture script for the JudgeBudget concurrency test.
 *
 * Usage: tsx judge-budget-worker.ts <stateFile> <callCount>
 *
 * Records `callCount` judge calls on the JudgeBudget pointed at
 * `stateFile`. Each call uses a fixed small usage record so the
 * expected total cost is deterministic.
 *
 * Run concurrently from two processes to verify that file-locked
 * read-modify-write accumulates all deltas correctly.
 */

import { JudgeBudget } from '../../../../scripts/sprites/cost-tracker.js';

const stateFile = process.argv[2];
const callCount = parseInt(process.argv[3] ?? '0', 10);

if (!stateFile || isNaN(callCount)) {
  process.stderr.write('Usage: judge-budget-worker.ts <stateFile> <callCount>\n');
  process.exit(1);
}

const budget = new JudgeBudget({
  budgetUsd: Infinity,
  modelDeployment: 'gpt-4o-mini',
  stateFile,
});

for (let i = 0; i < callCount; i++) {
  // 100 prompt + 50 completion @ gpt-4o-mini ($0.15/M in, $0.60/M out):
  // cost = 100 * 0.15/1e6 + 50 * 0.60/1e6 = $0.000015 + $0.000030 = $0.000045
  await budget.recordCall({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
}
