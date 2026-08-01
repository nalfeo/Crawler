import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFreshProcessResult } from './fresh-process-result.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WORKER = path.join(REPO_ROOT, 'scripts', 'agent', 'perf', 'xp-collection-probe-worker.ts');
const RESULT_MARKER = 'XP_PROBE_RESULT=';

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback);
}

const seeds = flag('--seeds', '1-3').includes('-')
  ? (() => {
      const [start, end] = flag('--seeds', '1-3').split('-').map(Number);
      return Array.from({ length: end! - start! + 1 }, (_, index) => start! + index);
    })()
  : flag('--seeds', '1-3').split(',').map(Number);
const floor = flag('--floor', 'floor2');
const maxFrames = flag('--max-frames', '100000');
const maxTimes = flag('--max-time-ms', '300000').split(',');
const budgets = flag('--budgets', '25,50,100,200');
const runCount = seeds.length * maxTimes.length;
if (runCount > 10) {
  throw new Error(`Local XP sweep is capped at 10 fresh-process runs; requested ${runCount}`);
}

const results: unknown[] = [];
for (const maxTimeMs of maxTimes) {
  for (const seed of seeds) {
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        WORKER,
        '--seed',
        String(seed),
        '--floor',
        floor,
        '--max-frames',
        maxFrames,
        '--max-time-ms',
        maxTimeMs,
        '--budgets',
        budgets,
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: Number(maxTimeMs) + 60_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const result = parseFreshProcessResult<{
      outcome: string;
      xpCollection?: { floors: Array<{ spawned: number; collected: number; efficiency: number }> };
    }>(child, RESULT_MARKER, `XP probe (seed=${seed}, maxTimeMs=${maxTimeMs})`);
    results.push(result);
    const xp = result.xpCollection?.floors.at(-1);
    console.error(
      `seed=${seed} maxTimeMs=${maxTimeMs} outcome=${result.outcome} xp=${xp?.collected ?? 0}/${xp?.spawned ?? 0} efficiency=${((xp?.efficiency ?? 0) * 100).toFixed(1)}%`,
    );
  }
}

console.log(JSON.stringify({ floor, maxFrames: Number(maxFrames), results }, null, 2));
