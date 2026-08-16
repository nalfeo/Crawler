import { describe, expect, it } from 'vitest';

import {
  BUDGET_FRAMES,
  DEFAULT_MAX_FRAMES,
  FLOOR1_WEAPONS,
  parseNonNegativeInt,
  parseNonNegativeNumber,
  parsePositiveInt,
  parseSeeds,
  parseSweepArgs,
} from '../../scripts/agent/perf/winrate-sweep-args.js';
import { FLOOR_AGNOSTIC_DEFAULT_MAX_FRAMES } from '../../src/game/ai/floor-run-budget.js';

/** Build a process-style argv (`[node, script, ...flags]`) for the parser. */
function argv(...flags: string[]): string[] {
  return ['node', 'winrate-sweep.ts', ...flags];
}

describe('parseSweepArgs — --workers validation (regression: NaN hang)', () => {
  it('throws an actionable error on non-numeric --workers (e.g. foo)', () => {
    expect(() => parseSweepArgs(argv('--workers', 'foo'), 8)).toThrowError(
      /Invalid --workers value "foo": expected a positive integer\./,
    );
  });

  it('throws on partially-numeric --workers (e.g. 4abc) instead of truncating to 4', () => {
    expect(() => parseSweepArgs(argv('--workers', '4abc'), 8)).toThrowError(/Invalid --workers/);
  });

  it('throws on --workers 0', () => {
    expect(() => parseSweepArgs(argv('--workers', '0'), 8)).toThrowError(
      /Invalid --workers value "0": expected a positive integer\./,
    );
  });

  it('throws on negative --workers', () => {
    expect(() => parseSweepArgs(argv('--workers', '-3'), 8)).toThrowError(/Invalid --workers/);
  });

  it('throws on fractional --workers', () => {
    expect(() => parseSweepArgs(argv('--workers', '2.5'), 8)).toThrowError(/Invalid --workers/);
  });

  it('accepts a valid positive integer --workers', () => {
    expect(parseSweepArgs(argv('--workers', '4'), 8).workers).toBe(4);
  });
});

describe('parseSweepArgs — default worker count', () => {
  it('defaults to min(parallelism, seeds*weapons) when --workers is omitted', () => {
    // 2 seeds x 6 default weapons = 12 tasks; parallelism 8 -> capped at 8.
    const args = parseSweepArgs(argv('--seeds', '1-2'), 8);
    expect(args.workers).toBe(8);
  });

  it('caps the default at the injected parallelism when tasks exceed cores', () => {
    // 40 default seeds x 6 weapons = 240 tasks; parallelism 4 -> 4.
    expect(parseSweepArgs(argv(), 4).workers).toBe(4);
  });

  it('never returns fewer than 1 default worker', () => {
    expect(parseSweepArgs(argv('--seeds', '1-1', '--weapons', 'sword'), 0).workers).toBe(1);
  });
});

describe('parseSweepArgs — other numeric flags', () => {
  it('throws on non-numeric --max-frames', () => {
    expect(() => parseSweepArgs(argv('--max-frames', 'foo'), 8)).toThrowError(
      /Invalid --max-frames/,
    );
  });

  it('throws on --max-frames 0', () => {
    expect(() => parseSweepArgs(argv('--max-frames', '0'), 8)).toThrowError(/Invalid --max-frames/);
  });

  it('accepts a valid --max-frames', () => {
    expect(parseSweepArgs(argv('--max-frames', '600'), 8).maxFrames).toBe(600);
  });

  it('throws on negative --enemy-damage-multiplier but allows 0', () => {
    expect(() => parseSweepArgs(argv('--enemy-damage-multiplier', '-1'), 8)).toThrowError(
      /Invalid --enemy-damage-multiplier/,
    );
    expect(parseSweepArgs(argv('--enemy-damage-multiplier', '0'), 8).enemyDamageMultiplier).toBe(0);
    expect(parseSweepArgs(argv('--enemy-damage-multiplier', '1.5'), 8).enemyDamageMultiplier).toBe(
      1.5,
    );
  });
});

