#!/usr/bin/env node
/**
 * Floor 1 win-RATE sweep.
 *
 * Drives the same pure-ECS `runHeadless` + `BehaviorTreeAI` pipeline the gate
 * uses, across a large seed range × all six Floor-1 starter weapons, and
 * reports the aggregate WIN RATE plus per-failure and per-slow-victory
 * diagnostics (outcome, game-time, level, kills, stall reason, dominant
 * wasted-time state). This is the deterministic instrument behind the
 * "90%+ of Floor 1 seeds win" rule: it gates on the *rate* over a
 * representative sample, never on a hand-picked set of comfortable seeds.
 *
 * **Win definition (Floor 1):** any run whose terminal outcome is `victory`
 * counts as a win, regardless of the active-time budget. Victories that
 * exceeded the 6-min active-time budget are separately flagged as slow clears
 * and reported in a dedicated section — they never appear in the loss count.
 * The SSOT `isOfficialWin(stats, FLOOR1_TIME_BUDGET_MS)` flag is preserved for
 * tournament/A-B scoring; it does not affect the win-rate denominator.
 *
 * Other floors have different timing semantics and no validated active-time
 * budget here, so a win on `--floor floor2` is the raw `outcome==='victory'`
 * (identical to the "outcome victory" definition above — no slow-victory
 * concept on those floors).
 *
 * Usage
 * -----
 *   npm run ai:winrate-sweep                       # seeds 1-40 × {sword,bow,baseball-bat,pistol,throwing-knife,fireball}
 *   npm run ai:winrate-sweep -- --seeds 1-60       # range
 *   npm run ai:winrate-sweep -- --weapons sword    # one weapon
 *   npm run ai:winrate-sweep -- --max-frames 23760 --out files/sweep.json
 *   npm run ai:winrate-sweep -- --workers 8 --skip-events
 *
 * A failing seed runs to the budget, so a sweep over many seeds with many
 * failures is slow; that is expected — correctness, not speed, is the point.
 */
import { writeFileSync } from 'node:fs';
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
import { type CLIArgs, parseSweepArgs } from './winrate-sweep-args.js';
import { classifySweepRun } from './winrate-sweep-classify.js';
import { runProgression } from '../../../src/game/ai/progression-runner.js';
import { attachReleaseBaselineRuns, serializeReleaseBaseline } from './release-baseline.js';

/**
 * Per-leg AI seed offset for a chained run, so leg N's decision RNG differs
 * from leg 0's. Large and fixed so the mapping stays deterministic and legs
 * never collide across the seed panels used by the sweep tiers.
 */
const CHAINED_AI_SEED_STRIDE = 1_000_000;

/**
 * A flattened chained-progression run: a normal `RunStats` for the final leg,
 * with chain-wide totals folded in and the chain provenance attached.
 */
interface ChainedRunStats extends RunStats {
  chainedBudgetMs: number | null;
  chainedOfficialWin: boolean;
  chainedFloorIds: string[];
  chainedClearedFloorIds: string[];
}

interface SweepTask {
  weapon: string;
  seed: number;
}

interface SweepSharedConfig {
  maxFrames: number;
  /** True when `--max-frames` was supplied explicitly (see `CLIArgs`). */
  maxFramesExplicit: boolean;
  enemyDamageMultiplier: number;
  floorId: string;
  skipEvents: boolean;
  /** When false the run uses the seed's own weapon selection (no forceWeaponId). */
  forceWeapon: boolean;
  /** When true the run chains through the whole implemented floor chain. */
  chain: boolean;
}

interface SweepTaskResult {
  task: SweepTask;
  stats: RunStats;
  /** True if the run ended in victory (outcome win — the win-rate numerator). */
  outcomeVictory: boolean;
  /** True if this is an official (tournament) win: victory AND under active-time budget. */
  officialWin: boolean;
  /** True if the run achieved victory but exceeded the active-time budget (slow clear). */
  slowVictory: boolean;
  /** Diagnostic record for a true loss (non-victory). Null for victories. */
  failRecord: FailRecord | null;
  /** Diagnostic record for a slow victory (over-budget). Null for non-slow-victories. */
  slowRecord: FailRecord | null;
}

