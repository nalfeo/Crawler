#!/usr/bin/env node
/**
 * Seed-3 Sword Completion Hill-Climbing Optimiser
 *
 * Focused greedy hill-climb targeting seed 3 sword performance with correct
 * foot-based parameter ranges (the existing hill-climb.ts has stale pixel-unit
 * values in its BASE_CONFIG; all AIConfig distances are now in feet).
 *
 * Objectives (priority):
 *   1. Victory (frame < 25 000 ≈ 416 s)
 *   2. Final level ≥ 5
 *   3. Maximize gold + equipment purchase value
 *   4. Minimize excessive FLEE / critical-health time
 *
 * Usage
 * -----
 *   npx tsx scripts/agent/perf/hill-climb-seed3.ts
 *   npx tsx scripts/agent/perf/hill-climb-seed3.ts --max-iters 10
 *   npx tsx scripts/agent/perf/hill-climb-seed3.ts --seeds 3,13,23
 *   npx tsx scripts/agent/perf/hill-climb-seed3.ts --verbose
 */
import { writeFileSync } from 'node:fs';
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../../src/game/ai/headless-runner.js';
import type { AIConfig } from '../../../src/game/ai/types.js';
import type { RunStats } from '../../../src/game/ai/types.js';

// ---------------------------------------------------------------------------
// Fitness scoring (custom for seed-3 objectives)
// ---------------------------------------------------------------------------

/** Level bonus per level ≥ 5 — enough to be decisive but below VICTORY_BONUS. */
const LEVEL_BONUS_BASE = 50_000;
/** Time-efficiency bonus weight (applied only on victory). */
const TIME_BONUS_WEIGHT = 10_000;
/** Gold weight (tiebreaker). */
const GOLD_WEIGHT = 0.1;
/** XP efficiency weight. */
const XP_WEIGHT = 10;
/** Dominant victory bonus. */
const VICTORY_BONUS = 1_000_000;
/** Penalty per frame the AI spent in RETREAT state (per 60 fps frame). */
const RETREAT_FRAME_PENALTY = 0.5;

function scoreSeed3(stats: RunStats, maxGameTimeMs: number): number {
  const victory = stats.outcome === 'victory';
  const xpEff = stats.totalXp / Math.max(1, stats.finalLevel);
  const gold = stats.totalGold;

  // Objective 2: level bonus — level 5 is a step-change target
  const levelBonus = stats.finalLevel >= 5 ? LEVEL_BONUS_BASE + (stats.finalLevel - 5) * 10_000 : 0;

  let timeBonus = 0;
  if (victory && maxGameTimeMs > 0) {
    const frac = Math.min(1, stats.gameTimeMs / maxGameTimeMs);
    timeBonus = TIME_BONUS_WEIGHT * (1 - frac);
  }

  // Objective 4: penalise FLEE time
  const retreatFrames =
    stats.aiTelemetry?.decisionStateCounts?.['RETREAT'] ??
    stats.aiTelemetry?.decisionStateCounts?.['retreat'] ??
    0;
  const retreatPenalty = retreatFrames * RETREAT_FRAME_PENALTY;

  return (
    (victory ? VICTORY_BONUS : 0) +
    timeBonus +
    levelBonus +
    xpEff * XP_WEIGHT +
    gold * GOLD_WEIGHT -
    retreatPenalty
  );
}

function formatStats(stats: RunStats, score: number): string {
  const retreatFrames =
    stats.aiTelemetry?.decisionStateCounts?.['RETREAT'] ??
    stats.aiTelemetry?.decisionStateCounts?.['retreat'] ??
    0;
  const retreatPct =
    stats.totalFrames > 0 ? ((retreatFrames / stats.totalFrames) * 100).toFixed(1) : '0.0';
  return (
    `outcome=${stats.outcome.padEnd(8)} ` +
    `frames=${String(stats.totalFrames).padStart(6)} ` +
    `lvl=${stats.finalLevel} ` +
    `gold=${String(stats.totalGold).padStart(4)} ` +
    `flee=${retreatPct}% ` +
    `score=${score.toFixed(0)}`
  );
}

// ---------------------------------------------------------------------------
// Parameter space — ALL values in FEET matching DEFAULT_CONFIG in bt-ai-tuning.ts
// ---------------------------------------------------------------------------

type TunableKey =
  | 'aggression'
  | 'retreatThreshold'
  | 'retreatDangerRadius'
  | 'scanRadius'
  | 'opportunisticGrabRadius'
  | 'dodgeWeight'
  | 'collectPullWeight'
  | 'farmPullWeight';

interface ParamDef {
  key: TunableKey;
  min: number;
  max: number;
  step: number;
  minStep: number;
}

