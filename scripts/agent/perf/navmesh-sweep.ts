/**
 * Measurement harness: LEGACY vs NAVMESH vs NAVMESH_FUSED pathing modes
 * (A/B axis 1). Runs each (seed, weapon) pair THREE times through `runHeadless`
 * on the exact same deterministic seed:
 *   • LEGACY         — grid A* + danger-aware Track-B steering (the baseline).
 *   • NAVMESH        — Slice-3 PLAIN recast shortest-path route, NO danger/reward
 *                      weighting (deliberately deferred). This column is the
 *                      frozen no-regression bar for NAVMESH_FUSED.
 *   • NAVMESH_FUSED  — Slice-4a: the SAME recast route (pure query) with the
 *                      already-tuned RISK_REWARD_FUSED danger/reward fan applied
 *                      at FOLLOW level (deflects the navmesh waypoint heading).
 *
 * Per repo rule #13, win-rate deltas are DOCUMENTED, NOT tuned: this script does
 * NOT gate on any balance comparison. In particular it does NOT exit non-zero
 * when NAVMESH_FUSED completes fewer floors than NAVMESH — that "≥ pure-NAVMESH"
 * bar is a SHIP decision the operator evaluates from the JSON (RED → PING the
 * human, never a silent retune). It is the real-headless-runner Gate-3 artifact
 * (repo rule #10), REPORT-ONLY with ONE exception: an INERTNESS tripwire. If
 * EITHER navmesh mode completes ZERO floors across the sweep it exits non-zero —
 * that means the navmesh never actually drives the agent to a goal (the
 * spawnerSystem-inert trap, ADR 0034→0036), a real routing bug NOT a balance
 * outcome, which cannot be gamed by tuning gameplay.
 *
 * The per-row NAVMESH fields stay STABLE (same names/semantics as the 2-mode
 * sweep) so a before/after diff of the pure-NAVMESH rows proves the Slice-4a
 * enum/poll() rename is byte-identical for the NAVMESH arm.
 *
 * Run with (mirrors ai:ab-pathing-mode / ai:weapon-sweep tooling):
 *   npm run ai:navmesh-sweep -- [--seeds 1-12] [--weapons sword,bow,baseball-bat] [--out path.json]
 */
import { writeFileSync } from 'node:fs';
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../../src/game/ai/headless-runner.js';
import { isOfficialWin } from '../../../src/game/ai/scoring.js';
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

interface Args {
  seeds: number[];
  weapons: string[];
  out: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  // 12 seeds × 3 weapons = the canonical 36-pair Floor-1 sweep.
  const args: Args = {
    seeds: parseSeeds('1-12'),
    weapons: ['sword', 'bow', 'baseball-bat'],
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
    } else if (arg === '--out' && next) {
      args.out = next;
      i++;
    }
  }
  return args;
}

async function run(seed: number, weapon: string, mode: AIPathingModeValue): Promise<RunResult> {
  const ai = new BehaviorTreeAI({ seed, pathingMode: mode });
  const stats = await runHeadless(ai, {
    seed,
    maxFrames: MAX_FRAMES,
    maxWallTimeMs: WALL_CAP_MS,
    forceWeaponId: weapon,
    floorId: 'floor1',
  });
  // navPartialPathFallbacks counts polls where the NAVMESH partial-path guard
  // deferred to grid-A* (0 in LEGACY; expected 0 under the static all-doors
  // navmesh on Floor 1 — the dormancy measurement the creator asked for).
  return { stats, navFallbacks: ai.navPartialPathFallbacks };
}

interface RunResult {
  stats: RunStats;
  navFallbacks: number;
}

function isWin(s: RunStats): boolean {
  return isOfficialWin(s, FLOOR1_TIME_BUDGET_MS);
}

interface Row {
  weapon: string;
  seed: number;
  legacyOutcome: string;
  legacySec: number;
  legacyWin: boolean;
  navmeshOutcome: string;
  navmeshSec: number;
  navmeshWin: boolean;
  /** NAVMESH partial-path guard fires (grid-A* fallbacks) this pair. 0 = the
   * guard was dormant, so this run is pure navmesh routing. */
  navmeshFallbacks: number;
  flipWinToLoss: boolean;
  flipLossToWin: boolean;
  navmeshFusedOutcome: string;
  navmeshFusedSec: number;
  navmeshFusedWin: boolean;
  /** NAVMESH_FUSED partial-path guard fires this pair (same guard as NAVMESH;
   * the fused fan changes only the follow heading, never the recast query). */
  navmeshFusedFallbacks: number;
  /** NAVMESH_FUSED lost a win pure-NAVMESH had (the ship no-regression signal —
   * DOCUMENTED, never tuned away; RED aggregate → PING human). */
  fusedRegressionVsNav: boolean;
  /** NAVMESH_FUSED gained a win pure-NAVMESH lacked (danger/reward paying off). */
  fusedGainVsNav: boolean;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const rows: Row[] = [];
  const start = Date.now();