describe('parseSweepArgs — defaults and flags', () => {
  it('applies documented defaults when no flags are given', () => {
    const args = parseSweepArgs(argv(), 1);
    expect(args.seeds).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(args.weapons).toEqual(FLOOR1_WEAPONS);
    expect(args.maxFrames).toBe(DEFAULT_MAX_FRAMES);
    expect(args.out).toBeNull();
    expect(args.floorId).toBe('floor1');
    expect(args.skipEvents).toBe(false);
  });

  it('defaults maxFrames to the ~10% slack budget, not the raw win budget (safe-room-credited wins must not be truncated)', () => {
    // The Floor-1 win is safe-room-credited: isOfficialWin compares
    // (gameTimeMs - safeRoomMs) against the 6-min budget, so a legitimate clear
    // can exceed 360 s of RAW game time. Capping the sim at exactly BUDGET_FRAMES
    // (360 s raw) would force-terminate those wins before isOfficialWin sees
    // them, miscounting them as timeouts and biasing the win rate down. The
    // default must carry the same ~1.1x slack as the peer Floor-1 harnesses.
    expect(DEFAULT_MAX_FRAMES).toBe(23_760);
    expect(DEFAULT_MAX_FRAMES).toBeGreaterThan(BUDGET_FRAMES);
    expect(parseSweepArgs(argv(), 1).maxFrames).toBe(DEFAULT_MAX_FRAMES);
  });

  it('parses --skip-events as a boolean flag', () => {
    expect(parseSweepArgs(argv('--skip-events'), 8).skipEvents).toBe(true);
  });

  it('splits --weapons on commas', () => {
    expect(parseSweepArgs(argv('--weapons', 'sword,bow'), 8).weapons).toEqual(['sword', 'bow']);
  });

  it("defaults a non-floor1 sweep to that floor's own manifest starterWeapons", () => {
    // Previously hardcoded to ['sword']. Sourcing the default from the floor's
    // own manifest means a floor sweep never silently runs Floor 1's weapon
    // list, and a manifest weapon change needs no code change here.
    expect(parseSweepArgs(argv('--floor', 'floor2'), 8).weapons).toEqual([
      'sword',
      'knife',
      'bow',
      'pistol',
      'throwing-knife',
    ]);
  });

  it('collapses the weapon dimension to one task per seed under --no-force-weapon', () => {
    // The PR tier does not force a starter weapon: each seed runs once with its
    // own seed-selected weapon, so run count stays `seeds`, not seeds × weapons.
    const args = parseSweepArgs(argv('--no-force-weapon'), 8);
    expect(args.forceWeapon).toBe(false);
    expect(args.weapons).toHaveLength(1);
  });

  it('parses --chain as a boolean flag', () => {
    expect(parseSweepArgs(argv('--chain'), 8).chain).toBe(true);
    expect(parseSweepArgs(argv(), 8).chain).toBe(false);
  });

  it('rejects a sweep on a floor that is not implemented E2E', () => {
    // Every run on an unfinishable floor is a guaranteed loss, so the reported
    // win-rate would be meaningless noise.
    expect(() => parseSweepArgs(argv('--floor', 'floor3'), 1)).toThrow(/not an implemented floor/);
  });

  it('scopes the DEFAULT_MAX_FRAMES slack cap to floor1 and gives an unbudgeted floor the runner default', () => {
    // DEFAULT_MAX_FRAMES carries the Floor-1 safe-room slack, so it must NOT leak
    // into other floors. A floor that declares no manifest win budget must also
    // NOT inherit Floor 1's 6-min cap: doing so truncated every Floor-2 release
    // run ~3x short of an achievable clear and reported 0/150 wins as a pure
    // measurement artifact. It falls back to the floor-agnostic runner default
    // instead, which is the same bound the chained sweep leg already resolves.
    expect(parseSweepArgs(argv(), 1).maxFrames).toBe(DEFAULT_MAX_FRAMES); // floor1 (default)
    expect(parseSweepArgs(argv('--floor', 'floor1'), 1).maxFrames).toBe(DEFAULT_MAX_FRAMES);
    const floor2Frames = parseSweepArgs(argv('--floor', 'floor2'), 1).maxFrames;
    expect(floor2Frames).toBe(FLOOR_AGNOSTIC_DEFAULT_MAX_FRAMES);
    expect(floor2Frames).not.toBe(BUDGET_FRAMES);
    expect(floor2Frames).not.toBe(DEFAULT_MAX_FRAMES);
  });

  it('lets an explicit --max-frames override the floor-aware default for any floor', () => {
    expect(parseSweepArgs(argv('--floor', 'floor2', '--max-frames', '600'), 1).maxFrames).toBe(600);
    expect(parseSweepArgs(argv('--floor', 'floor1', '--max-frames', '600'), 1).maxFrames).toBe(600);
  });
});

