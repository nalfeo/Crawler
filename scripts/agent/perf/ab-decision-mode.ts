/**
 * A/B validation harness: LEGACY vs SLACK_AWARE decision mode (A/B axis 2).
 *
 * Mirrors the official Floor-1 gate's `clearFloor1` (same seeds, weapons, frame
 * budget, and win definition) but runs each (seed, weapon) pair TWICE — once in
 * each decision mode — so the two modes can be compared apples-to-apples on the
 * exact same deterministic runs.
 *
 * The HARD safety gate for the monotone SLACK_AWARE filter is: ZERO win→loss
 * flips (a seed that wins under LEGACY must never lose under SLACK_AWARE). The
 * harness exits non-zero if any win→loss flip is detected.
 *
 * Run with (mirrors the ai:weapon-sweep / ai:winrate-sweep tooling):
 *   npm run ai:ab-decision-mode -- [--seeds 1-8] [--weapons sword,bow,baseball-bat] [--out path.json]
 */
import { writeFileSync } from 'node:fs';
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../../src/game/ai/headless-runner.js';
import { isOfficialWin } from '../../../src/game/ai/scoring.js';
import {
  AIDecisionMode,
  type AIDecisionModeValue,
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
  const args: Args = {
    seeds: parseSeeds('1-8'),
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

async function run(seed: number, weapon: string, mode: AIDecisionModeValue): Promise<RunStats> {
  const ai = new BehaviorTreeAI({ seed, decisionMode: mode });
  return runHeadless(ai, {
    seed,
    maxFrames: MAX_FRAMES,
    maxWallTimeMs: WALL_CAP_MS,
    forceWeaponId: weapon,
    floorId: 'floor1',
  });
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
  slackOutcome: string;
  slackSec: number;
  slackWin: boolean;
  diverged: boolean;
  flipWinToLoss: boolean;
  flipLossToWin: boolean;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const rows: Row[] = [];
  const start = Date.now();

  console.log(`A/B: LEGACY vs SLACK_AWARE decision mode`);
  console.log(`Seeds: ${args.seeds.join(',')}  Weapons: ${args.weapons.join(', ')}`);
  console.log(`maxFrames=${MAX_FRAMES}  winBudget=${FLOOR1_TIME_BUDGET_MS / 1000}s (game time)`);
  console.log('='.repeat(78));

  for (const weapon of args.weapons) {
    for (const seed of args.seeds) {
      const legacy = await run(seed, weapon, AIDecisionMode.LEGACY);
      const slack = await run(seed, weapon, AIDecisionMode.SLACK_AWARE);
      const legacyWin = isWin(legacy);
      const slackWin = isWin(slack);
      const row: Row = {
        weapon,
        seed,
        legacyOutcome: legacy.outcome,
        legacySec: Math.round(legacy.gameTimeMs / 1000),
        legacyWin,
        slackOutcome: slack.outcome,
        slackSec: Math.round(slack.gameTimeMs / 1000),
        slackWin,
        diverged: legacy.gameTimeMs !== slack.gameTimeMs || legacy.outcome !== slack.outcome,
        flipWinToLoss: legacyWin && !slackWin,
        flipLossToWin: !legacyWin && slackWin,
      };
      rows.push(row);
      const flag = row.flipWinToLoss
        ? ' ❌WIN→LOSS'
        : row.flipLossToWin
          ? ' ✅LOSS→WIN'
          : row.diverged
            ? ' ~diverged'
            : '';
      console.log(
        `${weapon.padEnd(14)}seed ${String(seed).padEnd(3)} ` +
          `L:${legacy.outcome.padEnd(8)}${String(row.legacySec).padStart(4)}s  ` +
          `S:${slack.outcome.padEnd(8)}${String(row.slackSec).padStart(4)}s${flag}`,
      );
    }
  }

  const flips = rows.filter((r) => r.flipWinToLoss);
  const gains = rows.filter((r) => r.flipLossToWin);
  const diverged = rows.filter((r) => r.diverged);

  console.log('='.repeat(78));
  console.log(`Total pairs:        ${rows.length}`);
  console.log(`Diverged (any):     ${diverged.length}`);
  console.log(`LOSS→WIN (gains):   ${gains.length}`);
  console.log(`WIN→LOSS (flips):   ${flips.length}  <-- HARD GATE: must be 0`);
  for (const w of args.weapons) {
    const wr = rows.filter((r) => r.weapon === w);
    const lWins = wr.filter((r) => r.legacyWin).length;
    const sWins = wr.filter((r) => r.slackWin).length;
    console.log(`  ${w.padEnd(14)} legacy ${lWins}/${wr.length}  slackAware ${sWins}/${wr.length}`);
  }
  console.log(`Wall time: ${((Date.now() - start) / 1000).toFixed(0)}s`);

  if (args.out) {
    writeFileSync(
      args.out,
      JSON.stringify(
        { maxFrames: MAX_FRAMES, budgetMs: FLOOR1_TIME_BUDGET_MS, rows, flips, gains },
        null,
        2,
      ),
    );
    console.log(`Wrote ${args.out}`);
  }

  if (flips.length > 0) {
    console.error(
      `\nFAIL: ${flips.length} win→loss flip(s) — SLACK_AWARE is NOT monotone-safe as configured.`,
    );
    process.exit(1);
  }
  console.log(`\nPASS: zero win→loss flips.`);
}

void main();
