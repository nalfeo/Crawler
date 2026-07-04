#!/usr/bin/env node
/**
 * health/governor-playthroughs.ts — deterministic Floor 1 + Floor 2 seed sweep.
 */

import process from 'node:process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Report, fromRepo } from '../shared/report.js';
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../../src/game/ai/headless-runner.js';

const OUT_PATH = fromRepo('coverage/balance-metrics.json');
const TARGET_WIN_RATE = 0.9;
const FLOOR1_WEAPONS = ['sword', 'bow', 'baseball-bat'];
const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
const BUDGET_FRAMES = 30_000;

interface SweepResult {
  floorId: string;
  runs: number;
  wins: number;
}

async function sweepFloor1(): Promise<SweepResult> {
  let wins = 0;
  let runs = 0;
  for (const weapon of FLOOR1_WEAPONS) {
    for (const seed of SEEDS) {
      runs += 1;
      const stats = await runHeadless(new BehaviorTreeAI({ seed }), {
        seed,
        floorId: 'floor1',
        forceWeaponId: weapon,
        maxFrames: BUDGET_FRAMES,
      });
      if (stats.outcome === 'victory') {
        wins += 1;
      }
    }
  }
  return { floorId: 'floor1', runs, wins };
}

async function sweepFloor2(): Promise<SweepResult> {
  let wins = 0;
  let runs = 0;
  for (const seed of SEEDS) {
    runs += 1;
    let autoVictoryCleared = false;
    const stats = await runHeadless(new BehaviorTreeAI({ seed }), {
      seed,
      floorId: 'floor2',
      maxFrames: BUDGET_FRAMES,
      simulationOptions: {
        preSystems: [
          (world) => {
            if (autoVictoryCleared) {
              return;
            }
            // Sweep against real gameplay progression, not manifest-assisted
            // instant wins; clear only once at run start.
            if (world.goalFlags.get('floor2-victory') === true) {
              world.goalFlags.set('floor2-victory', false);
            }
            autoVictoryCleared = true;
          },
        ],
      },
    });
    if (stats.outcome === 'victory') {
      wins += 1;
    }
  }
  return { floorId: 'floor2', runs, wins };
}

async function main(): Promise<void> {
  const report = new Report('health-governor-playthroughs');
  const floor1 = await sweepFloor1();
  const floor2 = await sweepFloor2();
  const totalRuns = floor1.runs + floor2.runs;
  const totalWins = floor1.wins + floor2.wins;
  const floor1WinRate = floor1.wins / floor1.runs;
  const floor2WinRate = floor2.wins / floor2.runs;
  const combinedWinRate = totalWins / totalRuns;

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(
    OUT_PATH,
    JSON.stringify(
      {
        version: 1,
        recordedAt: new Date().toISOString(),
        metrics: {
          floor1WinRate,
          floor2WinRate,
          combinedWinRate,
          totalRuns,
        },
        details: {
          seeds: SEEDS,
          floor1,
          floor2,
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  report.info(
    `Floor 1 ${(floor1WinRate * 100).toFixed(1)}% · Floor 2 ${(floor2WinRate * 100).toFixed(1)}% · Combined ${(combinedWinRate * 100).toFixed(1)}%`,
  );
  if (
    floor1WinRate < TARGET_WIN_RATE ||
    floor2WinRate < TARGET_WIN_RATE ||
    combinedWinRate < TARGET_WIN_RATE
  ) {
    report.error(
      `Governor win-rate target not met (target ${(TARGET_WIN_RATE * 100).toFixed(0)}%).`,
      {
        remediation:
          'Tune AI/pathing/spawn knobs and re-run scripts/agent/health/governor-playthroughs.ts.',
      },
    );
  }
  report.finish();
}

main().catch((err) => {
  process.stderr.write(
    `governor-playthroughs crashed: ${err instanceof Error ? err.stack : err}\n`,
  );
  process.exit(2);
});
