/**
 * Slice 4b stage-1 measurement harness: sweep the NAVMESH_FUSED seam weight.
 *
 * Runs the canonical 36-pair Floor-1 sweep (12 seeds × 3 weapons) once as the
 * pure-NAVMESH baseline (the frozen no-regression bar), then once per candidate
 * seam weight in NAVMESH_FUSED mode. seamWeight = 0 reproduces shipped Slice 4a
 * EXACTLY (byte-identical fan), so it is the A/B control the operator tunes UP
 * from — a higher weight can only ADD the tangential-to-danger-gradient seam
 * bonus on top of the known-good 4a completion floor.
 *
 * Per repo rules #12/#13 this script does NOT pick a weight and does NOT gate on
 * any balance comparison. It is the stage-1 artifact the OPERATOR reads to bring
 * to the human for the mandatory seam-weight adjudication PING: the human picks
 * the final weight against the hard gate (completion ≥ pure-NAVMESH, no per-weapon
 * regression) + the ranked soft tiebreakers. The only non-zero exit is an
 * INERTNESS tripwire (a weight that completes ZERO floors is a routing bug, not a
 * balance outcome — it cannot be gamed by tuning).
 *
 * Per-weight it reports, alongside wins/completions/avg-time:
 *   • navPartialPathFallbacks — Slice-3 failure-mode watch (guardrail #4). 4a ran
 *     0; a SPIKE means the tangential term is dragging the follower off-mesh into
 *     recast⊊grid pockets → clamp the term.
 *   • seamActiveFraction = navmeshSeamActivePolls / navmeshSeamPolls — how often
 *     the reward-reachability gate let the seam term actually re-select a heading.
 *   • meanSeamAlign = navmeshSeamAlignSum / navmeshSeamActivePolls — mean
 *     chosenDir·tangent over active polls. This is the DIRECTIONAL-travel proof
 *     (rule #10): high alignment = the agent is travelling ALONG the danger seam,
 *     not merely lingering near danger.
 *
 * Run with:
 *   npm run ai:navmesh-seam-sweep -- [--seeds 1-12] [--weapons sword,bow,baseball-bat] \
 *     [--weights 0,0.5,1,2] [--out path.json]
 */
import { writeFileSync } from 'node:fs';
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../../src/game/ai/headless-runner.js';
import {
  AIPathingMode,
  type AIPathingModeValue,
  type RunStats,
} from '../../../src/game/ai/types.js';
import { GAME } from '../../../src/shared/constants.js';

const FLOOR1_TIME_BUDGET_MS = 6 * 60 * 1000;
const MAX_FRAMES = Math.ceil((FLOOR1_TIME_BUDGET_MS * 1.1) / GAME.DELTA_MS);
const WALL_CAP_MS = 30 * 60 * 1000;

function parseSeeds(spec: string): number[] {
  const out: number[] = [];
  for (const part of spec.split(',')) {
    const m = part.match(/^(\d+)-(\d+)$/);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      for (let i = a; i <= b; i++) out.push(i);
    } else if (part.trim()) {
      const n = Number(part);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(
          `Invalid seed "${part}" in --seeds: expected a non-negative integer or an "A-B" range.`,
        );
      }
      out.push(n);
    }
  }
  return out;
}

function parseWeights(spec: string): number[] {
  const out: number[] = [];
  for (const part of spec.split(',')) {
    if (!part.trim()) continue;
    const n = Number(part);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(
        `Invalid weight "${part}" in --weights: expected a non-negative finite number.`,
      );
    }
    out.push(n);
  }
  if (out.length === 0) throw new Error('--weights produced no candidate weights.');
  return out;
}

interface Args {
  seeds: number[];
  weapons: string[];
  weights: number[];
  out: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    seeds: parseSeeds('1-12'),
    weapons: ['sword', 'bow', 'baseball-bat'],
    // Candidate set spanning off → gentle → strong. seamWeight 0 = 4a control.
    weights: [0, 0.5, 1, 2],
    out: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--seeds' && next) {
      args.seeds = parseSeeds(next);
      i++;
    } else if (arg === '--weapons' && next) {
      args.weapons = next.split(',').map((w) => w.trim());
      i++;
    } else if (arg === '--weights' && next) {
      args.weights = parseWeights(next);
      i++;
    } else if (arg === '--out' && next) {
      args.out = next;
      i++;
    }
  }
  return args;
}

