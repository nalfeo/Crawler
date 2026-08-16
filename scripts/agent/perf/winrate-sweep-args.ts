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
import {
  FLOOR_AGNOSTIC_DEFAULT_MAX_FRAMES,
  getDefaultMaxFrames,
} from '../../../src/game/ai/floor-run-budget.js';
import { getFloorManifest, isFloorImplemented } from '../../../src/shared/floor-registry.js';

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
 * other floor resolves its own manifest-derived cap, or the floor-agnostic runner
 * default when it declares no budget (see `parseSweepArgs`); an explicit
 * `--max-frames` still overrides for every floor. This keeps the Floor-1
 * safe-room fix from silently changing another floor's truncation behavior.
 */
export const DEFAULT_MAX_FRAMES = FLOOR1_DEFAULT_MAX_FRAMES;

/**
 * Placeholder weapon id used when `--no-force-weapon` is active. It is never
 * passed to the runner as a `forceWeaponId`; it exists only so the sweep's
 * `seeds × weapons` task expansion yields exactly one task per seed.
 */
export const SEED_SELECTED_WEAPON = '(seed-selected)';

export interface CLIArgs {
  seeds: number[];
  weapons: string[];
  maxFrames: number;
  /**
   * True when `--max-frames` was supplied explicitly. A chained sweep resolves
   * each floor's own budget-derived cap by default (a short floor's cap must not
   * truncate a long one), so the flag is forwarded as a per-floor cap ONLY when
   * the caller actually asked for a bound.
   */
  maxFramesExplicit: boolean;
  out: string | null;
  enemyDamageMultiplier: number;
  floorId: string;
  workers: number;
  skipEvents: boolean;
  /**
   * When true the sweep does NOT force a starter weapon: each run uses whatever
   * weapon its own seed selects. Used by the PR tier, where weapon spread comes
   * from the seed panel rather than a weapon dimension, so the run count stays
   * `seeds.length` instead of `seeds.length × weapons.length`. Per-weapon
   * balance is measured by the release tier, which still forces weapons.
   */
  forceWeapon: boolean;
  /**
   * When true the sweep chains into subsequent floors on victory, carrying the
   * player over, and a win means reaching the final floor's victory. Used by the
   * progression leg.
   */
  chain: boolean;
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
  const args: CLIArgs = {
    seeds: Array.from({ length: 40 }, (_, i) => i + 1),
    weapons: FLOOR1_WEAPONS,
    maxFrames: DEFAULT_MAX_FRAMES,
    maxFramesExplicit: false,
    out: null,
    enemyDamageMultiplier: 1,
    floorId: 'floor1',
    workers: 1,
    skipEvents: false,
    forceWeapon: true,
    chain: false,
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
      args.maxFramesExplicit = true;
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
    } else if (arg === '--no-force-weapon') {
      args.forceWeapon = false;
    } else if (arg === '--chain') {
      args.chain = true;
    }
  }
  // A sweep is only meaningful on a floor that is implemented end-to-end with an
  // attainable victory; on anything else every run is a guaranteed loss and the
  // reported win-rate is noise. Checked against the manifest rather than a
  // hardcoded id so a newly-completed floor needs no code change here.
  if (!isFloorImplemented(args.floorId)) {
    throw new Error(
      `--floor "${args.floorId}" is not an implemented floor (manifest implemented.mvp !== true); ` +
        `a win-rate sweep on it cannot produce a meaningful rate.`,
    );
  }
  // Weapon defaults come from the floor's own manifest starterWeapons, so a
  // floor sweep never silently runs Floor 1's weapon list.
  if (!weaponsProvided) {
    const manifest = getFloorManifest(args.floorId);
    if (manifest && args.floorId !== 'floor1') {
      args.weapons = [...manifest.starterWeapons];
    }
  }
  // When weapons are not forced, the weapon dimension collapses: each seed runs
  // once with its own seed-selected weapon. Collapsing the list to a single
  // placeholder entry keeps the task-expansion arithmetic (seeds × weapons)
  // correct without special-casing it at every call site.
  if (!args.forceWeapon) {
    args.weapons = [SEED_SELECTED_WEAPON];
  }
  // DEFAULT_MAX_FRAMES carries the Floor-1 safe-room slack (see its docstring).
  // Any other floor resolves its own budget-derived cap from the manifest. A
  // floor that declares no budget falls back to the floor-agnostic runner
  // default rather than Floor 1's cap: inheriting the 6-min Floor-1 bound
  // truncated every Floor-2 release run ~3x short of an achievable clear and
  // reported 0/150 wins as a measurement artifact. An explicit --max-frames
  // overrides for every floor.
  if (!args.maxFramesExplicit && args.floorId !== 'floor1') {
    args.maxFrames = getDefaultMaxFrames(args.floorId) ?? FLOOR_AGNOSTIC_DEFAULT_MAX_FRAMES;
  }
  if (!workersProvided) {
    args.workers = Math.max(1, Math.min(parallelism, args.seeds.length * args.weapons.length));
  }
  return args;
}
