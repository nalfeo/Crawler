/**
 * Floor 1 set-piece reachability sweep (hard gate, rule #12 / #15).
 *
 * Runs `checkFloor1SetPieceReachability` over a large deterministic seed panel
 * and asserts 100% pass: every generated floor's welcome-room prefab must be
 * reachable from spawn with all its doors AND in-room NPC anchors pathable. One
 * sealed room fails the whole sweep — NO seed cherry-picking.
 *
 * Broad runs (>10 seeds) MUST run on GitHub CI via
 * `.github/workflows/set-piece-reachability.yml` (rule #15), not local compute.
 * This script is the CI entry point; it exits non-zero if any seed fails so the
 * workflow goes red on a single stranded room.
 *
 * Usage:
 *   npx tsx scripts/agent/set-piece/reachability-sweep.ts --count 200 --out sweep.json
 *   npx tsx scripts/agent/set-piece/reachability-sweep.ts --seeds 1-50,777,2024
 */
import { writeFileSync } from 'node:fs';
import {
  checkFloor1SetPieceReachability,
  type SetPieceReachabilityResult,
} from '../../../src/game/set-piece-reachability.js';
import { parseSeeds, parseNonNegativeInt } from '../perf/winrate-sweep-args.js';

interface SweepArgs {
  seeds: number[];
  out: string | null;
}

function parseArgs(argv: readonly string[]): SweepArgs {
  const args: SweepArgs = {
    seeds: Array.from({ length: 100 }, (_, i) => i + 1),
    out: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--seeds' && next) {
      args.seeds = parseSeeds(next);
      i++;
    } else if (arg === '--count' && next) {
      const count = parseNonNegativeInt('--count', next);
      args.seeds = Array.from({ length: count }, (_, k) => k + 1);
      i++;
    } else if (arg === '--out' && next) {
      args.out = next;
      i++;
    }
  }
  if (args.seeds.length === 0) {
    throw new Error('No seeds to run (empty --seeds / --count 0).');
  }
  return args;
}

function main(): void {
  const { seeds, out } = parseArgs(process.argv);
  const results: SetPieceReachabilityResult[] = [];
  let passed = 0;

  console.log(
    `Set-piece reachability sweep: ${seeds.length} Floor 1 seeds ` +
      `[${seeds[0]}..${seeds[seeds.length - 1]}]`,
  );

  for (const seed of seeds) {
    const result = checkFloor1SetPieceReachability(seed);
    results.push(result);
    if (result.pass) {
      passed += 1;
    } else {
      console.error(
        `  seed ${seed}: FAIL (doors=${result.doorCount}, npcs=${result.npcCount})\n` +
          result.failures.map((f) => `      - ${f}`).join('\n'),
      );
    }
  }

  const failed = seeds.length - passed;
  const degraded = results.filter((r) => !r.carved).length;
  const summary = {
    kind: 'set-piece-reachability' as const,
    floor: 'floor1',
    generatedAt: new Date().toISOString(),
    total: seeds.length,
    passed,
    failed,
    passRate: passed / seeds.length,
    /**
     * Count of seeds where the prefab degraded to the legacy render-only fallback
     * (room bounds != footprint) instead of an authoritative carve. Expected
     * steady state is 0; any non-zero value also fails the sweep (see check #0 in
     * the gate) and signals carve tiers 1–2 are under-powered.
     */
    degraded,
    results,
  };

  if (out) {
    writeFileSync(out, JSON.stringify(summary, null, 2));
    console.log(`Wrote ${out}`);
  }

  console.log(
    `\nSet-piece reachability: ${passed}/${seeds.length} seeds passed ` +
      `(${((passed / seeds.length) * 100).toFixed(1)}%).`,
  );
  console.log(
    `Prefab carve degradations (render-only fallback): ${degraded}/${seeds.length} ` +
      `(expected 0${degraded > 0 ? ' — carve tiers 1–2 under-powered' : ' ✅'}).`,
  );

  if (failed > 0) {
    const degradedNote =
      degraded > 0
        ? ` ${degraded} of them degraded to the render-only fallback (bounds != footprint).`
        : '';
    console.error(
      `\nHARD GATE FAILED: ${failed} seed(s) had an unreachable set-piece room.${degradedNote} ` +
        `A single sealed room fails the sweep (rule #12) — fix the carve, do NOT ` +
        `cherry-pick seeds.`,
    );
    process.exit(1);
  }
  console.log('HARD GATE PASSED: 100% of set-piece rooms reachable from spawn.');
}

main();
