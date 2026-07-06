#!/usr/bin/env node
/**
 * Floor 1 win-RATE sweep.
 *
 * Drives the same pure-ECS `runHeadless` + `BehaviorTreeAI` pipeline the gate
 * uses, across a large seed range × all three Floor-1 starter weapons, and
 * reports the aggregate WIN RATE plus a per-failure diagnostic (outcome,
 * game-time, level, kills, stall reason, dominant wasted-time state). This is
 * the deterministic instrument behind the "90%+ of Floor 1 seeds win" rule:
 * it gates on the *rate* over a representative sample, never on a hand-picked
 * set of comfortable seeds.
 *
 * Usage
 * -----
 *   npm run ai:winrate-sweep                       # seeds 1-40 × {sword,bow,bat}
 *   npm run ai:winrate-sweep -- --seeds 1-60       # range
 *   npm run ai:winrate-sweep -- --weapons sword    # one weapon
 *   npm run ai:winrate-sweep -- --max-frames 21600 --out files/sweep.json
 *   npm run ai:winrate-sweep -- --workers 8 --skip-events
 *
 * A failing seed runs to the budget, so a sweep over many seeds with many
 * failures is slow; that is expected — correctness, not speed, is the point.
 */
import { writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../../src/game/ai/headless-runner.js';
import { summarizeEvents, type SimEvent } from '../../../src/game/ai/event-log.js';
import type { RunStats } from '../../../src/game/ai/types.js';
import {
  runWorkerPool,
  type WorkerPoolTaskPayload,
  type WorkerTaskFailure,
  type WorkerTaskSuccess,
} from './worker-pool.js';

const FLOOR1_WEAPONS = ['sword', 'bow', 'baseball-bat'];
/** Floor 1 design budget: 6 minutes of game time at 60 fps. */
const BUDGET_FRAMES = 21_600;

interface CLIArgs {
  seeds: number[];
  weapons: string[];
  maxFrames: number;
  out: string | null;
  enemyDamageMultiplier: number;
  floorId: string;
  workers: number;
  skipEvents: boolean;
}

function parseSeeds(spec: string): number[] {
  const seeds: number[] = [];
  for (const part of spec.split(',')) {
    const range = part.split('-');
    if (range.length === 2) {
      const lo = parseInt(range[0]!, 10);
      const hi = parseInt(range[1]!, 10);
      for (let s = lo; s <= hi; s++) seeds.push(s);
    } else {
      seeds.push(parseInt(part, 10));
    }
  }
  return seeds;
}

function parseArgs(): CLIArgs {
  let weaponsProvided = false;
  let workersProvided = false;
  const args: CLIArgs = {
    seeds: Array.from({ length: 40 }, (_, i) => i + 1),
    weapons: FLOOR1_WEAPONS,
    maxFrames: BUDGET_FRAMES,
    out: null,
    enemyDamageMultiplier: 1,
    floorId: 'floor1',
    workers: 1,
    skipEvents: false,
  };
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    const next = process.argv[i + 1];
    if (arg === '--seeds' && next) {
      args.seeds = parseSeeds(next);
      i++;
    } else if (arg === '--weapons' && next) {
      args.weapons = next.split(',');
      weaponsProvided = true;
      i++;
    } else if (arg === '--max-frames' && next) {
      args.maxFrames = parseInt(next, 10);
      i++;
    } else if (arg === '--out' && next) {
      args.out = next;
      i++;
    } else if (arg === '--enemy-damage-multiplier' && next) {
      args.enemyDamageMultiplier = parseFloat(next);
      i++;
    } else if (arg === '--floor' && next) {
      args.floorId = next;
      i++;
    } else if (arg === '--workers' && next) {
      args.workers = Math.max(1, parseInt(next, 10));
      workersProvided = true;
      i++;
    } else if (arg === '--skip-events') {
      args.skipEvents = true;
    }
  }
  if (
    args.floorId === 'floor2' &&
    !weaponsProvided &&
    args.weapons.length === FLOOR1_WEAPONS.length
  ) {
    args.weapons = ['sword'];
  }
  if (!workersProvided) {
    args.workers = Math.max(
      1,
      Math.min(availableParallelism(), args.seeds.length * args.weapons.length),
    );
  }
  return args;
}

