/**
 * Pure, side-effect-free CLI argument parsing for the Floor 1 win-rate sweep.
 *
 * Kept in its own module (rather than inline in `winrate-sweep.ts`, which runs
 * `sweep(parseSweepArgs(...))` at import time) so the parser can be unit-tested
 * without launching an actual sweep.
 */
import { availableParallelism } from 'node:os';
import { GAME } from '../../../src/shared/constants.js';
import {
  FLOOR1_ACTIVE_TIME_BUDGET_MS,
  FLOOR1_DEFAULT_MAX_FRAMES,
} from '../../../src/game/ai/floor1-run-budget.js';

export const FLOOR1_WEAPONS = [
  'sword',
  'bow',
  'baseball-bat',
  'pistol',
  'throwing-knife',
  'fireball',
];
/** Floor 1 design WIN budget: 6 minutes of ACTIVE (safe-room-credited) game time. */
export const FLOOR1_TIME_BUDGET_MS = FLOOR1_ACTIVE_TIME_BUDGET_MS;
/** Floor 1 design WIN budget in frames at 60 fps (`FLOOR1_TIME_BUDGET_MS / GAME.DELTA_MS`). */
export const BUDGET_FRAMES = FLOOR1_TIME_BUDGET_MS / GAME.DELTA_MS;

/**
 * Default simulation frame cap = the win budget + ~10 % slack, computed with the
 * IDENTICAL formula (and therefore the identical value, 23_760) used by
 * sweep-eval.ts and the ab-* / headless Floor-1 harnesses. The FP-safe division
 * form is load-bearing: `Math.ceil(BUDGET_FRAMES * 1.1)` would round up to 23_761
 * because `21_600 * 1.1 === 23760.000000000004`, so the peer formula is kept
 * verbatim to stay byte-for-byte consistent across every Floor-1 sweep.
 *
 * The slack is REQUIRED: the Floor-1 win is safe-room-credited — `isOfficialWin`
 * compares `gameTimeMs - safeRoomMs` against the 6-min budget, so a legitimate
 * clear can run PAST 360 s of RAW game time while still being under the ACTIVE
 * budget. Capping the sim at exactly BUDGET_FRAMES (360 s raw) would
 * force-terminate those safe-room-credited wins before they finish and miscount
 * them as timeouts — biasing the reported win rate DOWN, the opposite of the
 * safe-room win-definition fix's intent.
 *
 * This slack cap is derived from the Floor-1 budget + the Floor-1 safe-room-credited
 * win definition, so it is applied ONLY when `--floor floor1` (the default). Any
 * other floor retains the prior `BUDGET_FRAMES` default (see `parseSweepArgs`); an
 * explicit `--max-frames` still overrides for every floor. This keeps the Floor-1
 * safe-room fix from silently changing another floor's truncation behavior.
 */
export const DEFAULT_MAX_FRAMES = FLOOR1_DEFAULT_MAX_FRAMES;

export interface CLIArgs {
  seeds: number[];
  weapons: string[];
  maxFrames: number;
  out: string | null;
  enemyDamageMultiplier: number;
  floorId: string;
  workers: number;
  skipEvents: boolean;
}

/**
 * Parse a strictly-positive integer CLI value, throwing an actionable error on
 * non-numeric / non-integer / non-positive input.
 *
 * Uses `Number` (not `parseInt`) so partially-numeric junk like `4abc` is
 * rejected instead of silently truncated to `4`, and — critically — so a
 * non-numeric `--workers foo` fails fast with a clear message instead of
 * yielding `NaN`. The old `Math.max(1, parseInt(next, 10))` let `NaN` through,
 * which made `concurrency` `NaN` in the worker pool, so the `inFlight <
 * concurrency` guard was always false, no worker ever launched, and the sweep
 * hung silently after printing its header.
 */
export function parsePositiveInt(flag: string, raw: string): number {
  // `Number('')` and `Number('   ')` both coerce to `0`, so a blank / whitespace
  // segment must be rejected explicitly before the numeric check to avoid a
  // misleading "expected a positive integer" path on empty input.
  if (raw.trim() === '') {
    throw new Error(`Invalid ${flag} value ${JSON.stringify(raw)}: expected a positive integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid ${flag} value ${JSON.stringify(raw)}: expected a positive integer.`);
  }
  return value;
}

/**
 * Parse a non-negative integer CLI value (allows `0`), throwing on
 * non-numeric / non-integer / negative input. Used for seeds, where `0` is a
 * legitimate seed value.
 */