/**
 * Run one chained progression task and flatten it into a single `RunStats`.
 *
 * The progression's aggregate totals replace the last leg's time/frame fields,
 * and the outcome becomes `victory` only when the whole chain was cleared —
 * otherwise it is the outcome of the leg that ended the run. Everything else
 * (combat, quests, health) is taken from the final attempted leg, which is
 * where the run actually terminated.
 *
 * `chainedFloorIds` / `chainedClearedFloorIds` are attached so a consumer can
 * see how far a losing progression got without re-deriving it.
 */
async function runChainedSweepTask(
  task: SweepTask,
  config: SweepSharedConfig,
  recordEventOption: { recordEvent?: (event: SimEvent) => void },
): Promise<ChainedRunStats> {
  const progression = await runProgression(
    (_floorId, legIndex) =>
      // Offset the AI seed per leg so a chained Floor-2 leg does not replay the
      // identical decision stream as its Floor-1 leg on the same seed.
      new BehaviorTreeAI({ seed: task.seed + legIndex * CHAINED_AI_SEED_STRIDE }),
    {
      seed: task.seed,
      ...(config.forceWeapon ? { forceWeaponId: task.weapon } : {}),
      enemyDamageMultiplier: config.enemyDamageMultiplier,
      eventSampleInterval: 60,
      startFloorId: config.floorId,
      // An explicit --max-frames bounds EVERY leg of the chain; without it each
      // floor resolves its own manifest-derived cap so a long floor is not
      // truncated by a short floor's budget.
      ...(config.maxFramesExplicit ? { maxFramesPerFloor: config.maxFrames } : {}),
      ...recordEventOption,
    },
  );
  const finalLeg = progression.legs[progression.legs.length - 1];
  if (finalLeg === undefined) {
    throw new Error(`Progression run for seed ${task.seed} produced no legs.`);
  }
  return {
    ...finalLeg.stats,
    outcome: progression.reachedFinalVictory ? 'victory' : finalLeg.stats.outcome,
    gameTimeMs: progression.totalGameTimeMs,
    safeRoomMs: progression.totalSafeRoomMs,
    totalFrames: progression.totalFrames,
    wallTimeMs: progression.totalWallTimeMs,
    chainedBudgetMs: progression.budgetMs,
    chainedOfficialWin: progression.officialWin,
    chainedFloorIds: progression.legs.map((leg) => leg.floorId),
    chainedClearedFloorIds: [...progression.clearedFloorIds],
  };
}

/**
 * Classify a flattened chained run. The progression runner already applied the
 * summed-budget official-win rule, so this only maps it onto the sweep's
 * outcome/official/slow triple.
 */
function classifyChainedRun(stats: RunStats): {
  outcomeVictory: boolean;
  officialWin: boolean;
  slowVictory: boolean;
} {
  const outcomeVictory = stats.outcome === 'victory';
  const chained = stats as ChainedRunStats;
  const officialWin = chained.chainedOfficialWin ?? outcomeVictory;
  return { outcomeVictory, officialWin, slowVictory: outcomeVictory && !officialWin };
}

