#!/usr/bin/env node
/**
 * LOCAL-ONLY A/B harness (not committed). Runs the Floor-1 headless matrix and
 * reports win rate + loot-collection efficiency so tuning arms can be compared.
 *
 * Usage: npx tsx ab-sweep.local.ts --seeds 1-24 --weapons sword,bow,baseball-bat --label arm-name
 */
import { writeFileSync } from 'node:fs';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { BehaviorTreeAI } from './src/game/ai/bt-ai-provider.js';
import { runHeadless } from './src/game/ai/headless-runner.js';
import type { RunStats } from './src/game/ai/types.js';
import {
  runWorkerPool,
  type WorkerPoolTaskPayload,
} from './scripts/agent/perf/worker-pool.js';
import { GATE_MAX_FRAMES } from './scripts/agent/perf/floor1-gate-sample.js';

interface Task {
  weapon: string;
  seed: number;
}
interface Shared {
  maxFrames: number;
}
interface Result {
  weapon: string;
  seed: number;
  win: boolean;
  outcome: RunStats['outcome'];
  gameTimeSec: number;
  level: number;
  kills: number;
  xpCollected: number;
  xpSpawned: number;
  goldCollected: number;
  goldSpawned: number;
  combinedRatio: number;
}

async function runTask(task: Task, shared: Shared): Promise<Result> {
  const ai = new BehaviorTreeAI({ seed: task.seed });
  const stats = await runHeadless(ai, {
    seed: task.seed,
    maxFrames: shared.maxFrames,
    forceWeaponId: task.weapon,
    floorId: 'floor1',
  });
  const loot = stats.lootEfficiency;
  return {
    weapon: task.weapon,
    seed: task.seed,
    win: stats.outcome === 'victory',
    outcome: stats.outcome,
    gameTimeSec: Math.round(stats.gameTimeMs / 1000),
    level: stats.finalLevel,
    kills: stats.combat.totalKills,
    xpCollected: loot?.xpCollected ?? 0,
    xpSpawned: loot?.xpSpawned ?? 0,
    goldCollected: loot?.goldCollected ?? 0,
    goldSpawned: loot?.goldSpawned ?? 0,
    combinedRatio: loot?.combinedRatio ?? 0,
  };
}

function parseSeeds(spec: string): number[] {
  if (spec.includes('-')) {
    const [a, b] = spec.split('-').map(Number);
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  }
  return spec.split(',').map(Number);
}

async function main(): Promise<void> {
  let seeds = parseSeeds('1-24');
  let weapons = ['sword', 'bow', 'baseball-bat'];
  let workers = 4;
  let label = 'arm';
  let out: string | undefined;
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    const next = process.argv[i + 1];
    if (arg === '--seeds' && next) seeds = parseSeeds(next);
    else if (arg === '--weapons' && next) weapons = next.split(',');
    else if (arg === '--workers' && next) workers = Number(next);
    else if (arg === '--label' && next) label = next;
    else if (arg === '--out' && next) out = next;
  }
  const tasks: Task[] = [];
  for (const weapon of weapons) for (const seed of seeds) tasks.push({ weapon, seed });
  const started = Date.now();
  const results = await runWorkerPool<Task, Shared, Result>({
    workerUrl: new URL(import.meta.url),
    tasks,
    shared: { maxFrames: GATE_MAX_FRAMES },
    maxWorkers: workers,
    workerOptions: {
      execArgv: [
        ...process.execArgv,
        '--import',
        new URL('./scripts/agent/perf/tsx-worker-hooks.mjs', import.meta.url).href,
      ],
    },
  });

  const wins = results.filter((r) => r.win).length;
  const sum = (fn: (r: Result) => number): number => results.reduce((a, r) => a + fn(r), 0);
  const xpC = sum((r) => r.xpCollected);
  const xpS = sum((r) => r.xpSpawned);
  const goldC = sum((r) => r.goldCollected);
  const goldS = sum((r) => r.goldSpawned);
  const combined = (xpC + goldC) / Math.max(1, xpS + goldS);
  const meanRatio = sum((r) => r.combinedRatio) / results.length;
  const meanTime = sum((r) => r.gameTimeSec) / results.length;
  const meanLevel = sum((r) => r.level) / results.length;

  console.log(`\n=== ARM ${label} ===`);
  console.log(`runs=${results.length} wins=${wins} winRate=${((wins / results.length) * 100).toFixed(1)}%`);
  console.log(
    `pooledCombinedRatio=${combined.toFixed(4)} meanRunRatio=${meanRatio.toFixed(4)} xp=${xpC}/${xpS} gold=${goldC}/${goldS}`,
  );
  console.log(`meanGameTime=${meanTime.toFixed(1)}s meanLevel=${meanLevel.toFixed(2)}`);
  for (const weapon of weapons) {
    const rows = results.filter((r) => r.weapon === weapon);
    const w = rows.filter((r) => r.win).length;
    const cr =
      rows.reduce((a, r) => a + r.xpCollected + r.goldCollected, 0) /
      Math.max(1, rows.reduce((a, r) => a + r.xpSpawned + r.goldSpawned, 0));
    console.log(
      `  ${weapon.padEnd(14)} ${w}/${rows.length} wins  ratio=${cr.toFixed(4)}  t=${(rows.reduce((a, r) => a + r.gameTimeSec, 0) / rows.length).toFixed(0)}s`,
    );
  }
  const losses = results.filter((r) => !r.win);
  if (losses.length > 0) {
    console.log('losses:');
    for (const l of losses) {
      console.log(`  seed ${l.seed} ${l.weapon} ${l.outcome} ${l.gameTimeSec}s lv${l.level} ${l.kills} kills`);
    }
  }
  console.log(`wall=${((Date.now() - started) / 1000).toFixed(0)}s`);
  if (out) {
    writeFileSync(out, JSON.stringify({ label, results }, null, 2));
  }
}

if (isMainThread) {
  void main();
} else {
  const payload = workerData as WorkerPoolTaskPayload<Task, Shared>;
  void runTask(payload.task, payload.shared)
    .then((result) => parentPort?.postMessage({ taskIndex: payload.taskIndex, result }))
    .catch((error: unknown) =>
      parentPort?.postMessage({ taskIndex: payload.taskIndex, error: String(error) }),
    );
}