export function parseNonNegativeInt(flag: string, raw: string): number {
  // `Number('')` / `Number('   ')` coerce to `0`, which would silently pass the
  // `>= 0` check and inject a bogus `0` (e.g. a blank seed segment becoming seed
  // `0`). Reject blank / whitespace-only input explicitly before coercion.
  if (raw.trim() === '') {
    throw new Error(
      `Invalid ${flag} value ${JSON.stringify(raw)}: expected a non-negative integer.`,
    );
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `Invalid ${flag} value ${JSON.stringify(raw)}: expected a non-negative integer.`,
    );
  }
  return value;
}

/**
 * Parse a finite, non-negative number (fractional allowed; `0` allowed for
 * "no hostile damage"), throwing on non-numeric / negative / infinite input.
 */
export function parseNonNegativeNumber(flag: string, raw: string): number {
  // Same blank-coerces-to-`0` hazard as parseNonNegativeInt (see above).
  if (raw.trim() === '') {
    throw new Error(
      `Invalid ${flag} value ${JSON.stringify(raw)}: expected a non-negative number.`,
    );
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `Invalid ${flag} value ${JSON.stringify(raw)}: expected a non-negative number.`,
    );
  }
  return value;
}

export function parseSeeds(spec: string): number[] {
  const seeds: number[] = [];
  for (const part of spec.split(',')) {
    // Reject blank CSV segments up front so a stray / doubled comma (`1,,3`,
    // `1,`, `,2`) fails loudly instead of silently expanding to seed `0`.
    if (part.trim() === '') {
      throw new Error(
        `Invalid --seeds value ${JSON.stringify(spec)}: empty seed segment (check for stray or doubled commas).`,
      );
    }
    const range = part.split('-');
    if (range.length === 2) {
      // Blank range endpoints (`1-`, `-3`) are rejected by parseNonNegativeInt.
      const lo = parseNonNegativeInt('--seeds', range[0]!);
      const hi = parseNonNegativeInt('--seeds', range[1]!);
      for (let s = lo; s <= hi; s++) seeds.push(s);
    } else {
      seeds.push(parseNonNegativeInt('--seeds', part));
    }
  }
  return seeds;
}

/**
 * Parse sweep CLI args from an `argv` array (defaults to the process argv shape:
 * entries `[0]`/`[1]` are the node + script paths and are skipped).
 *
 * `parallelism` is injected (defaulting to `os.availableParallelism()`) so the
 * default-worker-count branch is deterministic under test.
 */
export function parseSweepArgs(
  argv: readonly string[],
  parallelism: number = availableParallelism(),
): CLIArgs {
  let weaponsProvided = false;
  let workersProvided = false;
  let maxFramesProvided = false;
  const args: CLIArgs = {
    seeds: Array.from({ length: 40 }, (_, i) => i + 1),
    weapons: FLOOR1_WEAPONS,
    maxFrames: DEFAULT_MAX_FRAMES,
    out: null,
    enemyDamageMultiplier: 1,
    floorId: 'floor1',
    workers: 1,
    skipEvents: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--seeds' && next) {
      args.seeds = parseSeeds(next);
      i++;
    } else if (arg === '--weapons' && next) {
      args.weapons = next.split(',');
      weaponsProvided = true;
      i++;
    } else if (arg === '--max-frames' && next) {
      args.maxFrames = parsePositiveInt('--max-frames', next);
      maxFramesProvided = true;
      i++;
    } else if (arg === '--out' && next) {
      args.out = next;
      i++;
    } else if (arg === '--enemy-damage-multiplier' && next) {
      args.enemyDamageMultiplier = parseNonNegativeNumber('--enemy-damage-multiplier', next);
      i++;
    } else if (arg === '--floor' && next) {
      args.floorId = next;
      i++;
    } else if (arg === '--workers' && next) {
      args.workers = parsePositiveInt('--workers', next);
      workersProvided = true;
      i++;
    } else if (arg === '--skip-events') {
      args.skipEvents = true;
    }
  }
  if (
    args.floorId === 'floor2' &&
    !weaponsProvided &&
    args.weapons.length === FLOOR1_WEAPONS.length
  ) {
    args.weapons = ['sword'];
  }
  // DEFAULT_MAX_FRAMES carries the Floor-1 safe-room slack (see its docstring) and
  // is Floor-1-specific. A non-Floor-1 sweep that did not explicitly pass
  // --max-frames retains the prior BUDGET_FRAMES default, so this Floor-1-scoped
  // safe-room win-definition fix never silently alters another floor's truncation
  // behavior. An explicit --max-frames overrides for every floor.
  if (!maxFramesProvided && args.floorId !== 'floor1') {
    args.maxFrames = BUDGET_FRAMES;
  }
  if (!workersProvided) {
    args.workers = Math.max(1, Math.min(parallelism, args.seeds.length * args.weapons.length));
  }
  return args;
}