async function runSweepTask(task: SweepTask, config: SweepSharedConfig): Promise<SweepTaskResult> {
  const events: SimEvent[] = [];
  const recordEventOption = config.skipEvents
    ? {}
    : {
        recordEvent: (event: SimEvent): void => {
          events.push(event);
        },
      };
  // A chained run plays the whole floor chain in one go, carrying the player
  // over between floors; its win is reaching the final floor's victory. The
  // aggregated leg stats are surfaced as the last leg's RunStats with chain
  // totals folded in, so every downstream consumer (metrics, fail records,
  // baseline runs) keeps working on a single RunStats shape.
  const stats = config.chain
    ? await runChainedSweepTask(task, config, recordEventOption)
    : await runHeadless(new BehaviorTreeAI({ seed: task.seed }), {
        seed: task.seed,
        maxFrames: config.maxFrames,
        ...(config.forceWeapon ? { forceWeaponId: task.weapon } : {}),
        enemyDamageMultiplier: config.enemyDamageMultiplier,
        eventSampleInterval: 60,
        floorId: config.floorId,
        ...recordEventOption,
      });
  const { outcomeVictory, officialWin, slowVictory } = config.chain
    ? classifyChainedRun(stats)
    : classifySweepRun(stats, config.floorId);
  let failRecord: FailRecord | null = null;
  let slowRecord: FailRecord | null = null;
  // Build a diagnostic record for true losses (non-victories) and for slow
  // victories (over-budget). Both need event-log analysis, so the two cases
  // share the summarization work, then assign the record to the right slot.
  if (!outcomeVictory || slowVictory) {
    const sum = config.skipEvents ? null : summarizeEvents(events);
    const dom = sum ? Object.entries(sum.statePct).sort((a, b) => b[1] - a[1])[0] : null;
    const wig = sum?.wiggleEpisodes[0];
    const record: FailRecord = {
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
    if (!outcomeVictory) {
      failRecord = record;
    } else {
      slowRecord = record;
    }
  }
  return { task, stats, outcomeVictory, officialWin, slowVictory, failRecord, slowRecord };
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
  /** True if outcome === 'victory' (outcome win — used for the win-rate numerator). */
  win: boolean;
  /** True if win is true AND the active time exceeded the Floor-1 budget (slow clear). */
  slowVictory: boolean;
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
  console.log(`🎯 ${args.chain ? `${args.floorId}+ progression` : args.floorId} Win-Rate Sweep`);
  console.log('━'.repeat(70));
  console.log(
    `Seeds:   ${args.seeds[0]}…${args.seeds[args.seeds.length - 1]} (${args.seeds.length})`,
  );
  console.log(
    args.forceWeapon
      ? `Weapons: ${args.weapons.join(', ')}`
      : 'Weapons: seed-selected (--no-force-weapon)',
  );
  console.log(
    args.chain && !args.maxFramesExplicit
      ? 'Budget:  per-floor manifest caps (no explicit --max-frames)'
      : `Budget:  ${args.maxFrames} frames (~${(args.maxFrames / 60).toFixed(0)}s)`,
  );
  console.log(`Damage:  ${args.enemyDamageMultiplier}x hostile damage`);
  console.log(`Runs:    ${tasks.length}`);
  console.log(`Workers: ${Math.max(1, Math.min(args.workers, tasks.length))}`);
  if (args.skipEvents) {
    console.log('Events:  disabled (--skip-events)');
  }
  console.log('');

  const fails: FailRecord[] = [];
  const slowFails: FailRecord[] = [];
  const metrics: RunMetric[] = [];
  const perWeapon: { weapon: string; wins: number; slowVictories: number; runs: number }[] = [];
  const sharedConfig: SweepSharedConfig = {
    maxFrames: args.maxFrames,
    maxFramesExplicit: args.maxFramesExplicit,
    enemyDamageMultiplier: args.enemyDamageMultiplier,
    floorId: args.floorId,
    skipEvents: args.skipEvents,
    forceWeapon: args.forceWeapon,
    chain: args.chain,
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
          // tsx's async --import hooks don't remap .js→.ts in worker threads;
          // the bootstrap registers synchronous hooks (module.registerHooks)
          // which do, so add it after the existing execArgv.
          execArgv: [
            ...process.execArgv,
            '--import',
            new URL('./tsx-worker-hooks.mjs', import.meta.url).href,
          ],
        },
      })),
    );
  }
  let resultIndex = 0;

  for (const weapon of args.weapons) {
    let wins = 0;
    let slowVictoriesForWeapon = 0;
    for (const seed of args.seeds) {
      const result = taskResults[resultIndex];
      resultIndex += 1;
      if (result === undefined || result.task.weapon !== weapon || result.task.seed !== seed) {
        throw new Error(
          `Sweep task ordering mismatch at ${weapon}/${seed}; got ${result?.task.weapon ?? 'n/a'}/${result?.task.seed ?? 'n/a'}`,
        );
      }
      const { stats, outcomeVictory, slowVictory, failRecord, slowRecord } = result;
      const gameTimeSec = stats.gameTimeMs / 1000;
      metrics.push({
        weapon,
        seed,
        win: outcomeVictory,
        slowVictory,
        gameTimeSec: Math.round(gameTimeSec),
        damageTaken: stats.combat.damageTaken,
        damageTakenPerSec: gameTimeSec > 0 ? stats.combat.damageTaken / gameTimeSec : 0,
        xp: stats.totalXp,
        gold: stats.totalGold,
        kills: stats.combat.totalKills,
        minHealthPercent: stats.health.minHealthPercent,
        finalHealthPercent: stats.health.finalHealthPercent,
      });
      if (outcomeVictory) {
        wins++;
        if (slowVictory) {
          slowVictoriesForWeapon++;
          if (slowRecord) slowFails.push(slowRecord);
        }
      } else if (failRecord) {
        fails.push(failRecord);
      }
      // Progress indicator: '.' = fast win, 's' = slow victory, 'F' = true loss
      process.stdout.write(outcomeVictory ? (slowVictory ? 's' : '.') : 'F');
    }
    perWeapon.push({
      weapon,
      wins,
      slowVictories: slowVictoriesForWeapon,
      runs: args.seeds.length,
    });
    process.stdout.write('\n');
  }

  console.log('');
  console.log('━'.repeat(70));
  console.log('Weapon'.padEnd(16) + 'Win/Run'.padEnd(12) + 'Win%'.padEnd(10) + 'Slow');
  console.log('─'.repeat(45));
  let totalWins = 0;
  let totalRuns = 0;
  let totalSlowVictories = 0;
  for (const w of perWeapon) {
    totalWins += w.wins;
    totalRuns += w.runs;
    totalSlowVictories += w.slowVictories;
    console.log(
      w.weapon.padEnd(16) +
        `${w.wins}/${w.runs}`.padEnd(12) +
        `${((w.wins / w.runs) * 100).toFixed(1)}%`.padEnd(10) +
        (w.slowVictories > 0 ? `${w.slowVictories} slow` : ''),
    );
  }
  const totalTrueLosses = totalRuns - totalWins;
  console.log('─'.repeat(45));
  console.log(
    'OVERALL'.padEnd(16) +
      `${totalWins}/${totalRuns}`.padEnd(12) +
      `${((totalWins / totalRuns) * 100).toFixed(1)}%`.padEnd(10) +
      (totalSlowVictories > 0 ? `${totalSlowVictories} slow` : ''),
  );
  if (totalSlowVictories > 0 || totalTrueLosses > 0) {
    console.log(
      `  ↳ ${totalWins - totalSlowVictories} fast wins · ${totalSlowVictories} slow victories · ${totalTrueLosses} true losses`,
    );
  }

  console.log('');
  console.log('Quality (means per run) — user goals: max xp/gold, MIN damage taken');
  console.log('─'.repeat(70));
  summarizeMetrics('ALL', metrics);
  summarizeMetrics(
    'FAST WINS',
    metrics.filter((m) => m.win && !m.slowVictory),
  );
  if (metrics.some((m) => m.slowVictory)) {
    summarizeMetrics(
      'SLOW WINS',
      metrics.filter((m) => m.slowVictory),
    );
  }
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
    console.log(`❌ ${fails.length} true failure${fails.length === 1 ? '' : 's'}:`);
    printFailTable(fails);
  }

  if (slowFails.length > 0) {
    console.log('');
    console.log(
      `⏱️  ${slowFails.length} slow victor${slowFails.length === 1 ? 'y' : 'ies'} (outcome=victory, over active-time budget):`,
    );
    printFailTable(slowFails);
  }

  console.log('');
  console.log(`Total wall time: ${((Date.now() - start) / 1000).toFixed(0)}s`);

  if (args.out) {
    const output = attachReleaseBaselineRuns(
      {
        floorId: args.floorId,
        // Identifies which sweep leg produced this artifact, so the release
        // baseline can hold several legs side by side and the regression check
        // can compare like with like. Matches the ids in sweep-legs.ts.
        legId: args.chain ? `${args.floorId}-chain` : args.floorId,
        chained: args.chain,
        forceWeapon: args.forceWeapon,
        enemyDamageMultiplier: args.enemyDamageMultiplier,
        perWeapon,
        totalWins,
        totalSlowVictories,
        totalTrueLosses,
        totalRuns,
        winRate: totalWins / totalRuns,
        aggregate: {
          all: aggregateOf(metrics),
          wins: aggregateOf(metrics.filter((m) => m.win)),
          slowVictories: aggregateOf(metrics.filter((m) => m.slowVictory)),
          losses: aggregateOf(metrics.filter((m) => !m.win)),
        },
        metrics,
        fails,
        slowFails,
      },
      taskResults.map((result) => result.stats),
    );
    writeFileSync(args.out, serializeReleaseBaseline(output));
    console.log(`💾 ${args.out}`);
  }
}

function printFailTable(records: FailRecord[]): void {
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
  for (const f of records) {
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
  let args: CLIArgs;
  try {
    args = parseSweepArgs(process.argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  sweep(args).catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
