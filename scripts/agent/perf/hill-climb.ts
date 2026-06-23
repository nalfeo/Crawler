#!/usr/bin/env node
/**
 * AI Hill-Climbing Optimiser
 *
 * Runs a coordinate-ascent search over the AIConfig parameter space, looking
 * for the configuration that maximises the composite score across a fixed seed
 * panel. Scoring priority: level completion (victory) > XP/level > gold.
 *
 * Algorithm
 * ---------
 * 1. Start from a seed config (defaults: current DEFAULT_CONFIG).
 * 2. For each tunable parameter, probe the config at ±step offsets (clamped to
 *    the parameter's range).
 * 3. Evaluate every candidate over all seeds in the panel and compute the mean
 *    composite score.
 * 4. Move to the best-scoring candidate.  If no neighbour beats the current
 *    config, halve all step sizes and retry.  Terminate when all steps are
 *    below their minimum or `--max-iters` is reached.
 *
 * The script prints a human-readable table at each iteration and writes the
 * best config to `--out` (default: /tmp/hill-climb-best.json).
 *
 * Usage
 * -----
 *   npm run ai:hill-climb
 *   npm run ai:hill-climb -- --seeds 2,4,7 --max-iters 20 --max-frames 18000
 *   npm run ai:hill-climb -- --start '{"dodgeWeight":0.4,"collectPullWeight":0.1}'
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../../src/game/ai/headless-runner.js';
import { scoreRun, aggregateScores, type ScoreBreakdown } from '../../../src/game/ai/scoring.js';
import type { AIConfig } from '../../../src/game/ai/types.js';

// ---------------------------------------------------------------------------
// Parameter space definition
// ---------------------------------------------------------------------------

/** Numeric keys of AIConfig that the hill-climber tunes. */
type TunableKey =
  | 'aggression'
  | 'retreatThreshold'
  | 'retreatDangerRadius'
  | 'scanRadius'
  | 'rangedSafeDistance'
  | 'opportunisticGrabRadius'
  | 'dodgeWeight'
  | 'collectPullWeight';

interface ParamDef {
  key: TunableKey;
  min: number;
  max: number;
  /** Initial step size for this parameter. */
  step: number;
  /** Stop refining when step falls below this value. */
  minStep: number;
}

const PARAM_SPACE: ParamDef[] = [
  { key: 'aggression', min: 0, max: 2, step: 0.5, minStep: 0.25 },
  { key: 'retreatThreshold', min: 0.05, max: 0.45, step: 0.05, minStep: 0.025 },
  { key: 'retreatDangerRadius', min: 80, max: 320, step: 40, minStep: 20 },
  { key: 'scanRadius', min: 200, max: 600, step: 100, minStep: 50 },
  { key: 'rangedSafeDistance', min: 60, max: 240, step: 30, minStep: 15 },
  { key: 'opportunisticGrabRadius', min: 60, max: 240, step: 30, minStep: 15 },
  { key: 'dodgeWeight', min: 0, max: 0.75, step: 0.125, minStep: 0.0625 },
  { key: 'collectPullWeight', min: 0, max: 0.5, step: 0.1, minStep: 0.05 },
];

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

interface CLIArgs {
  seeds: number[];
  maxFrames: number;
  maxIters: number;
  out: string;
  startConfig: Partial<AIConfig>;
  verbose: boolean;
}

function parseArgs(): CLIArgs {
  const args: CLIArgs = {
    seeds: [2, 4, 7],
    maxFrames: 18_000, // ~5 min at 60 fps — fast enough to complete floor 1
    maxIters: 30,
    out: '/tmp/hill-climb-best.json',
    startConfig: {},
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
    } else if (arg === '--start' && next) {
      try {
        args.startConfig = JSON.parse(next) as Partial<AIConfig>;
      } catch {
        console.error('--start must be valid JSON');
        process.exit(1);
      }
      i++;
    } else if (arg === '--start-file' && next) {
      try {
        args.startConfig = JSON.parse(readFileSync(next, 'utf8')) as Partial<AIConfig>;
      } catch {
        console.error(`--start-file: could not read ${next}`);
        process.exit(1);
      }
      i++;
    } else if (arg === '--verbose') {
      args.verbose = true;
    }
  }

  return args;
}