interface RunResult {
  stats: RunStats;
  navFallbacks: number;
  seamPolls: number;
  seamActivePolls: number;
  seamAlignSum: number;
}

async function run(
  seed: number,
  weapon: string,
  mode: AIPathingModeValue,
  seamWeight: number,
): Promise<RunResult> {
  const ai = new BehaviorTreeAI({ seed, pathingMode: mode, seamWeight });
  const stats = await runHeadless(ai, {
    seed,
    maxFrames: MAX_FRAMES,
    maxWallTimeMs: WALL_CAP_MS,
    forceWeaponId: weapon,
    floorId: 'floor1',
  });
  return {
    stats,
    navFallbacks: ai.navPartialPathFallbacks,
    seamPolls: ai.navmeshSeamPolls,
    seamActivePolls: ai.navmeshSeamActivePolls,
    seamAlignSum: ai.navmeshSeamAlignSum,
  };
}

function isWin(s: RunStats): boolean {
  return s.outcome === 'victory' && s.gameTimeMs < FLOOR1_TIME_BUDGET_MS;
}

interface WeightSummary {
  seamWeight: number;
  wins: number;
  completions: number;
  avgWinSec: number;
  totalFallbacks: number;
  pairsWithFallbacks: number;
  /** navmeshSeamActivePolls / navmeshSeamPolls across the sweep (0 at weight 0). */
  seamActiveFraction: number;
  /** navmeshSeamAlignSum / navmeshSeamActivePolls: mean chosenDir·tangent. */
  meanSeamAlign: number;
  /** Per-weapon wins, so a per-weapon regression is visible to the operator. */
  perWeapon: Record<string, number>;
  /** Wins pure-NAVMESH had that this weight lost (no-regression signal). */
  regressionsVsNav: number;
  /** Wins this weight gained over pure-NAVMESH. */
  gainsVsNav: number;
}

