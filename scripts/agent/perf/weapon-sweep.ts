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
 * and a raw JSON file written under artifacts/weapon-sweeps by default.
 */
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../../src/game/ai/headless-runner.js';
import { scoreRun, type ScoreBreakdown } from '../../../src/game/ai/scoring.js';
import {
  summarizeWeaponRecords,
  type WeaponSweepRecord as RunRecord,
  type WeaponSweepSummary as WeaponSummary,
} from './weapon-sweep-results.js';
import { writeWeaponSweepOutput } from './weapon-sweep-output.js';

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

interface CLIArgs {
  seeds: number[];
  weapons: string[];
  maxFrames: number;
  out?: string;
  weaponPersonas: boolean;
}

const DEFAULT_FLOOR1_WEAPONS = ['sword', 'bow', 'baseball-bat'];
const EXTRA_FLOOR1_WEAPONS = ['pistol', 'throwing-knife', 'fireball'];
const ALLOWED_FLOOR1_WEAPONS = [...DEFAULT_FLOOR1_WEAPONS, ...EXTRA_FLOOR1_WEAPONS];

function parseArgs(): CLIArgs {
  const args: CLIArgs = {
    seeds: [2, 4, 7],
    weapons: DEFAULT_FLOOR1_WEAPONS,
    maxFrames: 19_800, // ~330 s at 60 fps — same budget as the hill-climb baseline
    weaponPersonas: true,
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
    } else if ((arg === '--out' || arg === '--output') && next) {
      args.out = next;
      i++;
    } else if (arg === '--weapon-personas') {
      args.weaponPersonas = true;
    } else if (arg === '--no-weapon-personas') {
      args.weaponPersonas = false;
    }
  }

  const invalidWeapons = args.weapons.filter((weapon) => !ALLOWED_FLOOR1_WEAPONS.includes(weapon));
  if (invalidWeapons.length > 0) {
    throw new Error(
      `Invalid --weapons entries: ${invalidWeapons.join(', ')}. Allowed: ${ALLOWED_FLOOR1_WEAPONS.join(', ')}`,
    );
  }

  return args;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

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
  console.log(`Personas:   ${args.weaponPersonas ? 'enabled' : 'disabled'}`);
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
        weaponPersonas: args.weaponPersonas,
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

    const summary = summarizeWeaponRecords(weapon, records);
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
  const outputRunAt = new Date().toISOString();
  const output = {
    runAt: outputRunAt,
    floors: [1],
    seeds: args.seeds,
    weapons: args.weapons,
    maxFrames: args.maxFrames,
    weaponPersonas: args.weaponPersonas,
    budgetSec: args.maxFrames / 60,
    summaries,
    allRecords,
  };
  const outputPath = writeWeaponSweepOutput(output, args.out);
  console.log(`\n💾 Raw data written to: ${outputPath}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const args = parseArgs();
sweep(args).catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
