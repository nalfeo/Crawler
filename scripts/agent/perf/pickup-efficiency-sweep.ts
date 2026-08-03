#!/usr/bin/env node
/**
 * Floor-1 **pickup efficiency** sweep.
 *
 * Answers one question: of the XP and gold the run actually put on the floor,
 * how much did the AI pick up before the floor transition destroyed the rest?
 *
 * Definitions (single source of truth for this metric — do not restate them
 * elsewhere with different math):
 *
 *   gainedXp = max(0, totalXp - (runStartXp ?? 0))
 *   xpEff    = gainedXp   / (gainedXp   + xpOnGroundAtEnd)
 *   goldEff  = totalGold  / (totalGold  + goldOnGroundAtEnd)
 *   combined = (gainedXp + totalGold) / (gainedXp + totalGold + onGround)
 *
 * A run with nothing on the floor at all (denominator 0) is reported as `null`
 * and excluded from the aggregate rather than being counted as a perfect 1.0 —
 * counting it as 1.0 would let a run that collected nothing because nothing
 * dropped inflate the mean.
 *
 * The sweep drives the real `runHeadless` + `BehaviorTreeAI` pipeline (the same
 * one behind the Floor-1 completion gate), so a pickup-efficiency delta here is
 * a real pipeline observation, not a lab result. Win rate is reported alongside
 * so an efficiency gain bought with lost runs is immediately visible.
 *
 * Usage
 * -----
 *   npm run ai:pickup-efficiency
 *   npm run ai:pickup-efficiency -- --seeds 1-10 --weapons sword,bow
 *   npm run ai:pickup-efficiency -- --workers 4 --out files/pickup-eff.json
 *
 * Seeds are a **contiguous prefix** by default (AGENTS.md r12): the sample can
 * never be hand-picked to look comfortable.
 */
import { writeFileSync } from 'node:fs';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../../src/game/ai/headless-runner.js';
import type { RunStats } from '../../../src/game/ai/types.js';
import {
  runWorkerPool,
  type WorkerPoolTaskPayload,
  type WorkerTaskFailure,
  type WorkerTaskSuccess,
} from './worker-pool.js';
import { FLOOR1_TIME_BUDGET_MS, GATE_MAX_FRAMES, GATE_WEAPONS } from './floor1-gate-sample.js';
import { isOfficialWin } from '../../../src/game/ai/scoring.js';

export interface PickupEfficiency {
  /** XP earned during the run (excludes any seeded start-level baseline). */
  readonly gainedXp: number;
  /** XP gem value abandoned on the floor at run end. */
  readonly xpOnGround: number;
  /** Gold held at run end. */
  readonly gold: number;
  /** Gold pile value abandoned on the floor at run end. */
  readonly goldOnGround: number;
  /** `gainedXp / (gainedXp + xpOnGround)`, or null when nothing was available. */
  readonly xpEff: number | null;
  /** `gold / (gold + goldOnGround)`, or null when nothing was available. */
  readonly goldEff: number | null;
  /** Combined XP+gold efficiency, or null when nothing was available. */
  readonly combinedEff: number | null;
}

/**
 * Pure metric derivation from a finished run. Exported so unit tests pin the
 * formula (including the empty-denominator case) without running a simulation.
 */
export function computePickupEfficiency(stats: RunStats): PickupEfficiency {
  const gainedXp = Math.max(0, stats.totalXp - (stats.runStartXp ?? 0));
  const xpOnGround = stats.xpOnGroundAtEnd ?? 0;
  const gold = stats.totalGold;
  const goldOnGround = stats.goldOnGroundAtEnd ?? 0;
  const ratio = (collected: number, onGround: number): number | null => {
    const total = collected + onGround;
    return total > 0 ? collected / total : null;
  };
  return {
    gainedXp,
    xpOnGround,
    gold,
    goldOnGround,
    xpEff: ratio(gainedXp, xpOnGround),
    goldEff: ratio(gold, goldOnGround),
    combinedEff: ratio(gainedXp + gold, xpOnGround + goldOnGround),
  };
}

