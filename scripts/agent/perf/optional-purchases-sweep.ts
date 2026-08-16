#!/usr/bin/env node
/**
 * Optional-Purchases A/B Sweep
 *
 * Runs one headless AI game per seed with the `optionalPurchases` flag set to
 * the requested value and writes a JSON artifact consumable by
 * `fun-score.ts --input`.
 *
 * This is the per-shard worker script invoked by the
 * `.github/workflows/optional-purchases-sweep.yml` workflow.  A GitHub Actions
 * run shards seeds across 4 parallel runners and then merges the results with
 * `merge-optional-purchases-shards.ts`.
 *
 * Usage
 * -----
 *   npx tsx scripts/agent/perf/optional-purchases-sweep.ts \
 *     --seeds 1-25 \
 *     --optional-purchases \
 *     --max-frames 23760 \
 *     --out shard-0.json
 *
 * Output shape (compatible with `fun-score.ts --input`)
 * -------------------------------------------------------
 *   {
 *     "runAt": "<ISO timestamp>",
 *     "optionalPurchases": <bool>,
 *     "seeds": [<number>, …],
 *     "maxFrames": <number>,
 *     "summary": { "total": N, "wins": W, "losses": L, "timeouts": T, "winRate": 0.N },
 *     "runs": [ <RunStats>, … ]   ← `{ runs: RunStats[] }` accepted by fun-score
 *   }
 */
import { writeFileSync } from 'node:fs';
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../../src/game/ai/headless-runner.js';
import type { RunStats } from '../../../src/game/ai/types.js';
import { formatGoldEconomySummary, summarizeGoldEconomy } from './gold-economy-summary.js';
import { parseOptionalPurchasesSweepArgs } from './optional-purchases-sweep-args.js';

async function main(): Promise<void> {
  let args;
  try {
    args = parseOptionalPurchasesSweepArgs(process.argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const seedRange =
    args.seeds.length === 1
      ? String(args.seeds[0])
      : `${args.seeds[0]}…${args.seeds[args.seeds.length - 1]} (${args.seeds.length})`;

  console.log('🛒 Optional-Purchases Headless Sweep');
  console.log('━'.repeat(60));
  console.log(`Seeds:            ${seedRange}`);
  console.log(`optionalPurchases: ${args.optionalPurchases ? 'enabled' : 'disabled'}`);
  console.log(`Frame budget:     ${args.maxFrames} frames (~${(args.maxFrames / 60).toFixed(0)}s)`);
  console.log('');

  const runs: RunStats[] = [];
  let wins = 0;
  let losses = 0;
  let timeouts = 0;

  for (const seed of args.seeds) {
    process.stdout.write(`  seed ${String(seed).padStart(3)} … `);

    const ai = new BehaviorTreeAI({ seed });
    const stats = await runHeadless(ai, {
      seed,
      maxFrames: args.maxFrames,
      optionalPurchases: args.optionalPurchases,
    });

    runs.push(stats);

    let marker: string;
    if (stats.outcome === 'victory') {
      wins++;
      marker = '✅';
    } else if (stats.outcome === 'death') {
      losses++;
      marker = '💀';
    } else {
      timeouts++;
      marker = '⏱️ ';
    }

    process.stdout.write(
      `${marker} ${stats.outcome.padEnd(8)} t=${(stats.gameTimeMs / 1000).toFixed(0)}s` +
        ` lv=${stats.finalLevel} kills=${stats.combat.totalKills}\n`,
    );
  }

  const total = runs.length;
  const winRate = total > 0 ? wins / total : 0;
  const summary = { total, wins, losses, timeouts, winRate };
  const goldEconomy = summarizeGoldEconomy(runs);

  console.log('');
  console.log('━'.repeat(60));
  console.log(
    `Total: ${total}  Wins: ${wins}  Losses: ${losses}  Timeouts: ${timeouts}  WinRate: ${(winRate * 100).toFixed(1)}%`,
  );
  for (const line of formatGoldEconomySummary(goldEconomy)) {
    console.log(line);
  }

  if (args.out) {
    const output = {
      runAt: new Date().toISOString(),
      optionalPurchases: args.optionalPurchases,
      seeds: args.seeds,
      maxFrames: args.maxFrames,
      summary,
      goldEconomy,
      runs,
    };
    writeFileSync(args.out, JSON.stringify(output, null, 2));
    console.log(`\n💾 Written to ${args.out}`);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
