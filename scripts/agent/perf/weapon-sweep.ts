#!/usr/bin/env node
/**
 * Weapon-Sweep Balance Tool
 *
 * Runs at least 3 seeds for each Floor 1 starting weapon and prints a
 * comparative table.  Use this to check whether weapon type is a confound
 * in win/loss outcomes before attributing losses to AI behaviour or map layout.
 *
 * Usage
 * -----
 *   npm run ai:weapon-sweep
 *   npm run ai:weapon-sweep -- --seeds 2,4,7,8,10 --max-frames 19800
 *   npm run ai:weapon-sweep -- --weapons sword,bow --seeds 1,2,3,4,5
 *
 * Output
 * ------
 * A per-weapon summary table (win rate, mean game time, mean level, kills)
 * and a raw JSON file written to --out (default: /tmp/weapon-sweep.json).
 */
import { writeFileSync } from 'node:fs';
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../../src/game/ai/headless-runner.js';
import { scoreRun, type ScoreBreakdown } from '../../../src/game/ai/scoring.js';
import type { RunStats } from '../../../src/game/ai/types.js';

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

interface CLIArgs {
  seeds: number[];
  weapons: string[];
  maxFrames: number;
  out: string;
}

const FLOOR1_WEAPONS = ['sword', 'bow', 'baseball-bat'];

function parseArgs(): CLIArgs {
  const args: CLIArgs = {
    seeds: [2, 4, 7],
    weapons: FLOOR1_WEAPONS,
    maxFrames: 19_800, // ~330 s at 60 fps — same budget as the hill-climb baseline
    out: '/tmp/weapon-sweep.json',
  };

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    const next = process.argv[i + 1];
    if (arg === '--seeds' && next) {
      args.seeds = next.split(',').map(Number);
      i++;
    } else if (arg === '--weapons' && next) {
      args.weapons = next.split(',');
      i++;
    } else if (arg === '--max-frames' && next) {
      args.maxFrames = parseInt(next, 10);
      i++;
    } else if (arg === '--out' && next) {
      args.out = next;
      i++;
    }
  }

  return args;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface RunRecord {
  weapon: string;
  seed: number;
  outcome: RunStats['outcome'];
  gameTimeSec: number;
  finalLevel: number;
  totalKills: number;
  totalXp: number;
  totalGold: number;
  score: number;
  minHealthPct: number;
  closeCallCount: number;
  questsCompleted: number;
}

interface WeaponSummary {
  weapon: string;
  runs: number;
  victories: number;
  winRate: number;
  meanGameTimeSec: number;
  meanLevel: number;
  meanKills: number;
  meanXp: number;
  meanScore: number;
  meanMinHealthPct: number;
  meanCloseCallCount: number;
  meanQuestsCompleted: number;
  records: RunRecord[];
}

// ---------------------------------------------------------------------------
// Core sweep
// ---------------------------------------------------------------------------