interface PickupTask {
  readonly weapon: string;
  readonly seed: number;
}

interface PickupSharedConfig {
  readonly maxFrames: number;
}

interface PickupTaskResult {
  readonly task: PickupTask;
  readonly win: boolean;
  /**
   * The blocking Floor-1 gate's definition: victory AND active time inside the
   * 6-minute budget. Reported alongside the raw win so an efficiency gain bought
   * by pushing runs over the CI gate's time budget can never look like a pass.
   */
  readonly officialWin: boolean;
  readonly activeTimeSec: number;
  readonly gameTimeSec: number;
  readonly efficiency: PickupEfficiency;
}

async function runPickupTask(
  task: PickupTask,
  config: PickupSharedConfig,
): Promise<PickupTaskResult> {
  const ai = new BehaviorTreeAI({ seed: task.seed });
  const stats = await runHeadless(ai, {
    seed: task.seed,
    maxFrames: config.maxFrames,
    forceWeaponId: task.weapon,
    floorId: 'floor1',
  });
  return {
    task,
    win: stats.outcome === 'victory',
    officialWin: isOfficialWin(stats, FLOOR1_TIME_BUDGET_MS),
    activeTimeSec: (stats.gameTimeMs - (stats.safeRoomMs ?? 0)) / 1000,
    gameTimeSec: stats.gameTimeMs / 1000,
    efficiency: computePickupEfficiency(stats),
  };
}

interface PickupArgs {
  readonly seeds: readonly number[];
  readonly weapons: readonly string[];
  readonly maxFrames: number;
  readonly workers: number;
  readonly out: string | null;
}

function parseSeedRange(spec: string): number[] {
  const range = /^(\d+)-(\d+)$/.exec(spec);
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    if (hi < lo) throw new Error(`Invalid seed range: ${spec}`);
    return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  }
  return spec.split(',').map((part) => {
    const seed = Number(part.trim());
    if (!Number.isFinite(seed)) throw new Error(`Invalid seed: ${part}`);
    return seed;
  });
}

export function parsePickupArgs(argv: readonly string[]): PickupArgs {
  const get = (flag: string): string | null => {
    const idx = argv.indexOf(flag);
    return idx >= 0 && idx + 1 < argv.length ? (argv[idx + 1] ?? null) : null;
  };
  const seedsSpec = get('--seeds') ?? '1-10';
  const weaponsSpec = get('--weapons');
  const workersSpec = get('--workers');
  const maxFramesSpec = get('--max-frames');
  return {
    seeds: parseSeedRange(seedsSpec),
    weapons: weaponsSpec ? weaponsSpec.split(',').map((w) => w.trim()) : GATE_WEAPONS,
    maxFrames: maxFramesSpec ? Number(maxFramesSpec) : GATE_MAX_FRAMES,
    workers: workersSpec ? Number(workersSpec) : 4,
    out: get('--out'),
  };
}

function meanOf(values: readonly (number | null)[]): number | null {
  const defined = values.filter((v): v is number => v !== null);
  if (defined.length === 0) return null;
  return defined.reduce((a, b) => a + b, 0) / defined.length;
}

function fmt(value: number | null): string {
  return value === null ? '  n/a ' : `${(value * 100).toFixed(1)}%`;
}