  console.log(
    `Measurement: LEGACY vs NAVMESH vs NAVMESH_FUSED pathing modes (report-only; deltas DOCUMENTED not gated)`,
  );
  console.log(`Seeds: ${args.seeds.join(',')}  Weapons: ${args.weapons.join(', ')}`);
  console.log(`maxFrames=${MAX_FRAMES}  winBudget=${FLOOR1_TIME_BUDGET_MS / 1000}s (game time)`);
  console.log('='.repeat(78));

  for (const weapon of args.weapons) {
    for (const seed of args.seeds) {
      const legacy = await run(seed, weapon, AIPathingMode.LEGACY);
      const navmesh = await run(seed, weapon, AIPathingMode.NAVMESH);
      const fused = await run(seed, weapon, AIPathingMode.NAVMESH_FUSED);
      const legacyWin = isWin(legacy.stats);
      const navmeshWin = isWin(navmesh.stats);
      const navmeshFusedWin = isWin(fused.stats);
      const row: Row = {
        weapon,
        seed,
        legacyOutcome: legacy.stats.outcome,
        legacySec: Math.round(legacy.stats.gameTimeMs / 1000),
        legacyWin,
        navmeshOutcome: navmesh.stats.outcome,
        navmeshSec: Math.round(navmesh.stats.gameTimeMs / 1000),
        navmeshWin,
        navmeshFallbacks: navmesh.navFallbacks,
        flipWinToLoss: legacyWin && !navmeshWin,
        flipLossToWin: !legacyWin && navmeshWin,
        navmeshFusedOutcome: fused.stats.outcome,
        navmeshFusedSec: Math.round(fused.stats.gameTimeMs / 1000),
        navmeshFusedWin,
        navmeshFusedFallbacks: fused.navFallbacks,
        fusedRegressionVsNav: navmeshWin && !navmeshFusedWin,
        fusedGainVsNav: !navmeshWin && navmeshFusedWin,
      };
      rows.push(row);
      const flag = row.flipWinToLoss
        ? ' L→loss (expected: no danger weighting)'
        : row.flipLossToWin
          ? ' loss→WIN'
          : '';
      const fusedFlag = row.fusedRegressionVsNav
        ? ' F<N regression'
        : row.fusedGainVsNav
          ? ' F>N gain'
          : '';
      const fbFlag = row.navmeshFallbacks > 0 ? ` guardN×${row.navmeshFallbacks}` : '';
      const fbFusedFlag =
        row.navmeshFusedFallbacks > 0 ? ` guardF×${row.navmeshFusedFallbacks}` : '';
      console.log(
        `${weapon.padEnd(14)}seed ${String(seed).padEnd(3)} ` +
          `L:${legacy.stats.outcome.padEnd(8)}${String(row.legacySec).padStart(4)}s  ` +
          `N:${navmesh.stats.outcome.padEnd(8)}${String(row.navmeshSec).padStart(4)}s${flag}${fbFlag}  ` +
          `F:${fused.stats.outcome.padEnd(8)}${String(row.navmeshFusedSec).padStart(4)}s${fusedFlag}${fbFusedFlag}`,
      );
    }
  }

  const flips = rows.filter((r) => r.flipWinToLoss);
  const gains = rows.filter((r) => r.flipLossToWin);
  const legacyWins = rows.filter((r) => r.legacyWin).length;
  const navmeshWins = rows.filter((r) => r.navmeshWin).length;
  const navmeshCompletions = rows.filter((r) => r.navmeshOutcome === 'victory').length;
  // Partial-path guard dormancy (the creator's ship/HOLD signal). "Load-bearing"
  // = fires on a MAJORITY of seed×weapon pairs. Dormant/near-dormant = ship;
  // load-bearing = PING before shipping (B may have its own connectivity gaps).
  const totalFallbacks = rows.reduce((sum, r) => sum + r.navmeshFallbacks, 0);
  const pairsWithFallbacks = rows.filter((r) => r.navmeshFallbacks > 0).length;
  const navmeshFusedWins = rows.filter((r) => r.navmeshFusedWin).length;
  const navmeshFusedCompletions = rows.filter((r) => r.navmeshFusedOutcome === 'victory').length;
  const totalFusedFallbacks = rows.reduce((sum, r) => sum + r.navmeshFusedFallbacks, 0);
  const pairsWithFusedFallbacks = rows.filter((r) => r.navmeshFusedFallbacks > 0).length;
  const fusedRegressions = rows.filter((r) => r.fusedRegressionVsNav);
  const fusedGains = rows.filter((r) => r.fusedGainVsNav);

