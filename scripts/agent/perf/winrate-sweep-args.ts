/**
 * Pure, side-effect-free CLI argument parsing for the Floor 1 win-rate sweep.
 *
 * Kept in its own module (rather than inline in `winrate-sweep.ts`, which runs
 * `sweep(parseSweepArgs(...))` at import time) so the parser can be unit-tested
 * without launching an actual sweep.
 */
import { availableParallelism } from 'node:os';

export const FLOOR1_WEAPONS = ['sword', 'bow', 'baseball-bat'];
/** Floor 1 design budget: 6 minutes of game time at 60 fps. */
export const BUDGET_FRAMES = 21_600;

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
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
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
    const range = part.split('-');
    if (range.length === 2) {
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
  const args: CLIArgs = {
    seeds: Array.from({ length: 40 }, (_, i) => i + 1),
    weapons: FLOOR1_WEAPONS,
    maxFrames: BUDGET_FRAMES,
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
  if (!workersProvided) {
    args.workers = Math.max(1, Math.min(parallelism, args.seeds.length * args.weapons.length));
  }
  return args;
}