// ---------------------------------------------------------------------------
// Evaluation helpers
// ---------------------------------------------------------------------------

/**
 * Default AI config values (mirrors DEFAULT_CONFIG in bt-ai-provider.ts).
 * Duplicated here so the script is self-contained without importing internals.
 */
const BASE_CONFIG: Required<
  Pick<
    AIConfig,
    | 'aggression'
    | 'retreatThreshold'
    | 'retreatDangerRadius'
    | 'scanRadius'
    | 'rangedSafeDistance'
    | 'opportunisticGrabRadius'
    | 'dodgeWeight'
    | 'collectPullWeight'
  >
> = {
  aggression: 1,
  retreatThreshold: 0.15,
  retreatDangerRadius: 160,
  scanRadius: 400,
  rangedSafeDistance: 120,
  opportunisticGrabRadius: 120,
  dodgeWeight: 0.25,
  collectPullWeight: 0.0,
};

async function evaluateConfig(
  config: AIConfig,
  seeds: number[],
  maxFrames: number,
): Promise<{ meanScore: number; victoryRate: number; breakdowns: ScoreBreakdown[] }> {
  const maxGameTimeMs = maxFrames * (1000 / 60);
  const breakdowns: ScoreBreakdown[] = [];

  for (const seed of seeds) {
    const ai = new BehaviorTreeAI({ ...config, seed });
    const stats = await runHeadless(ai, { seed, maxFrames });
    breakdowns.push(scoreRun(stats, maxGameTimeMs));
  }

  const agg = aggregateScores(breakdowns);
  return { meanScore: agg.meanScore, victoryRate: agg.victoryRate, breakdowns };
}

// ---------------------------------------------------------------------------
// Hill-climbing core
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function configKey(config: AIConfig): string {
  return PARAM_SPACE.map(
    (p) => `${String(p.key)}=${((config[p.key] as number) ?? 0).toFixed(4)}`,
  ).join(',');
}

function formatConfig(config: AIConfig): string {
  return PARAM_SPACE.map(
    (p) => `  ${String(p.key).padEnd(26)} ${((config[p.key] as number) ?? 0).toFixed(4)}`,
  ).join('\n');
}

interface EvalResult {
  config: AIConfig;
  meanScore: number;
  victoryRate: number;
  label: string;
}