  console.log('='.repeat(78));
  console.log(`Total pairs:            ${rows.length}`);
  console.log(
    `NAVMESH victories:      ${navmeshCompletions}  (non-inert proof: navmesh drove the agent to floor completion)`,
  );
  console.log(
    `NAVMESH_FUSED victories:${String(navmeshFusedCompletions).padStart(3)}  (non-inert proof: fused follow still reaches the goal)`,
  );
  console.log(`LOSS→WIN (navmesh):     ${gains.length}`);
  console.log(
    `WIN→LOSS (navmesh):     ${flips.length}  (EXPECTED — plain shortest-path has no danger weighting; NOT gated, rule #13)`,
  );
  console.log(
    `FUSED vs pure-NAVMESH:  regressions ${fusedRegressions.length}  gains ${fusedGains.length}` +
      `  (ship bar = navmeshFused wins ≥ navmesh wins; DOCUMENTED not gated — RED → PING human, never retune)`,
  );
  console.log(
    `Partial-path guard:     navmesh ${totalFallbacks} fires/${pairsWithFallbacks} pairs · ` +
      `fused ${totalFusedFallbacks} fires/${pairsWithFusedFallbacks} pairs  (0 pairs = DORMANT = pure navmesh routing)`,
  );
  console.log(
    `Aggregate win rate: legacy ${legacyWins}/${rows.length}  navmesh ${navmeshWins}/${rows.length}  ` +
      `navmeshFused ${navmeshFusedWins}/${rows.length}` +
      `  (F−N delta ${navmeshFusedWins - navmeshWins >= 0 ? '+' : ''}${navmeshFusedWins - navmeshWins})`,
  );
  for (const w of args.weapons) {
    const wr = rows.filter((r) => r.weapon === w);
    const lWins = wr.filter((r) => r.legacyWin).length;
    const nWins = wr.filter((r) => r.navmeshWin).length;
    const fWins = wr.filter((r) => r.navmeshFusedWin).length;
    console.log(
      `  ${w.padEnd(14)} legacy ${lWins}/${wr.length}  navmesh ${nWins}/${wr.length}  navmeshFused ${fWins}/${wr.length}`,
    );
  }
  console.log(`Wall time: ${((Date.now() - start) / 1000).toFixed(0)}s`);

  if (args.out) {
    writeFileSync(
      args.out,
      JSON.stringify(
        {
          maxFrames: MAX_FRAMES,
          budgetMs: FLOOR1_TIME_BUDGET_MS,
          legacyWins,
          navmeshWins,
          navmeshCompletions,
          totalFallbacks,
          pairsWithFallbacks,
          navmeshFusedWins,
          navmeshFusedCompletions,
          totalFusedFallbacks,
          pairsWithFusedFallbacks,
          rows,
          flips,
          gains,
          fusedRegressions,
          fusedGains,
        },
        null,
        2,
      ),
    );
    console.log(`Wrote ${args.out}`);
  }

  // INERTNESS tripwire ONLY (not a win-rate gate). If EITHER navmesh mode never
  // completes a single floor, that mode is inert/broken — a routing bug, not a
  // balance outcome — and must fail loudly. This cannot be gamed by tuning.
  if (navmeshCompletions === 0 || navmeshFusedCompletions === 0) {
    const dead =
      navmeshCompletions === 0 && navmeshFusedCompletions === 0
        ? 'NAVMESH and NAVMESH_FUSED'
        : navmeshCompletions === 0
          ? 'NAVMESH'
          : 'NAVMESH_FUSED';
    console.error(
      `\nFAIL (inertness): ${dead} completed 0/${rows.length} floors — the navmesh is not driving the agent to any goal. This is a routing bug (ADR 0034→0036 inert trap), not a balance outcome.`,
    );
    process.exit(1);
  }
  console.log(
    `\nOK: both navmesh modes are non-inert (NAVMESH ${navmeshCompletions}/${rows.length}, NAVMESH_FUSED ${navmeshFusedCompletions}/${rows.length}). Win-rate deltas are DOCUMENTED above, NOT gated.`,
  );
}

void main();