interface SweepTask {
  weapon: string;
  seed: number;
}

interface SweepSharedConfig {
  maxFrames: number;
  enemyDamageMultiplier: number;
  floorId: string;
  skipEvents: boolean;
}

interface SweepTaskResult {
  task: SweepTask;
  stats: RunStats;
  failRecord: FailRecord | null;
}

async function runSweepTask(task: SweepTask, config: SweepSharedConfig): Promise<SweepTaskResult> {
  const ai = new BehaviorTreeAI({ seed: task.seed });
  const events: SimEvent[] = [];
  const stats = await runHeadless(ai, {
    seed: task.seed,
    maxFrames: config.maxFrames,
    forceWeaponId: task.weapon,
    enemyDamageMultiplier: config.enemyDamageMultiplier,
    eventSampleInterval: 60,
    floorId: config.floorId,
    ...(config.skipEvents
      ? {}
      : {
          recordEvent: (event: SimEvent): void => {
            events.push(event);
          },
        }),
  });
  let failRecord: FailRecord | null = null;
  if (stats.outcome !== 'victory') {
    const sum = config.skipEvents ? null : summarizeEvents(events);
    const dom = sum ? Object.entries(sum.statePct).sort((a, b) => b[1] - a[1])[0] : null;
    const wig = sum?.wiggleEpisodes[0];
    failRecord = {
      weapon: task.weapon,
      seed: task.seed,
      outcome: stats.outcome,
      gameTimeSec: Math.round(stats.gameTimeMs / 1000),
      level: stats.finalLevel,
      kills: stats.combat.totalKills,
      dominantState: dom ? `${dom[0]} ${dom[1]}%` : 'n/a',
      worstWiggle:
        wig !== undefined
          ? `${(wig.durationMs / 1000).toFixed(0)}s@(${wig.px},${wig.py})`
          : config.skipEvents
            ? 'n/a'
            : '—',
      stall: stats.stallReason ?? '',
    };
  }
  return { task, stats, failRecord };
}

interface FailRecord {
  weapon: string;
  seed: number;
  outcome: RunStats['outcome'];
  gameTimeSec: number;
  level: number;
  kills: number;
  dominantState: string;
  worstWiggle: string;
  stall: string;
}

/** Per-run metrics captured for every run (win or loss) so we can report the
 * quality of a clear — the user's real goals: max XP/loot, min damage taken. */
interface RunMetric {
  weapon: string;
  seed: number;
  win: boolean;
  gameTimeSec: number;
  damageTaken: number;
  damageTakenPerSec: number;
  xp: number;
  gold: number;
  kills: number;
  minHealthPercent: number;
  finalHealthPercent: number;
}

