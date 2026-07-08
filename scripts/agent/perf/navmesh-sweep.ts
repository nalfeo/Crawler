/**
 * Measurement harness: LEGACY vs NAVMESH pathing mode (A/B axis 1, mode C).
 *
 * The Slice-3 NAVMESH foundation is PLAIN shortest-path — the recast waypoint
 * route to the BT-chosen goal carries NO danger/reward weighting (that is
 * deliberately deferred to Slice 4). So NAVMESH will sometimes walk straight
 * through enemies that LEGACY's danger-aware grid steering would have skirted.
 * Its win-rate delta vs LEGACY is therefore DOCUMENTED, NOT GATED (repo rule
 * #13 — never tune gameplay to rescue a delta; do NOT hold NAVMESH-ON to
 * LEGACY's danger-aware win rate).
 *
 * This harness is the real-headless-runner Gate-3 artifact (repo rule #10): it
 * runs each (seed, weapon) pair twice through `runHeadless` — once LEGACY, once
 * NAVMESH — on the exact same deterministic seeds, so the two modes compare
 * apples-to-apples. Unlike `ai:ab-pathing-mode` (which HARD-GATES fused vs
 * legacy on win→loss flips), this script is REPORT-ONLY with one exception: an
 * INERTNESS tripwire. If NAVMESH completes ZERO floors across the entire sweep
 * it exits non-zero — that means the navmesh never actually drives the agent to
 * a goal (the spawnerSystem-inert trap, ADR 0034→0036), which is a real routing
 * bug, NOT a balance outcome, and cannot be gamed by tuning gameplay.
 *
 * Run with (mirrors ai:ab-pathing-mode / ai:weapon-sweep tooling):
 *   npm run ai:navmesh-sweep -- [--seeds 1-12] [--weapons sword,bow,baseball-bat] [--out path.json]
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
      out.push(Number(part));
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
  return s.outcome === 'victory' && s.gameTimeMs < FLOOR1_TIME_BUDGET_MS;
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
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const rows: Row[] = [];
  const start = Date.now();

  console.log(
    `Measurement: LEGACY vs NAVMESH pathing mode (report-only; delta is DOCUMENTED not gated)`,
  );
  console.log(`Seeds: ${args.seeds.join(',')}  Weapons: ${args.weapons.join(', ')}`);
  console.log(`maxFrames=${MAX_FRAMES}  winBudget=${FLOOR1_TIME_BUDGET_MS / 1000}s (game time)`);
  console.log('='.repeat(78));

  for (const weapon of args.weapons) {
    for (const seed of args.seeds) {
      const legacy = await run(seed, weapon, AIPathingMode.LEGACY);
      const navmesh = await run(seed, weapon, AIPathingMode.NAVMESH);
      const legacyWin = isWin(legacy.stats);
      const navmeshWin = isWin(navmesh.stats);
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
      };
      rows.push(row);
      const flag = row.flipWinToLoss
        ? ' L→loss (expected: no danger weighting)'
        : row.flipLossToWin
          ? ' loss→WIN'
          : '';
      const fbFlag = row.navmeshFallbacks > 0 ? ` guard×${row.navmeshFallbacks}` : '';
      console.log(
        `${weapon.padEnd(14)}seed ${String(seed).padEnd(3)} ` +
          `L:${legacy.stats.outcome.padEnd(8)}${String(row.legacySec).padStart(4)}s  ` +
          `N:${navmesh.stats.outcome.padEnd(8)}${String(row.navmeshSec).padStart(4)}s${flag}${fbFlag}`,
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

  console.log('='.repeat(78));
  console.log(`Total pairs:            ${rows.length}`);
  console.log(
    `NAVMESH victories:      ${navmeshCompletions}  (non-inert proof: navmesh drove the agent to floor completion)`,
  );
  console.log(`LOSS→WIN (navmesh):     ${gains.length}`);
  console.log(
    `WIN→LOSS (navmesh):     ${flips.length}  (EXPECTED — plain shortest-path has no danger weighting; NOT gated, rule #13)`,
  );
  console.log(
    `Partial-path guard:     ${totalFallbacks} total fires across ${pairsWithFallbacks}/${rows.length} pairs` +
      `  (0 pairs = DORMANT = pure navmesh routing)`,
  );
  console.log(
    `Aggregate win rate: legacy ${legacyWins}/${rows.length}  navmesh ${navmeshWins}/${rows.length}` +
      `  (delta ${navmeshWins - legacyWins >= 0 ? '+' : ''}${navmeshWins - legacyWins})`,
  );
  for (const w of args.weapons) {
    const wr = rows.filter((r) => r.weapon === w);
    const lWins = wr.filter((r) => r.legacyWin).length;
    const nWins = wr.filter((r) => r.navmeshWin).length;
    console.log(`  ${w.padEnd(14)} legacy ${lWins}/${wr.length}  navmesh ${nWins}/${wr.length}`);
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
          rows,
          flips,
          gains,
        },
        null,
        2,
      ),
    );
    console.log(`Wrote ${args.out}`);
  }

  // INERTNESS tripwire ONLY (not a win-rate gate). If navmesh never completes a
  // single floor, the mode is inert/broken — a routing bug, not a balance
  // outcome — and must fail loudly. This cannot be gamed by tuning gameplay.
  if (navmeshCompletions === 0) {
    console.error(
      `\nFAIL (inertness): NAVMESH completed 0/${rows.length} floors — the navmesh is not driving the agent to any goal. This is a routing bug (ADR 0034→0036 inert trap), not a balance outcome.`,
    );
    process.exit(1);
  }
  console.log(
    `\nOK: NAVMESH is non-inert (${navmeshCompletions}/${rows.length} floor completions). Win-rate delta is DOCUMENTED above, NOT gated.`,
  );
}

void main();
