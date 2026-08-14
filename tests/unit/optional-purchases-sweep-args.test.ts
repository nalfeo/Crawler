/**
 * Unit tests for `optional-purchases-sweep-args.ts`.
 *
 * Follows the same pattern as `winrate-sweep-args.test.ts`: pure, side-effect
 * free, no headless simulation.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_FRAMES,
  parseOptionalPurchasesSweepArgs,
} from '../../scripts/agent/perf/optional-purchases-sweep-args.js';

/** Build a process-style argv ([node, script, ...flags]) for the parser. */
function argv(...flags: string[]): string[] {
  return ['node', 'optional-purchases-sweep.ts', ...flags];
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

describe('parseOptionalPurchasesSweepArgs — defaults', () => {
  it('seeds default to 1-100', () => {
    const args = parseOptionalPurchasesSweepArgs(argv());
    expect(args.seeds).toHaveLength(100);
    expect(args.seeds[0]).toBe(1);
    expect(args.seeds[99]).toBe(100);
  });

  it('optionalPurchases defaults to false', () => {
    expect(parseOptionalPurchasesSweepArgs(argv()).optionalPurchases).toBe(false);
  });

  it('maxFrames defaults to DEFAULT_MAX_FRAMES (23760)', () => {
    // DEFAULT_MAX_FRAMES is the Floor-1 budget + 10% safe-room slack; see
    // winrate-sweep-args.ts for the derivation.
    expect(DEFAULT_MAX_FRAMES).toBe(23760);
    expect(parseOptionalPurchasesSweepArgs(argv()).maxFrames).toBe(DEFAULT_MAX_FRAMES);
  });

  it('out defaults to null', () => {
    expect(parseOptionalPurchasesSweepArgs(argv()).out).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// --optional-purchases / --no-optional-purchases
// ---------------------------------------------------------------------------

describe('parseOptionalPurchasesSweepArgs — optionalPurchases flag', () => {
  it('--optional-purchases enables purchases', () => {
    expect(parseOptionalPurchasesSweepArgs(argv('--optional-purchases')).optionalPurchases).toBe(
      true,
    );
  });

  it('--no-optional-purchases keeps purchases disabled', () => {
    expect(parseOptionalPurchasesSweepArgs(argv('--no-optional-purchases')).optionalPurchases).toBe(
      false,
    );
  });

  it('last flag wins when both appear: --optional-purchases --no-optional-purchases', () => {
    expect(
      parseOptionalPurchasesSweepArgs(argv('--optional-purchases', '--no-optional-purchases'))
        .optionalPurchases,
    ).toBe(false);
  });

  it('last flag wins when both appear: --no-optional-purchases --optional-purchases', () => {
    expect(
      parseOptionalPurchasesSweepArgs(argv('--no-optional-purchases', '--optional-purchases'))
        .optionalPurchases,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// --seeds
// ---------------------------------------------------------------------------

describe('parseOptionalPurchasesSweepArgs — --seeds', () => {
  it('accepts a comma-separated list', () => {
    expect(parseOptionalPurchasesSweepArgs(argv('--seeds', '1,5,10')).seeds).toEqual([1, 5, 10]);
  });

  it('accepts a range', () => {
    expect(parseOptionalPurchasesSweepArgs(argv('--seeds', '1-5')).seeds).toEqual([1, 2, 3, 4, 5]);
  });

  it('accepts a mixed range + list', () => {
    expect(parseOptionalPurchasesSweepArgs(argv('--seeds', '1-3,7,9')).seeds).toEqual([
      1, 2, 3, 7, 9,
    ]);
  });

  it('accepts seed 0', () => {
    expect(parseOptionalPurchasesSweepArgs(argv('--seeds', '0,1')).seeds).toEqual([0, 1]);
  });

  it('rejects an empty segment (stray comma)', () => {
    expect(() => parseOptionalPurchasesSweepArgs(argv('--seeds', '1,,3'))).toThrowError(
      /empty seed segment/,
    );
  });
});

// ---------------------------------------------------------------------------
// --max-frames
// ---------------------------------------------------------------------------

describe('parseOptionalPurchasesSweepArgs — --max-frames', () => {
  it('overrides the default', () => {
    expect(parseOptionalPurchasesSweepArgs(argv('--max-frames', '19800')).maxFrames).toBe(19800);
  });

  it('rejects zero', () => {
    expect(() => parseOptionalPurchasesSweepArgs(argv('--max-frames', '0'))).toThrowError(
      /expected a positive integer/,
    );
  });

  it('rejects a non-numeric value', () => {
    expect(() => parseOptionalPurchasesSweepArgs(argv('--max-frames', 'foo'))).toThrowError(
      /expected a positive integer/,
    );
  });

  it('rejects a fractional value', () => {
    expect(() => parseOptionalPurchasesSweepArgs(argv('--max-frames', '1.5'))).toThrowError(
      /expected a positive integer/,
    );
  });
});

// ---------------------------------------------------------------------------
// --out
// ---------------------------------------------------------------------------

describe('parseOptionalPurchasesSweepArgs — --out', () => {
  it('captures the output path', () => {
    expect(parseOptionalPurchasesSweepArgs(argv('--out', 'shard.json')).out).toBe('shard.json');
  });
});

// ---------------------------------------------------------------------------
// Combined flags (workflow invocation shape)
// ---------------------------------------------------------------------------

describe('parseOptionalPurchasesSweepArgs — combined flags', () => {
  it('parses a realistic shard invocation (no purchases)', () => {
    const args = parseOptionalPurchasesSweepArgs(
      argv(
        '--seeds',
        '1-25',
        '--no-optional-purchases',
        '--max-frames',
        '23760',
        '--out',
        'shard-0.json',
      ),
    );
    expect(args.seeds).toHaveLength(25);
    expect(args.seeds[0]).toBe(1);
    expect(args.seeds[24]).toBe(25);
    expect(args.optionalPurchases).toBe(false);
    expect(args.maxFrames).toBe(23760);
    expect(args.out).toBe('shard-0.json');
  });

  it('parses a realistic shard invocation (with purchases)', () => {
    const args = parseOptionalPurchasesSweepArgs(
      argv(
        '--seeds',
        '76-100',
        '--optional-purchases',
        '--max-frames',
        '19800',
        '--out',
        'shard-3.json',
      ),
    );
    expect(args.seeds).toHaveLength(25);
    expect(args.seeds[0]).toBe(76);
    expect(args.seeds[24]).toBe(100);
    expect(args.optionalPurchases).toBe(true);
    expect(args.maxFrames).toBe(19800);
    expect(args.out).toBe('shard-3.json');
  });
});