function mean(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function aggregateOf(rows: RunMetric[]): Record<string, number> {
  return {
    n: rows.length,
    damageTakenPerSec: mean(rows.map((r) => r.damageTakenPerSec)),
    damageTaken: mean(rows.map((r) => r.damageTaken)),
    xp: mean(rows.map((r) => r.xp)),
    gold: mean(rows.map((r) => r.gold)),
    kills: mean(rows.map((r) => r.kills)),
    minHealthPercent: mean(rows.map((r) => r.minHealthPercent)),
    gameTimeSec: mean(rows.map((r) => r.gameTimeSec)),
  };
}

function summarizeMetrics(label: string, rows: RunMetric[]): void {
  if (rows.length === 0) {
    console.log(`${label.padEnd(10)} (no runs)`);
    return;
  }
  console.log(
    `${label.padEnd(10)}` +
      `dmg/s ${mean(rows.map((r) => r.damageTakenPerSec)).toFixed(2)}`.padEnd(14) +
      `dmg ${mean(rows.map((r) => r.damageTaken)).toFixed(0)}`.padEnd(12) +
      `xp ${mean(rows.map((r) => r.xp)).toFixed(0)}`.padEnd(10) +
      `gold ${mean(rows.map((r) => r.gold)).toFixed(0)}`.padEnd(11) +
      `kills ${mean(rows.map((r) => r.kills)).toFixed(0)}`.padEnd(12) +
      `minHP ${(mean(rows.map((r) => r.minHealthPercent)) * 100).toFixed(0)}%`.padEnd(12) +
      `t ${mean(rows.map((r) => r.gameTimeSec)).toFixed(0)}s`,
  );
}

async function sweep(args: CLIArgs): Promise<void> {
  const start = Date.now();
  const tasks: SweepTask[] = [];
  for (const weapon of args.weapons) {
    for (const seed of args.seeds) {
      tasks.push({ weapon, seed });
    }
  }
  console.log(`🎯 ${args.floorId} Win-Rate Sweep`);
  console.log('━'.repeat(70));
  console.log(
    `Seeds:   ${args.seeds[0]}…${args.seeds[args.seeds.length - 1]} (${args.seeds.length})`,
  );
  console.log(`Weapons: ${args.weapons.join(', ')}`);
  console.log(`Budget:  ${args.maxFrames} frames (~${(args.maxFrames / 60).toFixed(0)}s)`);
  console.log(`Damage:  ${args.enemyDamageMultiplier}x hostile damage`);
  console.log(`Runs:    ${tasks.length}`);
  console.log(`Workers: ${Math.max(1, Math.min(args.workers, tasks.length))}`);
  if (args.skipEvents) {
    console.log('Events:  disabled (--skip-events)');
  }
  console.log('');

  const fails: FailRecord[] = [];
  const metrics: RunMetric[] = [];
  const perWeapon: { weapon: string; wins: number; runs: number }[] = [];
  const sharedConfig: SweepSharedConfig = {
    maxFrames: args.maxFrames,
    enemyDamageMultiplier: args.enemyDamageMultiplier,
    floorId: args.floorId,
    skipEvents: args.skipEvents,
  };
  const taskResults: SweepTaskResult[] = [];
  if (Math.max(1, Math.min(args.workers, tasks.length)) === 1) {
    for (const task of tasks) {
      taskResults.push(await runSweepTask(task, sharedConfig));
    }
  } else {
    taskResults.push(
      ...(await runWorkerPool<SweepTask, SweepSharedConfig, SweepTaskResult>({
        workerUrl: new URL(import.meta.url),
        tasks,
        shared: sharedConfig,
        maxWorkers: args.workers,
        workerOptions: {
          execArgv: process.execArgv,
        },
      })),
    );
  }
  let resultIndex = 0;

  for (const weapon of args.weapons) {
    let wins = 0;
    for (const seed of args.seeds) {
      const result = taskResults[resultIndex];
      resultIndex += 1;
      if (result === undefined || result.task.weapon !== weapon || result.task.seed !== seed) {
        throw new Error(
          `Sweep task ordering mismatch at ${weapon}/${seed}; got ${result?.task.weapon ?? 'n/a'}/${result?.task.seed ?? 'n/a'}`,
        );
      }
      const { stats, failRecord } = result;
      const gameTimeSec = stats.gameTimeMs / 1000;
      metrics.push({
        weapon,
        seed,
        win: stats.outcome === 'victory',
        gameTimeSec: Math.round(gameTimeSec),
        damageTaken: stats.combat.damageTaken,
        damageTakenPerSec: gameTimeSec > 0 ? stats.combat.damageTaken / gameTimeSec : 0,
        xp: stats.totalXp,
        gold: stats.totalGold,
        kills: stats.combat.totalKills,
        minHealthPercent: stats.health.minHealthPercent,
        finalHealthPercent: stats.health.finalHealthPercent,
      });
      if (stats.outcome === 'victory') {
        wins++;
      } else if (failRecord) {
        fails.push(failRecord);
      }
      process.stdout.write(stats.outcome === 'victory' ? '.' : 'F');
    }
    perWeapon.push({ weapon, wins, runs: args.seeds.length });
    process.stdout.write('\n');
  }

  console.log('');
  console.log('━'.repeat(70));
  console.log('Weapon'.padEnd(16) + 'Win/Run'.padEnd(12) + 'Win%');
  console.log('─'.repeat(40));
  let totalWins = 0;
  let totalRuns = 0;
  for (const w of perWeapon) {
    totalWins += w.wins;
    totalRuns += w.runs;
    console.log(
      w.weapon.padEnd(16) +
        `${w.wins}/${w.runs}`.padEnd(12) +
        `${((w.wins / w.runs) * 100).toFixed(1)}%`,
    );
  }
  console.log('─'.repeat(40));
  console.log(
    'OVERALL'.padEnd(16) +
      `${totalWins}/${totalRuns}`.padEnd(12) +
      `${((totalWins / totalRuns) * 100).toFixed(1)}%`,
  );

  console.log('');
  console.log('Quality (means per run) — user goals: max xp/gold, MIN damage taken');
  console.log('─'.repeat(70));
  summarizeMetrics('ALL', metrics);
  summarizeMetrics(
    'WINS',
    metrics.filter((m) => m.win),
  );
  summarizeMetrics(
    'LOSSES',
    metrics.filter((m) => !m.win),
  );
  for (const weapon of args.weapons) {
    summarizeMetrics(
      weapon,
      metrics.filter((m) => m.weapon === weapon),
    );
  }

  if (fails.length > 0) {
    console.log('');
    console.log(`❌ ${fails.length} failures:`);
    console.log(
      'seed'.padEnd(6) +
        'wep'.padEnd(14) +
        'outcome'.padEnd(10) +
        't'.padEnd(6) +
        'lv'.padEnd(4) +
        'kills'.padEnd(7) +
        'dominant'.padEnd(16) +
        'worstWiggle',
    );
    for (const f of fails) {
      console.log(
        String(f.seed).padEnd(6) +
          f.weapon.padEnd(14) +
          f.outcome.padEnd(10) +
          `${f.gameTimeSec}s`.padEnd(6) +
          String(f.level).padEnd(4) +
          String(f.kills).padEnd(7) +
          f.dominantState.padEnd(16) +
          f.worstWiggle,
      );
    }
  }

  console.log('');
  console.log(`Total wall time: ${((Date.now() - start) / 1000).toFixed(0)}s`);

  if (args.out) {
    writeFileSync(
      args.out,
      JSON.stringify(
        {
          floorId: args.floorId,
          enemyDamageMultiplier: args.enemyDamageMultiplier,
          perWeapon,
          totalWins,
          totalRuns,
          winRate: totalWins / totalRuns,
          aggregate: {
            all: aggregateOf(metrics),
            wins: aggregateOf(metrics.filter((m) => m.win)),
            losses: aggregateOf(metrics.filter((m) => !m.win)),
          },
          metrics,
          fails,
        },
        null,
        2,
      ),
    );
    console.log(`💾 ${args.out}`);
  }
}

if (!isMainThread) {
  const payload = workerData as WorkerPoolTaskPayload<SweepTask, SweepSharedConfig>;
  runSweepTask(payload.task, payload.shared)
    .then((result) => {
      parentPort?.postMessage({
        taskIndex: payload.taskIndex,
        result,
      } satisfies WorkerTaskSuccess<SweepTaskResult>);
    })
    .catch((error) => {
      parentPort?.postMessage({
        taskIndex: payload.taskIndex,
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      } satisfies WorkerTaskFailure);
    });
} else {
  sweep(parseArgs()).catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
