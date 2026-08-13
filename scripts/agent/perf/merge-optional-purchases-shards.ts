#!/usr/bin/env node
/**
 * Merge Optional-Purchases Sweep Shards
 *
 * Combines the per-shard JSON files produced by `optional-purchases-sweep.ts`
 * into a single artifact whose `{ runs: RunStats[] }` shape is directly
 * consumable by `fun-score.ts --input`.
 *
 * This script is called by the `aggregate` job in
 * `.github/workflows/optional-purchases-sweep.yml` after all shard artifacts
 * have been downloaded.
 *
 * Usage
 * -----
 *   npx tsx scripts/agent/perf/merge-optional-purchases-shards.ts \
 *     --inputs shards \
 *     --seed-count 100 \
 *     --optional-purchases \
 *     --out optional-purchases-sweep-true.json
 *
 * Prints a summary table to stdout for the GitHub Actions step log.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunStats } from '../../../src/game/ai/types.js';
import { parsePositiveInt } from './winrate-sweep-args.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ShardOutput {
  runAt: string;
  optionalPurchases: boolean;
  seeds: number[];
  maxFrames: number;
  summary: {
    total: number;
    wins: number;
    losses: number;
    timeouts: number;
    winRate: number;
  };
  runs: RunStats[];
}

interface MergedOutput {
  runAt: string;
  optionalPurchases: boolean;
  seedCount: number;
  shardCount: number;
  maxFrames: number;
  summary: {
    total: number;
    wins: number;
    losses: number;
    timeouts: number;
    winRate: number;
  };
  /** Ready for `fun-score.ts --input` (`{ runs: RunStats[] }` format). */
  runs: RunStats[];
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

interface CLIArgs {
  inputs: string;
  seedCount: number;
  optionalPurchases: boolean;
  out: string;
}

function parseArgs(argv: readonly string[]): CLIArgs {
  let inputs: string | undefined;
  let seedCount: number | undefined;
  let optionalPurchases: boolean | undefined;
  let out: string | undefined;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--inputs' && next) {
      inputs = next;
      i++;
    } else if (arg === '--seed-count' && next) {
      seedCount = parsePositiveInt('--seed-count', next);
      i++;
    } else if (arg === '--optional-purchases') {
      optionalPurchases = true;
    } else if (arg === '--no-optional-purchases') {
      optionalPurchases = false;
    } else if (arg === '--out' && next) {
      out = next;
      i++;
    }
  }

  if (
    inputs === undefined ||
    seedCount === undefined ||
    optionalPurchases === undefined ||
    out === undefined
  ) {
    throw new Error(
      'Usage: --inputs <dir> --seed-count <n> (--optional-purchases | --no-optional-purchases) --out <file>',
    );
  }

  return { inputs, seedCount, optionalPurchases, out };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  let args: CLIArgs;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const files = readdirSync(args.inputs)
    .filter((f) => f.endsWith('.json'))
    .sort();

  if (files.length === 0) {
    throw new Error(`No JSON shard files found in ${args.inputs}`);
  }

  const shards = files.map(
    (f) => JSON.parse(readFileSync(join(args.inputs, f), 'utf8')) as ShardOutput,
  );

  // Validate shard consistency
  const maxFrames = shards[0]?.maxFrames ?? 0;
  for (const shard of shards) {
    if (shard.optionalPurchases !== args.optionalPurchases) {
      throw new Error(
        `Shard flag mismatch: expected optionalPurchases=${args.optionalPurchases} ` +
          `but a shard has optionalPurchases=${shard.optionalPurchases}. ` +
          'Mix of true/false shards in one aggregate run is not supported.',
      );
    }
  }

  const allRuns: RunStats[] = shards.flatMap((s) => s.runs);

  if (allRuns.length !== args.seedCount) {
    throw new Error(
      `Expected ${args.seedCount} runs but got ${allRuns.length} across ${files.length} shard(s). ` +
        'A shard may have failed or was skipped — re-run failed shards before merging.',
    );
  }

  // Tally outcomes
  let wins = 0;
  let losses = 0;
  let timeouts = 0;
  for (const run of allRuns) {
    if (run.outcome === 'victory') wins++;
    else if (run.outcome === 'death') losses++;
    else timeouts++;
  }
  const winRate = allRuns.length > 0 ? wins / allRuns.length : 0;
  const summary = { total: allRuns.length, wins, losses, timeouts, winRate };

  // Print summary (visible in GitHub Actions step log and job summary)
  console.log('');
  console.log('━'.repeat(60));
  console.log(`📊 Optional-Purchases Sweep — optionalPurchases=${args.optionalPurchases}`);
  console.log('━'.repeat(60));
  console.log(`Total runs:  ${summary.total}`);
  console.log(`Wins:        ${summary.wins}`);
  console.log(`Losses:      ${summary.losses}`);
  console.log(`Timeouts:    ${summary.timeouts}`);
  console.log(`Win rate:    ${(winRate * 100).toFixed(1)}%`);
  console.log('━'.repeat(60));

  const output: MergedOutput = {
    runAt: new Date().toISOString(),
    optionalPurchases: args.optionalPurchases,
    seedCount: args.seedCount,
    shardCount: files.length,
    maxFrames,
    summary,
    runs: allRuns,
  };

  writeFileSync(args.out, JSON.stringify(output, null, 2));
  console.log(`\n💾 Merged ${files.length} shard(s) → ${args.out} (${allRuns.length} runs)`);
  console.log('    Ready for: npx tsx scripts/agent/health/fun-score.ts --input ' + args.out);
}

try {
  main();
} catch (err) {
  process.stderr.write(
    `merge-optional-purchases-shards failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}