async function sweep(args: PickupArgs): Promise<void> {
  const tasks: PickupTask[] = [];
  for (const weapon of args.weapons) {
    for (const seed of args.seeds) {
      tasks.push({ weapon, seed });
    }
  }
  const shared: PickupSharedConfig = { maxFrames: args.maxFrames };
  const results: PickupTaskResult[] =
    Math.max(1, Math.min(args.workers, tasks.length)) === 1
      ? await tasks.reduce<Promise<PickupTaskResult[]>>(
          async (accP, task) => [...(await accP), await runPickupTask(task, shared)],
          Promise.resolve([]),
        )
      : await runWorkerPool<PickupTask, PickupSharedConfig, PickupTaskResult>({
          workerUrl: new URL(import.meta.url),
          tasks,
          shared,
          maxWorkers: args.workers,
          workerOptions: {
            // tsx's async --import hooks don't remap .js→.ts in worker threads;
            // the bootstrap registers synchronous hooks that do.
            execArgv: [
              ...process.execArgv,
              '--import',
              new URL('./tsx-worker-hooks.mjs', import.meta.url).href,
            ],
          },
        });

  console.log(
    'seed'.padEnd(6) +
      'weapon'.padEnd(15) +
      'win'.padEnd(5) +
      'active'.padEnd(8) +
      'xpEff'.padEnd(8) +
      'goldEff'.padEnd(9) +
      'combined'.padEnd(10) +
      'xp(got/left)'.padEnd(16) +
      'gold(got/left)',
  );
  for (const r of results) {
    const e = r.efficiency;
    console.log(
      String(r.task.seed).padEnd(6) +
        r.task.weapon.padEnd(15) +
        (r.win ? (r.officialWin ? 'W' : 'w') : 'L').padEnd(5) +
        `${r.activeTimeSec.toFixed(0)}s`.padEnd(8) +
        fmt(e.xpEff).padEnd(8) +
        fmt(e.goldEff).padEnd(9) +
        fmt(e.combinedEff).padEnd(10) +
        `${e.gainedXp.toFixed(0)}/${e.xpOnGround.toFixed(0)}`.padEnd(16) +
        `${e.gold.toFixed(0)}/${e.goldOnGround.toFixed(0)}`,
    );
  }

  const wins = results.filter((r) => r.win).length;
  const officialWins = results.filter((r) => r.officialWin).length;
  const aggregate = {
    runs: results.length,
    wins,
    officialWins,
    winRate: results.length > 0 ? wins / results.length : 0,
    officialWinRate: results.length > 0 ? officialWins / results.length : 0,
    meanActiveTimeSec:
      results.length > 0 ? results.reduce((a, r) => a + r.activeTimeSec, 0) / results.length : 0,
    xpEff: meanOf(results.map((r) => r.efficiency.xpEff)),
    goldEff: meanOf(results.map((r) => r.efficiency.goldEff)),
    combinedEff: meanOf(results.map((r) => r.efficiency.combinedEff)),
  };
  console.log('');
  console.log(
    `AGGREGATE  runs ${aggregate.runs}  winRate ${(aggregate.winRate * 100).toFixed(1)}%  ` +
      `officialWinRate ${(aggregate.officialWinRate * 100).toFixed(1)}%  ` +
      `meanActive ${aggregate.meanActiveTimeSec.toFixed(0)}s  ` +
      `xpEff ${fmt(aggregate.xpEff)}  goldEff ${fmt(aggregate.goldEff)}  ` +
      `combinedEff ${fmt(aggregate.combinedEff)}`,
  );

  if (args.out) {
    writeFileSync(
      args.out,
      JSON.stringify(
        {
          seeds: args.seeds,
          weapons: args.weapons,
          maxFrames: args.maxFrames,
          aggregate,
          runs: results,
        },
        null,
        2,
      ),
    );
    console.log(`💾 ${args.out}`);
  }
}

if (!isMainThread) {
  const payload = workerData as WorkerPoolTaskPayload<PickupTask, PickupSharedConfig>;
  runPickupTask(payload.task, payload.shared)
    .then((result) => {
      parentPort?.postMessage({
        taskIndex: payload.taskIndex,
        result,
      } satisfies WorkerTaskSuccess<PickupTaskResult>);
    })
    .catch((error: unknown) => {
      parentPort?.postMessage({
        taskIndex: payload.taskIndex,
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      } satisfies WorkerTaskFailure);
    });
} else {
  sweep(parsePickupArgs(process.argv)).catch((err: unknown) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