async function sweep(args: CLIArgs): Promise<void> {
  const startTime = Date.now();
  const maxGameTimeMs = args.maxFrames * (1000 / 60);

  console.log('🗡️  Weapon Sweep Balance Check');
  console.log('━'.repeat(70));
  console.log(`Seeds:      ${args.seeds.join(', ')}`);
  console.log(`Weapons:    ${args.weapons.join(', ')}`);
  console.log(`Budget:     ${args.maxFrames} frames (~${(args.maxFrames / 60).toFixed(0)}s)`);
  console.log(`Total runs: ${args.seeds.length * args.weapons.length}`);
  console.log('');

  const allRecords: RunRecord[] = [];
  const summaries: WeaponSummary[] = [];

  for (const weapon of args.weapons) {
    console.log(`⚔️  ${weapon.toUpperCase()}`);
    const records: RunRecord[] = [];

    for (const seed of args.seeds) {
      process.stdout.write(`   seed ${seed} … `);
      const ai = new BehaviorTreeAI({ seed });
      const stats = await runHeadless(ai, {
        seed,
        maxFrames: args.maxFrames,
        forceWeaponId: weapon,
      });
      const bd: ScoreBreakdown = scoreRun(stats, maxGameTimeMs);
      const rec: RunRecord = {
        weapon,
        seed,
        outcome: stats.outcome,
        gameTimeSec: stats.gameTimeMs / 1000,
        finalLevel: stats.finalLevel,
        totalKills: stats.combat.totalKills,
        totalXp: stats.totalXp,
        totalGold: stats.totalGold,
        score: bd.score,
        minHealthPct: stats.health.minHealthPercent,
        closeCallCount: stats.health.closeCallCount,
        questsCompleted: stats.quests.questsCompleted,
      };
      records.push(rec);
      allRecords.push(rec);

      const marker = stats.outcome === 'victory' ? '✅' : stats.outcome === 'death' ? '💀' : '⏱️ ';
      console.log(
        `${marker} ${stats.outcome.padEnd(8)} t=${rec.gameTimeSec.toFixed(0)}s` +
          ` lv=${rec.finalLevel} kills=${rec.totalKills} score=${rec.score.toFixed(0)}`,
      );
    }

    const victories = records.filter((r) => r.outcome === 'victory').length;
    const mean = (vals: number[]): number => vals.reduce((a, b) => a + b, 0) / vals.length;

    const summary: WeaponSummary = {
      weapon,
      runs: records.length,
      victories,
      winRate: victories / records.length,
      meanGameTimeSec: mean(records.map((r) => r.gameTimeSec)),
      meanLevel: mean(records.map((r) => r.finalLevel)),
      meanKills: mean(records.map((r) => r.totalKills)),
      meanXp: mean(records.map((r) => r.totalXp)),
      meanScore: mean(records.map((r) => r.score)),
      meanMinHealthPct: mean(records.map((r) => r.minHealthPct)),
      meanCloseCallCount: mean(records.map((r) => r.closeCallCount)),
      meanQuestsCompleted: mean(records.map((r) => r.questsCompleted)),
      records,
    };
    summaries.push(summary);
    console.log('');
  }

  // ---------------------------------------------------------------------------
  // Print comparison table
  // ---------------------------------------------------------------------------
  const wallSec = (Date.now() - startTime) / 1000;

  console.log('━'.repeat(70));
  console.log('📊 Weapon Comparison Table');
  console.log('━'.repeat(70));
  const header =
    'Weapon'.padEnd(15) +
    'W/L'.padEnd(8) +
    'WinRate'.padEnd(10) +
    'AvgTime'.padEnd(10) +
    'AvgLv'.padEnd(8) +
    'AvgKills'.padEnd(10) +
    'AvgScore';
  console.log(header);
  console.log('─'.repeat(70));

  for (const s of summaries) {
    const wl = `${s.victories}/${s.runs - s.victories}`;
    console.log(
      s.weapon.padEnd(15) +
        wl.padEnd(8) +
        `${(s.winRate * 100).toFixed(0)}%`.padEnd(10) +
        `${s.meanGameTimeSec.toFixed(0)}s`.padEnd(10) +
        s.meanLevel.toFixed(1).padEnd(8) +
        s.meanKills.toFixed(1).padEnd(10) +
        s.meanScore.toFixed(0),
    );
  }

  console.log('');
  console.log('Extra metrics:');
  console.log(
    'Weapon'.padEnd(15) + 'AvgMinHP'.padEnd(12) + 'AvgCloseCall'.padEnd(15) + 'AvgQuests',
  );
  console.log('─'.repeat(55));
  for (const s of summaries) {
    console.log(
      s.weapon.padEnd(15) +
        `${(s.meanMinHealthPct * 100).toFixed(1)}%`.padEnd(12) +
        s.meanCloseCallCount.toFixed(1).padEnd(15) +
        s.meanQuestsCompleted.toFixed(1),
    );
  }

  console.log('');
  console.log(`Total sweep time: ${wallSec.toFixed(1)}s`);

  // ---------------------------------------------------------------------------
  // Write JSON output
  // ---------------------------------------------------------------------------
  const output = {
    runAt: new Date().toISOString(),
    seeds: args.seeds,
    weapons: args.weapons,
    maxFrames: args.maxFrames,
    budgetSec: args.maxFrames / 60,
    summaries,
    allRecords,
  };
  writeFileSync(args.out, JSON.stringify(output, null, 2));
  console.log(`\n💾 Raw data written to: ${args.out}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const args = parseArgs();
sweep(args).catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