describe('parseSeeds', () => {
  it('expands inclusive ranges', () => {
    expect(parseSeeds('1-3')).toEqual([1, 2, 3]);
  });

  it('parses comma lists and mixed ranges', () => {
    expect(parseSeeds('1,5,7-9')).toEqual([1, 5, 7, 8, 9]);
  });

  it('allows seed 0', () => {
    expect(parseSeeds('0-2')).toEqual([0, 1, 2]);
  });

  it('throws on non-numeric seed tokens', () => {
    expect(() => parseSeeds('1,foo,3')).toThrowError(/Invalid --seeds/);
  });

  it('rejects blank / doubled-comma segments instead of injecting seed 0', () => {
    // Regression: `Number('')` coerces to 0, which previously let a stray or
    // doubled comma silently expand into a bogus seed `0` and skew the panel.
    expect(() => parseSeeds('1,')).toThrowError(/empty seed segment/);
    expect(() => parseSeeds(',2')).toThrowError(/empty seed segment/);
    expect(() => parseSeeds('1,,3')).toThrowError(/empty seed segment/);
    expect(() => parseSeeds('   ')).toThrowError(/empty seed segment/);
  });

  it('rejects blank range endpoints', () => {
    expect(() => parseSeeds('1-')).toThrowError(/Invalid --seeds/);
    expect(() => parseSeeds('-3')).toThrowError(/Invalid --seeds/);
    expect(() => parseSeeds('1- ')).toThrowError(/Invalid --seeds/);
  });
});

describe('numeric validators', () => {
  it('parsePositiveInt rejects NaN / <=0 / blank and accepts positive integers', () => {
    expect(() => parsePositiveInt('--x', 'foo')).toThrow();
    expect(() => parsePositiveInt('--x', '0')).toThrow();
    expect(() => parsePositiveInt('--x', '')).toThrow();
    expect(() => parsePositiveInt('--x', '   ')).toThrow();
    expect(parsePositiveInt('--x', '12')).toBe(12);
  });

  it('parsePositiveInt rejects integers beyond MAX_SAFE_INTEGER to prevent run-id corruption (e.g. 9007199254740993 serialises as 9007199254740992)', () => {
    // Number(String(MAX_SAFE_INTEGER + 2)) rounds to MAX_SAFE_INTEGER + 2 per
    // IEEE 754 (actually to MAX_SAFE_INTEGER + 2, but JS can't represent it
    // exactly — Number.isInteger passes while Number.isSafeInteger fails).
    const unsafeAbove = String(Number.MAX_SAFE_INTEGER + 2);
    expect(() => parsePositiveInt('--resume-run-id', unsafeAbove)).toThrow(
      /expected a positive integer/,
    );
    // The boundary itself (MAX_SAFE_INTEGER) is safe and must be accepted.
    expect(parsePositiveInt('--resume-run-id', String(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it('parseNonNegativeInt rejects blank / non-integer / negative and accepts 0 and positive integers', () => {
    // Regression: blank / whitespace must not coerce to a silent `0`.
    expect(() => parseNonNegativeInt('--rounds', '')).toThrow();
    expect(() => parseNonNegativeInt('--rounds', '   ')).toThrow();
    expect(() => parseNonNegativeInt('--rounds', '-1')).toThrow();
    expect(() => parseNonNegativeInt('--rounds', '1.5')).toThrow();
    expect(parseNonNegativeInt('--rounds', '0')).toBe(0);
    expect(parseNonNegativeInt('--rounds', '3')).toBe(3);
  });

  it('parseNonNegativeNumber rejects negative / infinite / blank and accepts 0 and fractions', () => {
    expect(() => parseNonNegativeNumber('--x', 'Infinity')).toThrow();
    expect(() => parseNonNegativeNumber('--x', '-0.5')).toThrow();
    expect(() => parseNonNegativeNumber('--x', '')).toThrow();
    expect(() => parseNonNegativeNumber('--x', '  ')).toThrow();
    expect(parseNonNegativeNumber('--x', '0')).toBe(0);
    expect(parseNonNegativeNumber('--x', '2.25')).toBe(2.25);
  });
});
