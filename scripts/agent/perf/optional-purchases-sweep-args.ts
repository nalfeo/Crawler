/**
 * Pure, side-effect-free CLI argument parsing for the optional-purchases A/B sweep.
 *
 * Kept in its own module so the parser can be unit-tested without importing the
 * sweep entry-point (which runs `main()` at module load and would kick off real
 * headless simulations on import).
 *
 * Usage
 * -----
 *   npx tsx scripts/agent/perf/optional-purchases-sweep.ts \
 *     --seeds 1,2,3,4,5 \
 *     --optional-purchases \
 *     --max-frames 23760 \
 *     --out shard.json
 */
import { DEFAULT_MAX_FRAMES, parsePositiveInt, parseSeeds } from './winrate-sweep-args.js';

// Re-export so callers that only want the constant don't need to import two modules.
export { DEFAULT_MAX_FRAMES };

export interface OptionalPurchasesSweepArgs {
  /** Seed numbers to run — one headless game per seed. */
  seeds: number[];
  /** Whether the AI may make optional purchases (merchant weapon + Spell Broker). */
  optionalPurchases: boolean;
  /** Maximum simulation frames per run. */
  maxFrames: number;
  /** Path to write the JSON output file; null → stdout / no file. */
  out: string | null;
}

/**
 * Parse sweep CLI args from an `argv` array (entries `[0]`/`[1]` are the node
 * and script paths and are skipped, matching the `process.argv` shape).
 */
export function parseOptionalPurchasesSweepArgs(
  argv: readonly string[],
): OptionalPurchasesSweepArgs {
  const args: OptionalPurchasesSweepArgs = {
    seeds: Array.from({ length: 100 }, (_, i) => i + 1),
    optionalPurchases: false,
    maxFrames: DEFAULT_MAX_FRAMES,
    out: null,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--seeds' && next) {
      args.seeds = parseSeeds(next);
      i++;
    } else if (arg === '--optional-purchases') {
      args.optionalPurchases = true;
    } else if (arg === '--no-optional-purchases') {
      args.optionalPurchases = false;
    } else if (arg === '--max-frames' && next) {
      args.maxFrames = parsePositiveInt('--max-frames', next);
      i++;
    } else if (arg === '--out' && next) {
      args.out = next;
      i++;
    }
  }

  return args;
}