async function sweepMode(
  seeds: number[],
  weapons: string[],
  mode: AIPathingModeValue,
  seamWeight: number,
  baselineWins: Set<string> | null,
): Promise<{ summary: WeightSummary; winKeys: Set<string> }> {
  let wins = 0;
  let completions = 0;
  let winSecSum = 0;
  let totalFallbacks = 0;
  let pairsWithFallbacks = 0;
  let seamPolls = 0;
  let seamActivePolls = 0;
  let seamAlignSum = 0;
  let regressionsVsNav = 0;
  let gainsVsNav = 0;
  const perWeapon: Record<string, number> = {};
  const winKeys = new Set<string>();
  for (const weapon of weapons) {
    perWeapon[weapon] = 0;
    for (const seed of seeds) {
      const r = await run(seed, weapon, mode, seamWeight);
      const key = `${weapon}:${seed}`;
      const won = isWin(r.stats);
      if (r.stats.outcome === 'victory') completions++;
      if (won) {
        wins++;
        perWeapon[weapon]++;
        winSecSum += r.stats.gameTimeMs / 1000;
        winKeys.add(key);
      }
      totalFallbacks += r.navFallbacks;
      if (r.navFallbacks > 0) pairsWithFallbacks++;
      seamPolls += r.seamPolls;
      seamActivePolls += r.seamActivePolls;
      seamAlignSum += r.seamAlignSum;
      if (baselineWins) {
        const wasWin = baselineWins.has(key);
        if (wasWin && !won) regressionsVsNav++;
        if (!wasWin && won) gainsVsNav++;
      }
    }
  }
  const summary: WeightSummary = {
    seamWeight,
    wins,
    completions,
    avgWinSec: wins > 0 ? Math.round(winSecSum / wins) : 0,
    totalFallbacks,
    pairsWithFallbacks,
    seamActiveFraction: seamPolls > 0 ? seamActivePolls / seamPolls : 0,
    meanSeamAlign: seamActivePolls > 0 ? seamAlignSum / seamActivePolls : 0,
    perWeapon,
    regressionsVsNav,
    gainsVsNav,
  };
  return { summary, winKeys };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const total = args.seeds.length * args.weapons.length;
  const start = Date.now();

  console.log('Slice 4b seam-weight sweep (NAVMESH_FUSED); REPORT-ONLY — operator adjudicates.');
  console.log(`Seeds: ${args.seeds.join(',')}  Weapons: ${args.weapons.join(', ')}`);
  console.log(`Weights: ${args.weights.join(', ')}  (0 = shipped-4a control)`);
  console.log(`maxFrames=${MAX_FRAMES}  winBudget=${FLOOR1_TIME_BUDGET_MS / 1000}s (game time)`);
  console.log('='.repeat(96));

  // Pure-NAVMESH baseline = the frozen no-regression bar (hard gate: NAVMESH_FUSED
  // completion ≥ this). seamWeight is irrelevant in plain NAVMESH (passed 0).
  console.log('Baseline: pure NAVMESH …');
  const baseline = await sweepMode(args.seeds, args.weapons, AIPathingMode.NAVMESH, 0, null);
  const baselineWins = baseline.winKeys;
  console.log(
    `  pure-NAVMESH: wins ${baseline.summary.wins}/${total}  completions ${baseline.summary.completions}/${total}`,
  );

  const weightSummaries: WeightSummary[] = [];
  for (const w of args.weights) {
    console.log(`NAVMESH_FUSED seamWeight=${w} …`);
    const { summary } = await sweepMode(
      args.seeds,
      args.weapons,
      AIPathingMode.NAVMESH_FUSED,
      w,
      baselineWins,
    );
    weightSummaries.push(summary);
    console.log(
      `  w=${String(w).padEnd(5)} wins ${summary.wins}/${total}  compl ${summary.completions}/${total}  ` +
        `avgWin ${summary.avgWinSec}s  fallbacks ${summary.totalFallbacks}/${summary.pairsWithFallbacks}p  ` +
        `seamActive ${(summary.seamActiveFraction * 100).toFixed(1)}%  ` +
        `meanAlign ${summary.meanSeamAlign.toFixed(3)}  ` +
        `regr ${summary.regressionsVsNav} gain ${summary.gainsVsNav}`,
    );
  }

  console.log('='.repeat(96));
  console.log('Per-weight table (operator brings this to the seam-weight adjudication PING):');
  console.log(
    'weight | wins | compl | avgWinSec | fallbacks | seamActive% | meanAlign | regrVsNav | gainVsNav | perWeapon',
  );
  for (const s of weightSummaries) {
    const pw = args.weapons.map((w) => `${w}=${s.perWeapon[w] ?? 0}`).join(' ');
    console.log(
      `${String(s.seamWeight).padStart(6)} | ${String(s.wins).padStart(4)} | ${String(s.completions).padStart(5)} | ` +
        `${String(s.avgWinSec).padStart(9)} | ${String(s.totalFallbacks).padStart(9)} | ` +
        `${(s.seamActiveFraction * 100).toFixed(1).padStart(11)} | ${s.meanSeamAlign.toFixed(3).padStart(9)} | ` +
        `${String(s.regressionsVsNav).padStart(9)} | ${String(s.gainsVsNav).padStart(9)} | ${pw}`,
    );
  }
  console.log(
    `\nHard gate (operator-checked, NOT auto-gated): NAVMESH_FUSED completions ≥ pure-NAVMESH ${baseline.summary.completions}/${total}, no per-weapon regression.`,
  );
  console.log(`Wall time: ${((Date.now() - start) / 1000).toFixed(0)}s`);

  if (args.out) {
    writeFileSync(
      args.out,
      JSON.stringify(
        {
          maxFrames: MAX_FRAMES,
          budgetMs: FLOOR1_TIME_BUDGET_MS,
          seeds: args.seeds,
          weapons: args.weapons,
          totalPairs: total,
          baseline: baseline.summary,
          weights: weightSummaries,
        },
        null,
        2,
      ),
    );
    console.log(`Wrote ${args.out}`);
  }

  // INERTNESS tripwire ONLY. A candidate weight that completes ZERO floors is a
  // routing bug (the tangential term steering the agent off every goal), not a
  // balance outcome — fail loudly. Weight 0 completing 0 would mean 4a itself is
  // broken. This cannot be gamed by tuning gameplay.
  const inert = weightSummaries.filter((s) => s.completions === 0);
  if (inert.length > 0) {
    console.error(
      `\nFAIL (inertness): seamWeight(s) ${inert.map((s) => s.seamWeight).join(', ')} completed 0/${total} floors — the seam term is steering the agent off every goal (routing bug, not balance).`,
    );
    process.exit(1);
  }
  console.log(
    `\nOK: every candidate weight is non-inert. Weight selection is DEFERRED to the operator/human PING — this harness does NOT pick a weight (rules #12/#13).`,
  );
}

void main();