const PARAM_SPACE: ParamDef[] = [
  // Behavioural stance
  { key: 'aggression', min: 0.5, max: 2.0, step: 0.25, minStep: 0.125 },
  { key: 'retreatThreshold', min: 0.05, max: 0.35, step: 0.05, minStep: 0.025 },
  // Spatial radii — DEFAULT_CONFIG uses FEET (retreatDangerRadius:20, scanRadius:50)
  { key: 'retreatDangerRadius', min: 8, max: 40, step: 4, minStep: 2 },
  { key: 'scanRadius', min: 25, max: 80, step: 8, minStep: 4 },
  { key: 'opportunisticGrabRadius', min: 10, max: 30, step: 4, minStep: 2 },
  // Steering weights
  { key: 'dodgeWeight', min: 0.0, max: 0.6, step: 0.1, minStep: 0.05 },
  { key: 'collectPullWeight', min: 0.1, max: 0.8, step: 0.1, minStep: 0.05 },
  { key: 'farmPullWeight', min: 0.0, max: 0.2, step: 0.03, minStep: 0.015 },
];

/** Starting config from DEFAULT_CONFIG in bt-ai-tuning.ts (all feet). */
const DEFAULT_START: Record<TunableKey, number> = {
  aggression: 1,
  retreatThreshold: 0.15,
  retreatDangerRadius: 20,
  scanRadius: 50,
  opportunisticGrabRadius: 18,
  dodgeWeight: 0.25,
  collectPullWeight: 0.5,
  farmPullWeight: 0.07,
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CLIArgs {
  seeds: number[];
  maxFrames: number;
  maxIters: number;
  out: string;
  verbose: boolean;
}

function parseArgs(): CLIArgs {
  const args: CLIArgs = {
    seeds: [3],
    maxFrames: 25_000, // 25 000 frames ≈ 416 s at 60 fps — victory gate
    maxIters: 12,
    out: `${process.env['TEMP'] ?? '/tmp'}/hill-climb-seed3-best.json`,
    verbose: false,
  };

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    const next = process.argv[i + 1];
    if (arg === '--seeds' && next) {
      args.seeds = next.split(',').map(Number);
      i++;
    } else if (arg === '--max-frames' && next) {
      args.maxFrames = parseInt(next, 10);
      i++;
    } else if (arg === '--max-iters' && next) {
      args.maxIters = parseInt(next, 10);
      i++;
    } else if (arg === '--out' && next) {
      args.out = next;
      i++;
    } else if (arg === '--verbose') {
      args.verbose = true;
    }
  }

  return args;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

async function evaluateConfig(
  config: AIConfig,
  seeds: number[],
  maxFrames: number,
  verbose: boolean,
): Promise<{ meanScore: number; victoryRate: number; statsList: RunStats[] }> {
  const maxGameTimeMs = maxFrames * (1000 / 60);
  const statsList: RunStats[] = [];

  for (const seed of seeds) {
    const ai = new BehaviorTreeAI({ ...config, seed });
    const stats = await runHeadless(ai, {
      seed,
      maxFrames,
      forceWeaponId: 'sword',
    });
    statsList.push(stats);
    if (verbose) {
      const s = scoreSeed3(stats, maxGameTimeMs);
      console.log(`     seed=${seed}: ${formatStats(stats, s)}`);
    }
  }

  const maxGameTimeMs2 = maxFrames * (1000 / 60);
  const scores = statsList.map((s) => scoreSeed3(s, maxGameTimeMs2));
  const meanScore = scores.reduce((a, b) => a + b, 0) / scores.length;
  const victoryRate = statsList.filter((s) => s.outcome === 'victory').length / statsList.length;

  return { meanScore, victoryRate, statsList };
}

// ---------------------------------------------------------------------------
// Hill-climb
// ---------------------------------------------------------------------------

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function configKey(config: AIConfig): string {
  return PARAM_SPACE.map((p) => `${p.key}=${((config[p.key] as number) ?? 0).toFixed(4)}`).join(
    ',',
  );
}

function formatConfig(config: AIConfig): string {
  return PARAM_SPACE.map(
    (p) => `  ${p.key.padEnd(26)} ${((config[p.key] as number) ?? 0).toFixed(4)}`,
  ).join('\n');
}

interface EvalResult {
  config: AIConfig;
  meanScore: number;
  victoryRate: number;
  statsList: RunStats[];
  label: string;
}

async function hillClimb(args: CLIArgs): Promise<void> {
  const t0 = Date.now();
  const maxGameTimeMs = args.maxFrames * (1000 / 60);

  console.log('🧗 Seed-3 Sword Hill-Climb');
  console.log('━'.repeat(70));
  console.log(`Seeds:      ${args.seeds.join(', ')}`);
  console.log(
    `Max frames: ${args.maxFrames} (~${(args.maxFrames / 60).toFixed(0)}s, ~${(maxGameTimeMs / 60000).toFixed(1)}min budget)`,
  );
  console.log(`Max iters:  ${args.maxIters}`);
  console.log('');
  console.log('Starting config (DEFAULT_CONFIG — all radii in feet):');
  console.log(formatConfig(DEFAULT_START));
  console.log('');

  let current: AIConfig = { ...DEFAULT_START };
  const steps: Record<TunableKey, number> = Object.fromEntries(
    PARAM_SPACE.map((p) => [p.key, p.step]),
  ) as Record<TunableKey, number>;

  // Baseline
  console.log('📊 Baseline...');
  const baseResult = await evaluateConfig(current, args.seeds, args.maxFrames, true);
  let currentScore = baseResult.meanScore;
  let currentVictoryRate = baseResult.victoryRate;

  // Print baseline summary
  for (const [i, stats] of baseResult.statsList.entries()) {
    const s = scoreSeed3(stats, maxGameTimeMs);
    console.log(`  [baseline seed ${args.seeds[i]}] ${formatStats(stats, s)}`);
  }
  console.log(
    `  Baseline: score=${currentScore.toFixed(0)}  win=${(currentVictoryRate * 100).toFixed(0)}%`,
  );
  console.log('');

  const history: EvalResult[] = [
    {
      config: { ...current },
      meanScore: currentScore,
      victoryRate: currentVictoryRate,
      statsList: baseResult.statsList,
      label: 'baseline',
    },
  ];

  // Coord-ascent
  for (let iter = 0; iter < args.maxIters; iter++) {
    console.log(`🔍 Iteration ${iter + 1}/${args.maxIters}`);

    const candidates: Array<{ config: AIConfig; paramKey: TunableKey; direction: string }> = [];
    for (const param of PARAM_SPACE) {
      const step = steps[param.key];
      if (step < param.minStep) continue;

      const val = (current[param.key] as number | undefined) ?? DEFAULT_START[param.key];
      for (const dir of [1, -1]) {
        const newVal = clamp(val + dir * step, param.min, param.max);
        if (Math.abs(newVal - val) < param.minStep * 0.5) continue;
        candidates.push({
          config: { ...current, [param.key]: newVal },
          paramKey: param.key,
          direction: dir > 0 ? '+' : '-',
        });
      }
    }

    if (candidates.length === 0) {
      console.log('  No more candidates. Done.');
      break;
    }

    let best: EvalResult | null = null;
    const visited = new Set<string>([configKey(current)]);

    for (const cand of candidates) {
      const key = configKey(cand.config);
      if (visited.has(key)) continue;
      visited.add(key);

      const res = await evaluateConfig(cand.config, args.seeds, args.maxFrames, false);
      const label = `${cand.paramKey}${cand.direction}`;

      if (args.verbose) {
        console.log(
          `  [${label.padEnd(32)}] score=${res.meanScore.toFixed(0)}  win=${(res.victoryRate * 100).toFixed(0)}%`,
        );
      }

      if (!best || res.meanScore > best.meanScore) {
        best = { config: { ...cand.config }, ...res, label };
      }
    }

    if (best && best.meanScore > currentScore + 0.01) {
      const delta = best.meanScore - currentScore;
      console.log(
        `  ✅ [${best.label.padEnd(32)}] ${currentScore.toFixed(0)} → ${best.meanScore.toFixed(0)} (+${delta.toFixed(0)})  win=${(best.victoryRate * 100).toFixed(0)}%`,
      );
      for (const [i, stats] of best.statsList.entries()) {
        const s = scoreSeed3(stats, maxGameTimeMs);
        console.log(`     seed ${args.seeds[i]}: ${formatStats(stats, s)}`);
      }
      current = best.config;
      currentScore = best.meanScore;
      currentVictoryRate = best.victoryRate;
      history.push(best);
    } else {
      let anyAboveMin = false;
      for (const param of PARAM_SPACE) {
        const newStep = steps[param.key] / 2;
        steps[param.key] = newStep;
        if (newStep >= param.minStep) anyAboveMin = true;
      }
      const bestStr = best ? best.meanScore.toFixed(0) : 'n/a';
      if (!anyAboveMin) {
        console.log(`  ⏹  No improvement (best=${bestStr}). Converged.`);
        break;
      }
      console.log(`  ⬇️  No improvement (best=${bestStr}). Halved steps.`);
    }

    console.log('');
  }

  // Final report
  const wallSec = (Date.now() - t0) / 1000;
  console.log('━'.repeat(70));
  console.log('🏆 Hill-climb complete');
  console.log(`  Wall time:   ${wallSec.toFixed(1)}s`);
  console.log(`  Iterations:  ${history.length - 1} improvements`);
  console.log(`  Final score: ${currentScore.toFixed(0)}`);
  console.log(`  Victory rate: ${(currentVictoryRate * 100).toFixed(0)}%`);
  console.log('');
  console.log('Best config:');
  console.log(formatConfig(current));
  console.log('');

  if (history.length > 1) {
    console.log('Improvement path:');
    for (const step of history) {
      console.log(
        `  ${step.label.padEnd(38)} score=${step.meanScore.toFixed(0)}  win=${(step.victoryRate * 100).toFixed(0)}%`,
      );
    }
    console.log('');
  }

  const output = {
    config: current,
    meanScore: currentScore,
    victoryRate: currentVictoryRate,
    seeds: args.seeds,
    maxFrames: args.maxFrames,
    history: history.map((h) => ({
      label: h.label,
      meanScore: h.meanScore,
      victoryRate: h.victoryRate,
    })),
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(args.out, JSON.stringify(output, null, 2));
  console.log(`💾 Written to ${args.out}`);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
const args = parseArgs();
hillClimb(args).catch((err: unknown) => {
  console.error('Fatal:', err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