async function hillClimb(args: CLIArgs): Promise<void> {
  const startTime = Date.now();

  console.log('🧗 AI Hill-Climbing Optimiser');
  console.log('━'.repeat(60));
  console.log(`Seeds:      ${args.seeds.join(', ')}`);
  console.log(`Max frames: ${args.maxFrames} (~${(args.maxFrames / 60).toFixed(0)}s budget)`);
  console.log(`Max iters:  ${args.maxIters}`);
  console.log('');

  // Build starting config
  let current: AIConfig = { ...BASE_CONFIG, ...args.startConfig };
  const steps: Record<TunableKey, number> = Object.fromEntries(
    PARAM_SPACE.map((p) => [p.key, p.step]),
  ) as Record<TunableKey, number>;

  // Evaluate baseline
  console.log('📊 Evaluating baseline config...');
  const baseResult = await evaluateConfig(current, args.seeds, args.maxFrames);
  let currentScore = baseResult.meanScore;
  let currentVictoryRate = baseResult.victoryRate;

  console.log(
    `   Score: ${currentScore.toFixed(1)}  Victories: ${(currentVictoryRate * 100).toFixed(0)}%`,
  );
  console.log('');

  const history: EvalResult[] = [
    {
      config: { ...current },
      meanScore: currentScore,
      victoryRate: currentVictoryRate,
      label: 'baseline',
    },
  ];

  // Coord-ascent loop
  for (let iter = 0; iter < args.maxIters; iter++) {
    console.log(`🔍 Iteration ${iter + 1}/${args.maxIters}`);

    // Generate all neighbours (one param at a time, ±step)
    const candidates: Array<{ config: AIConfig; paramKey: TunableKey; direction: string }> = [];

    for (const param of PARAM_SPACE) {
      const step = steps[param.key];
      if (step < param.minStep) continue; // fully refined

      const val = (current[param.key] as number | undefined) ?? 0;

      for (const dir of [1, -1]) {
        const newVal = clamp(val + dir * step, param.min, param.max);
        if (Math.abs(newVal - val) < param.minStep * 0.5) continue; // already clamped at boundary
        candidates.push({
          config: { ...current, [param.key]: newVal },
          paramKey: param.key,
          direction: dir > 0 ? '+' : '-',
        });
      }
    }

    if (candidates.length === 0) {
      console.log('   No more candidates to probe (all steps refined to minimum). Stopping.');
      break;
    }

    // Evaluate each candidate
    let bestCandidate: EvalResult | null = null;
    const visited = new Set<string>([configKey(current)]);

    for (const cand of candidates) {
      const key = configKey(cand.config);
      if (visited.has(key)) continue;
      visited.add(key);

      const result = await evaluateConfig(cand.config, args.seeds, args.maxFrames);
      const label = `${cand.paramKey}${cand.direction}`;

      if (args.verbose) {
        console.log(
          `   [${label.padEnd(30)}] score=${result.meanScore.toFixed(1)}  win=${(result.victoryRate * 100).toFixed(0)}%`,
        );
      }

      if (bestCandidate === null || result.meanScore > bestCandidate.meanScore) {
        bestCandidate = {
          config: { ...cand.config },
          meanScore: result.meanScore,
          victoryRate: result.victoryRate,
          label,
        };
      }
    }

    if (bestCandidate && bestCandidate.meanScore > currentScore + 0.01) {
      // Accept move
      const delta = bestCandidate.meanScore - currentScore;
      console.log(
        `   ✅ Improved via [${bestCandidate.label}]: ${currentScore.toFixed(1)} → ${bestCandidate.meanScore.toFixed(1)} (+${delta.toFixed(1)})  win=${(bestCandidate.victoryRate * 100).toFixed(0)}%`,
      );
      current = bestCandidate.config;
      currentScore = bestCandidate.meanScore;
      currentVictoryRate = bestCandidate.victoryRate;
      history.push(bestCandidate);
    } else {
      // No improvement — halve all steps
      let anyAboveMin = false;
      for (const param of PARAM_SPACE) {
        const newStep = steps[param.key] / 2;
        steps[param.key] = newStep;
        if (newStep >= param.minStep) anyAboveMin = true;
      }
      if (!anyAboveMin) {
        console.log('   No improvement and all steps at minimum. Converged.');
        break;
      }
      console.log(
        `   ⬇️  No improvement (best=${bestCandidate?.meanScore.toFixed(1) ?? 'n/a'}). Halved step sizes.`,
      );
    }

    console.log('');
  }

  // Final report
  const wallSec = (Date.now() - startTime) / 1000;
  console.log('━'.repeat(60));
  console.log('🏆 Hill-climb complete');
  console.log(`   Total time:    ${wallSec.toFixed(1)}s`);
  console.log(`   Iterations:    ${history.length - 1} moves`);
  console.log(`   Final score:   ${currentScore.toFixed(1)}`);
  console.log(`   Victory rate:  ${(currentVictoryRate * 100).toFixed(0)}%`);
  console.log('');
  console.log('Best config:');
  console.log(formatConfig(current));
  console.log('');

  // Improvement table
  if (history.length > 1) {
    console.log('Improvement path:');
    for (const step of history) {
      console.log(
        `  ${step.label.padEnd(35)} score=${step.meanScore.toFixed(1)}  win=${(step.victoryRate * 100).toFixed(0)}%`,
      );
    }
    console.log('');
  }

  // Write output
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
  console.log(`💾 Best config written to: ${args.out}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const args = parseArgs();
hillClimb(args).catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
