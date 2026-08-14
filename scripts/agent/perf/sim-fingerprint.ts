#!/usr/bin/env node
/**
 * Deterministic gameplay fingerprint for the **perf-optimizer** workflow.
 *
 * A resource optimization is only legitimate if the simulation is unchanged
 * afterwards. This tool checks that mechanically: it replays the same sample the
 * blocking Floor-1 headless gate uses — seeds 1–8 × {sword, bow, baseball-bat}
 * through the pure-ECS `runHeadless` + `BehaviorTreeAI` pipeline — and hashes
 * the full `RunStats` of every run, minus wall-clock fields (the only thing an
 * optimization is allowed to change).
 *
 * ## Scope of the guarantee
 *
 * An identical hash means every covered run produced identical **reported
 * results** — same outcome, spawns-as-reflected-in-kills, damage, quest
 * progression, level/XP/gold. In practice that is a very strong signal the RNG
 * stream was untouched, since almost any divergence moves at least one field.
 * It is not a full world-state trace, and it covers **nothing** outside the
 * headless sim: rendering, asset loading, input, and browser behavior are not
 * exercised at all. Render/load optimizations need their own observation.
 *
 * Usage
 * -----
 *   # 1. On the unmodified baseline (e.g. main), record the fingerprint:
 *   npm run perf:fingerprint -- --write files/perf-baseline.json
 *
 *   # 2. After the optimization, assert nothing moved:
 *   npm run perf:fingerprint -- --check files/perf-baseline.json
 *
 *   # Narrow the sample while iterating (NOT valid as the PR gate):
 *   npm run perf:fingerprint -- --seeds 1-2 --weapons sword --write files/quick.json
 *
 * `--check` exits 1 on any drift and prints the exact divergent fields. A
 * baseline records the sample it covers, so comparing mismatched workloads is
 * reported as a sample mismatch rather than as a false gameplay finding.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../../src/game/ai/headless-runner.js';
import type { RunStats } from '../../../src/game/ai/types.js';
import {
  GATE_MAX_FRAMES,
  GATE_SEEDS,
  GATE_WALL_TIME_CAP_MS,
  GATE_WEAPONS,
} from './floor1-gate-sample.js';
import {
  buildFingerprint,
  compareFingerprints,
  formatComparison,
  type Fingerprint,
  type FingerprintRun,
} from './sim-fingerprint-lib.js';
import {
  runWorkerPool,
  type WorkerPoolTaskPayload,
  type WorkerTaskFailure,
  type WorkerTaskSuccess,
  workerOptionsForModule,
} from './worker-pool.js';

interface FingerprintTask {
  weapon: string;
  seed: number;
}

interface SharedConfig {
  maxFrames: number;
}

interface TaskResult {
  task: FingerprintTask;
  stats: RunStats;
}

async function runFingerprintTask(
  task: FingerprintTask,
  config: SharedConfig,
): Promise<TaskResult> {
  const ai = new BehaviorTreeAI({ seed: task.seed });
  const stats = await runHeadless(ai, {
    seed: task.seed,
    maxFrames: config.maxFrames,
    maxWallTimeMs: GATE_WALL_TIME_CAP_MS,
    forceWeaponId: task.weapon,
  });
  return { task, stats };
}

interface CLIArgs {
  seeds: number[];
  weapons: string[];
  workers: number;
  maxFrames: number;
  write: string | null;
  check: string | null;
}

function parseSeeds(raw: string): number[] {
  const seeds: number[] = [];
  for (const part of raw.split(',')) {
    const token = part.trim();
    if (token === '') continue;
    const range = /^(\d+)-(\d+)$/.exec(token);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (to < from) {
        throw new Error(`Invalid seed range "${token}": end is before start`);
      }
      for (let seed = from; seed <= to; seed += 1) seeds.push(seed);
      continue;
    }
    const seed = Number(token);
    if (!Number.isInteger(seed) || seed < 0) {
      throw new Error(`Invalid seed "${token}"`);
    }
    seeds.push(seed);
  }
  if (seeds.length === 0) {
    throw new Error('--seeds resolved to an empty set');
  }
  return [...new Set(seeds)].sort((a, b) => a - b);
}

function parseArgs(argv: readonly string[]): CLIArgs {
  const args: CLIArgs = {
    seeds: [...GATE_SEEDS],
    weapons: [...GATE_WEAPONS],
    workers: 4,
    maxFrames: GATE_MAX_FRAMES,
    write: null,
    check: null,
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = rest[i + 1];
    const requireValue = (): string => {
      if (value === undefined) {
        throw new Error(`${flag} requires a value`);
      }
      i += 1;
      return value;
    };
    switch (flag) {
      case '--seeds':
        args.seeds = parseSeeds(requireValue());
        break;
      case '--weapons':
        args.weapons = requireValue()
          .split(',')
          .map((w) => w.trim())
          .filter((w) => w !== '');
        break;
      case '--workers': {
        const workers = Number(requireValue());
        if (!Number.isInteger(workers) || workers < 1) {
          throw new Error('--workers must be a positive integer');
        }
        args.workers = workers;
        break;
      }
      case '--max-frames': {
        const frames = Number(requireValue());
        if (!Number.isInteger(frames) || frames < 1) {
          throw new Error('--max-frames must be a positive integer');
        }
        args.maxFrames = frames;
        break;
      }
      case '--write':
        args.write = requireValue();
        break;
      case '--check':
        args.check = requireValue();
        break;
      default:
        throw new Error(`Unknown flag "${flag}"`);
    }
  }
  if (args.weapons.length === 0) {
    throw new Error('--weapons resolved to an empty set');
  }
  if (args.write === null && args.check === null) {
    throw new Error('Pass --write <file> to record a baseline or --check <file> to compare.');
  }
  if (args.write !== null && args.check !== null) {
    throw new Error('--write and --check are mutually exclusive.');
  }
  return args;
}

function isGateSample(args: CLIArgs): boolean {
  return (
    args.maxFrames === GATE_MAX_FRAMES &&
    args.seeds.length === GATE_SEEDS.length &&
    args.seeds.every((seed, i) => seed === GATE_SEEDS[i]) &&
    args.weapons.length === GATE_WEAPONS.length &&
    GATE_WEAPONS.every((weapon) => args.weapons.includes(weapon))
  );
}

async function main(args: CLIArgs): Promise<void> {
  const start = performance.now();
  const tasks: FingerprintTask[] = [];
  for (const weapon of args.weapons) {
    for (const seed of args.seeds) {
      tasks.push({ weapon, seed });
    }
  }

  const gateSample = isGateSample(args);
  console.log('🔒 Floor 1 gameplay fingerprint');
  console.log('━'.repeat(70));
  console.log(`Seeds:   ${args.seeds.join(', ')}`);
  console.log(`Weapons: ${args.weapons.join(', ')}`);
  console.log(`Runs:    ${tasks.length}`);
  console.log(`Workers: ${Math.max(1, Math.min(args.workers, tasks.length))}`);
  console.log(
    `Sample:  ${gateSample ? 'FULL gate sample (valid as the PR gate)' : 'NARROWED — local iteration only, NOT a valid PR gate'}`,
  );
  console.log('');

  const shared: SharedConfig = { maxFrames: args.maxFrames };
  const concurrency = Math.max(1, Math.min(args.workers, tasks.length));
  const results: TaskResult[] =
    concurrency === 1
      ? await sequential(tasks, shared)
      : await runWorkerPool<FingerprintTask, SharedConfig, TaskResult>({
          workerUrl: new URL(import.meta.url),
          tasks,
          shared,
          maxWorkers: args.workers,
          workerOptions: workerOptionsForModule(import.meta.url),
        });

  const runs: FingerprintRun[] = results.map((result) => ({
    weapon: result.task.weapon,
    seed: result.task.seed,
    stats: result.stats,
  }));
  const fingerprint = buildFingerprint(runs, {
    seeds: args.seeds,
    weapons: args.weapons,
    maxFrames: args.maxFrames,
  });

  console.log(`Hash:    ${fingerprint.hash}`);
  console.log(`Elapsed: ${((performance.now() - start) / 1000).toFixed(0)}s`);
  console.log('');

  if (args.write !== null) {
    const target = path.resolve(args.write);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify({ gateSample, ...fingerprint }, null, 2)}\n`);
    console.log(`💾 Baseline written to ${args.write}`);
    if (!gateSample) {
      console.log(
        '⚠️  Narrowed sample: this baseline cannot satisfy the PR gameplay-neutrality gate.',
      );
    }
    return;
  }

  const baselineFile = args.check as string;
  let baseline: Fingerprint;
  try {
    baseline = JSON.parse(readFileSync(path.resolve(baselineFile), 'utf8')) as Fingerprint;
  } catch (error) {
    throw new Error(
      `Could not read baseline "${baselineFile}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const comparison = compareFingerprints(baseline, fingerprint);
  console.log(formatComparison(comparison));
  if (comparison.versionMismatch || comparison.sampleMismatch !== null) {
    // Not a gameplay finding — the two fingerprints simply aren't comparable.
    process.exit(1);
  }
  if (!comparison.identical) {
    console.log('');
    console.log(
      'This change is NOT gameplay-neutral. Fix the divergence — do not update the baseline to match.',
    );
    process.exit(1);
  }
  if (!gateSample) {
    console.log('');
    console.log('⚠️  Narrowed sample: rerun on the full gate sample before opening a PR.');
  }
}

async function sequential(
  tasks: readonly FingerprintTask[],
  shared: SharedConfig,
): Promise<TaskResult[]> {
  const out: TaskResult[] = [];
  for (const task of tasks) {
    out.push(await runFingerprintTask(task, shared));
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  return out;
}

if (!isMainThread) {
  const payload = workerData as WorkerPoolTaskPayload<FingerprintTask, SharedConfig>;
  runFingerprintTask(payload.task, payload.shared)
    .then((result) => {
      parentPort?.postMessage({
        taskIndex: payload.taskIndex,
        result,
      } satisfies WorkerTaskSuccess<TaskResult>);
    })
    .catch((error: unknown) => {
      parentPort?.postMessage({
        taskIndex: payload.taskIndex,
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      } satisfies WorkerTaskFailure);
    });
} else {
  let parsed: CLIArgs;
  try {
    parsed = parseArgs(process.argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  main(parsed).catch((error: unknown) => {
    console.error('Fatal:', error);
    process.exit(1);
  });
}
