import { describe, expect, it } from 'vitest';
import {
  classifyRunTermination,
  parseArgs,
  selectMainThreadProfile,
} from '../../scripts/agent/perf/profile-headless.js';
import {
  formatSummary,
  HARNESS_OVERHEAD_WARN_PCT,
  mergeSummaries,
  predictCeiling,
  summarizeProfile,
  type CpuProfile,
  type CpuProfileNode,
} from '../../scripts/agent/perf/profile-analyze-lib.js';

/** Build a profile node with sane defaults. */
function node(
  id: number,
  functionName: string,
  options: { children?: number[]; url?: string; line?: number; hitCount?: number } = {},
): CpuProfileNode {
  return {
    id,
    callFrame: {
      functionName,
      url: options.url ?? `file:///repo/src/${functionName}.ts`,
      lineNumber: options.line ?? 0,
    },
    hitCount: options.hitCount ?? 0,
    ...(options.children ? { children: options.children } : {}),
  };
}

/**
 * (root) -> a -> b
 *              -> c
 * 10 samples: 2 in a's body, 5 in b, 3 in c. Every delta is 1000us = 1ms.
 */
function simpleProfile(): CpuProfile {
  return {
    nodes: [
      node(1, '(root)', { children: [2] }),
      node(2, 'a', { children: [3, 4] }),
      node(3, 'b'),
      node(4, 'c'),
    ],
    samples: [2, 2, 3, 3, 3, 3, 3, 4, 4, 4],
    timeDeltas: Array.from({ length: 10 }, () => 1000),
  };
}

function costFor(summary: ReturnType<typeof summarizeProfile>, name: string) {
  const found = summary.functions.find((f) => f.functionName === name);
  if (!found) throw new Error(`no cost recorded for ${name}`);
  return found;
}

describe('summarizeProfile', () => {
  it('attributes self time from timeDeltas and reports the timing source', () => {
    const summary = summarizeProfile(simpleProfile());

    expect(summary.timingSource).toBe('timeDeltas');
    expect(summary.sampleCount).toBe(10);
    expect(summary.totalMs).toBeCloseTo(10, 6);
    expect(costFor(summary, 'a').selfMs).toBeCloseTo(2, 6);
    expect(costFor(summary, 'b').selfMs).toBeCloseTo(5, 6);
    expect(costFor(summary, 'c').selfMs).toBeCloseTo(3, 6);
    expect(costFor(summary, 'b').selfPct).toBeCloseTo(50, 6);
  });

  it('falls back to hitCount when timeDeltas are absent', () => {
    const summary = summarizeProfile({
      nodes: [
        node(1, '(root)', { children: [2] }),
        node(2, 'a', { hitCount: 1 }),
        node(3, 'b', { hitCount: 3 }),
      ],
      startTime: 0,
      endTime: 4000,
      samples: [2, 3, 3, 3],
    });

    expect(summary.timingSource).toBe('hitCount');
    expect(summary.totalMs).toBeCloseTo(4, 6);
    expect(costFor(summary, 'b').selfMs).toBeCloseTo(3, 6);
  });

  it('credits inclusive time to the whole call tree, not just the leaf', () => {
    const summary = summarizeProfile(simpleProfile());

    // `a` executes for only 2ms itself but owns all 10ms of its subtree.
    expect(costFor(summary, 'a').selfMs).toBeCloseTo(2, 6);
    expect(costFor(summary, 'a').totalMs).toBeCloseTo(10, 6);
    expect(costFor(summary, 'a').totalPct).toBeCloseTo(100, 6);
    // A leaf's total equals its self time.
    expect(costFor(summary, 'c').totalMs).toBeCloseTo(costFor(summary, 'c').selfMs, 6);
  });

  it('ranks by self time descending', () => {
    const names = summarizeProfile(simpleProfile())
      .functions.filter((f) => f.functionName !== '(root)')
      .map((f) => f.functionName);

    expect(names).toEqual(['b', 'c', 'a']);
  });

  it('does not double-count recursion in inclusive time', () => {
    // recurse -> recurse -> leaf, all three sampled once (3ms total).
    const summary = summarizeProfile({
      nodes: [
        node(1, '(root)', { children: [2] }),
        node(2, 'recurse', { children: [3] }),
        node(3, 'recurse', { children: [4] }),
        node(4, 'leaf'),
      ],
      samples: [2, 3, 4],
      timeDeltas: [1000, 1000, 1000],
    });

    // Naive per-node summing would credit recurse 3ms (outer) + 2ms (inner) = 5ms,
    // which exceeds the 3ms profile. Only the outermost frame may be credited.
    expect(costFor(summary, 'recurse').totalMs).toBeCloseTo(3, 6);
    expect(costFor(summary, 'recurse').totalPct).toBeLessThanOrEqual(100);
    expect(costFor(summary, 'recurse').selfMs).toBeCloseTo(2, 6);
  });

  it('separates same-named functions from different locations', () => {
    const summary = summarizeProfile({
      nodes: [
        node(1, '(root)', { children: [2, 3] }),
        node(2, 'compute', { url: 'file:///repo/node_modules/rot-js/dist/rot.js', line: 5355 }),
        node(3, 'compute', { url: 'file:///repo/src/core/other.ts', line: 11 }),
      ],
      samples: [2, 2, 3],
      timeDeltas: [1000, 1000, 1000],
    });

    const computes = summary.functions.filter((f) => f.functionName === 'compute');
    expect(computes).toHaveLength(2);
    expect(computes.map((f) => f.selfMs).sort()).toEqual([1, 2]);
  });

  it('trims urls to repo-relative paths so keys are checkout-independent', () => {
    const summary = summarizeProfile({
      nodes: [
        node(1, '(root)', { children: [2] }),
        node(2, 'fovSystem', {
          url: 'file:///C:/anywhere/src/core/systems/fovSystem.ts',
          line: 75,
        }),
      ],
      samples: [2],
      timeDeltas: [1000],
    });

    expect(costFor(summary, 'fovSystem').location).toBe('src/core/systems/fovSystem.ts:76');
  });

  it('measures Node/tsx/esbuild startup as harness overhead', () => {
    const summary = summarizeProfile({
      nodes: [
        node(1, '(root)', { children: [2, 3] }),
        node(2, 'readFileSync', { url: 'node:fs', line: 433 }),
        node(3, 'gameWork'),
      ],
      samples: [2, 2, 3, 3, 3, 3, 3, 3, 3, 3],
      timeDeltas: Array.from({ length: 10 }, () => 1000),
    });

    expect(summary.harnessOverheadPct).toBeCloseTo(20, 6);
  });

  it('returns an empty summary for a profile with no samples', () => {
    const summary = summarizeProfile({ nodes: [node(1, '(root)')], samples: [], timeDeltas: [] });

    expect(summary.sampleCount).toBe(0);
    expect(summary.totalMs).toBe(0);
    expect(summary.harnessOverheadPct).toBe(0);
  });
});

describe('mergeSummaries', () => {
  it('sums cost across runs and recomputes shares against the combined total', () => {
    const merged = mergeSummaries([
      summarizeProfile(simpleProfile()),
      summarizeProfile(simpleProfile()),
    ]);

    expect(merged.runCount).toBe(2);
    expect(merged.sampleCount).toBe(20);
    expect(merged.totalMs).toBeCloseTo(20, 6);
    expect(costFor(merged, 'b').selfMs).toBeCloseTo(10, 6);
    // Share is unchanged: doubling identical runs must not double a percentage.
    expect(costFor(merged, 'b').selfPct).toBeCloseTo(50, 6);
  });

  it('reports the weaker timing source when runs disagree', () => {
    const precise = summarizeProfile(simpleProfile());
    const coarse = summarizeProfile({
      nodes: [node(1, '(root)', { children: [2] }), node(2, 'a', { hitCount: 1 })],
      startTime: 0,
      endTime: 1000,
      samples: [2],
    });

    expect(mergeSummaries([precise, coarse]).timingSource).toBe('hitCount');
    expect(mergeSummaries([precise, precise]).timingSource).toBe('timeDeltas');
  });

  it('returns an empty summary for no inputs and passes a single input through', () => {
    expect(mergeSummaries([]).runCount).toBe(0);
    const one = summarizeProfile(simpleProfile());
    expect(mergeSummaries([one])).toBe(one);
  });
});

describe('predictCeiling', () => {
  it('applies Amdahl to the attributable share', () => {
    // The first agent run: a 2.9% target made 3x faster caps out under 2%.
    expect(predictCeiling(2.9, 3)).toBeCloseTo(1.933, 3);
    expect(predictCeiling(21.3, 2)).toBeCloseTo(10.65, 3);
  });

  it('caps at the share itself when the component becomes free', () => {
    expect(predictCeiling(21.3, Infinity)).toBe(21.3);
  });

  it('returns zero for a no-op speedup', () => {
    expect(predictCeiling(50, 1)).toBe(0);
  });

  it('rejects a slowdown or a nonsensical share', () => {
    expect(() => predictCeiling(10, 0.5)).toThrow(/speedup/);
    expect(() => predictCeiling(10, Number.NaN)).toThrow(/speedup/);
    expect(() => predictCeiling(-1, 2)).toThrow(/sharePct/);
    expect(() => predictCeiling(Number.NaN, 2)).toThrow(/sharePct/);
    // A share above 100% is impossible and would produce authoritative-looking
    // nonsense (e.g. "150% end-to-end win") from malformed profile input.
    expect(() => predictCeiling(101, 2)).toThrow(/sharePct/);
    expect(() => predictCeiling(150, Infinity)).toThrow(/sharePct/);
  });
});

describe('formatSummary', () => {
  it('reports overhead without alarming below the warn threshold', () => {
    const output = formatSummary(summarizeProfile(simpleProfile()));

    expect(output).toContain('startup overhead: 0.0%');
    expect(output).not.toContain('⚠️');
  });

  it('warns when startup overhead is large enough to reorder the ranking', () => {
    const harnessSamples = Array.from({ length: 50 }, () => 2);
    const output = formatSummary(
      summarizeProfile({
        nodes: [
          node(1, '(root)', { children: [2, 3] }),
          node(2, 'openSync', { url: 'node:fs', line: 559 }),
          node(3, 'gameWork'),
        ],
        samples: [...harnessSamples, 3],
        timeDeltas: Array.from({ length: 51 }, () => 1000),
      }),
    );

    expect(output).toContain('⚠️');
    expect(output).toMatch(/REORDERING/);
  });

  it('can rank by total time instead of self time', () => {
    const bySelf = formatSummary(summarizeProfile(simpleProfile()), { top: 1, sortBy: 'self' });
    const byTotal = formatSummary(summarizeProfile(simpleProfile()), { top: 2, sortBy: 'total' });

    // `b` is the hottest leaf; `(root)`/`a` own the biggest trees.
    expect(bySelf).toContain('b');
    expect(byTotal).toContain('a');
  });

  it('keeps the warn threshold in a range that leaves the signal meaningful', () => {
    // Calibrated between the ~10% default panel and a ~36% truncated run.
    expect(HARNESS_OVERHEAD_WARN_PCT).toBeGreaterThan(10);
    expect(HARNESS_OVERHEAD_WARN_PCT).toBeLessThan(36);
  });
});

/**
 * Regression suite for the target-misidentification defect.
 *
 * A profile once reported `compute @ node_modules/rot-js/dist/rot.js:5356` at
 * ~20% self. That is `AStar.compute` (pathfinding), but the bare name was read
 * as `RecursiveShadowcasting.compute` (FOV) — a system that turned out to be
 * 1.88% of the run. A whole optimization pass went to the wrong target. These
 * tests pin the attribution that makes the confusion visible.
 */
describe('dependency-frame attribution', () => {
  /** src/pathfinding -> rot-js `compute`, and src/fov -> a different rot-js frame. */
  function rotJsProfile(): CpuProfile {
    return {
      nodes: [
        node(1, '(root)', { children: [2, 4] }),
        node(2, 'findTilePath', { url: 'file:///repo/src/core/map/pathfinding.ts', children: [3] }),
        node(3, 'compute', { url: 'file:///repo/node_modules/rot-js/dist/rot.js', line: 5355 }),
        node(4, 'fovSystem', {
          url: 'file:///repo/src/core/systems/fovSystem.ts',
          children: [5],
        }),
        node(5, 'compute', { url: 'file:///repo/node_modules/rot-js/dist/rot.js', line: 2000 }),
      ],
      samples: [3, 3, 3, 3, 3, 3, 3, 3, 3, 5],
      timeDeltas: Array.from({ length: 10 }, () => 1000),
    };
  }

  it('names the project caller of a dependency frame', () => {
    const summary = summarizeProfile(rotJsProfile());
    const hot = summary.functions.find((f) => f.location.endsWith('rot.js:5356'))!;

    expect(hot.functionName).toBe('compute');
    expect(hot.owners?.map((o) => o.functionName)).toEqual(['findTilePath']);
    expect(hot.owners?.[0]!.selfMs).toBeCloseTo(9, 6);
  });

  it('keeps two same-named dependency frames attributed to different owners', () => {
    // This is the exact confusion that caused the misfire: one bundled file,
    // one function name, two entirely unrelated subsystems paying for it.
    const summary = summarizeProfile(rotJsProfile());
    const byLine = summary.functions.filter((f) => f.functionName === 'compute');

    expect(byLine).toHaveLength(2);
    const owners = byLine.map((f) => f.owners?.[0]?.functionName).sort();
    expect(owners).toEqual(['findTilePath', 'fovSystem']);
  });

  it('does not attribute owners to project-owned or native frames', () => {
    const summary = summarizeProfile(rotJsProfile());

    expect(costFor(summary, 'findTilePath').owners).toBeUndefined();
    expect(costFor(summary, 'fovSystem').owners).toBeUndefined();
  });

  it('walks past intermediate dependency frames to the nearest project caller', () => {
    const summary = summarizeProfile({
      nodes: [
        node(1, '(root)', { children: [2] }),
        node(2, 'findTilePath', { url: 'file:///repo/src/core/map/pathfinding.ts', children: [3] }),
        node(3, '_add', { url: 'file:///repo/node_modules/rot-js/dist/rot.js', children: [4] }),
        node(4, 'push', { url: 'file:///repo/node_modules/rot-js/dist/rot.js', line: 10 }),
      ],
      samples: [4, 4],
      timeDeltas: [1000, 1000],
    });
    const leaf = summary.functions.find((f) => f.functionName === 'push')!;

    expect(leaf.owners?.[0]!.functionName).toBe('findTilePath');
  });

  it('splits one dependency frame across several project callers', () => {
    const summary = summarizeProfile({
      nodes: [
        node(1, '(root)', { children: [2, 4] }),
        node(2, 'findTilePath', { url: 'file:///repo/src/a.ts', children: [3] }),
        node(3, 'compute', { url: 'file:///repo/node_modules/rot-js/dist/rot.js', line: 5355 }),
        node(4, 'planRoute', { url: 'file:///repo/src/b.ts', children: [5] }),
        node(5, 'compute', { url: 'file:///repo/node_modules/rot-js/dist/rot.js', line: 5355 }),
      ],
      samples: [3, 3, 3, 5],
      timeDeltas: Array.from({ length: 4 }, () => 1000),
    });
    // Same key (same name + location), so both nodes fold into one row.
    const hot = summary.functions.find((f) => f.functionName === 'compute')!;

    expect(hot.owners).toHaveLength(2);
    // Ranked by cost, so the dominant caller is always first.
    expect(hot.owners![0]!.functionName).toBe('findTilePath');
    expect(hot.owners![0]!.selfMs).toBeCloseTo(3, 6);
    expect(hot.owners![1]!.functionName).toBe('planRoute');
  });

  it('preserves and sums owners through mergeSummaries', () => {
    const merged = mergeSummaries([
      summarizeProfile(rotJsProfile()),
      summarizeProfile(rotJsProfile()),
    ]);
    const hot = merged.functions.find((f) => f.location.endsWith('rot.js:5356'))!;

    expect(hot.owners?.[0]!.functionName).toBe('findTilePath');
    expect(hot.owners?.[0]!.selfMs).toBeCloseTo(18, 6);
  });

  it('does not invent rows for callers during a merge', () => {
    const merged = mergeSummaries([
      summarizeProfile(rotJsProfile()),
      summarizeProfile(rotJsProfile()),
    ]);
    const names = merged.functions.map((f) => f.key);

    expect(new Set(names).size).toBe(names.length);
    expect(merged.functions.every((f) => f.selfMs > 0 || f.totalMs > 0)).toBe(true);
  });

  it('attributes a zero-self-time dependency frame to its project caller', () => {
    // With --sort total, a dep frame whose cost is entirely in a child still
    // appears in the table.  It must show its project caller, not
    // "no project caller".
    const summary = summarizeProfile({
      nodes: [
        node(1, '(root)', { children: [2] }),
        node(2, 'findTilePath', {
          url: 'file:///repo/src/core/map/pathfinding.ts',
          children: [3],
        }),
        // openList has zero self time; all three samples land in its child.
        node(3, 'openList', {
          url: 'file:///repo/node_modules/rot-js/dist/rot.js',
          line: 10,
          children: [4],
        }),
        node(4, 'compute', {
          url: 'file:///repo/node_modules/rot-js/dist/rot.js',
          line: 20,
        }),
      ],
      samples: [4, 4, 4],
      timeDeltas: [1000, 1000, 1000],
    });
    const mid = summary.functions.find((f) => f.functionName === 'openList')!;

    expect(mid.selfMs).toBe(0);
    // Despite zero self time, the project caller is identified via subtree cost.
    expect(mid.owners).toBeDefined();
    expect(mid.owners?.[0]?.functionName).toBe('findTilePath');
    expect(mid.owners?.[0]?.selfMs).toBeGreaterThan(0);
  });

  it('shows project caller for a zero-self-time dep frame when formatted', () => {
    const output = formatSummary(
      summarizeProfile({
        nodes: [
          node(1, '(root)', { children: [2] }),
          node(2, 'findTilePath', {
            url: 'file:///repo/src/core/map/pathfinding.ts',
            children: [3],
          }),
          node(3, 'openList', {
            url: 'file:///repo/node_modules/rot-js/dist/rot.js',
            line: 10,
            children: [4],
          }),
          node(4, 'compute', {
            url: 'file:///repo/node_modules/rot-js/dist/rot.js',
            line: 20,
          }),
        ],
        samples: [4, 4, 4],
        timeDeltas: [1000, 1000, 1000],
      }),
      { sortBy: 'total', top: 25 },
    );

    // The zero-self-time openList row must name its caller, not print
    // "no project caller".
    expect(output).toContain('← findTilePath');
    expect(output).not.toContain('no project caller');
  });

  it('prints the owner beside the dependency row and warns about bare names', () => {
    const output = formatSummary(summarizeProfile(rotJsProfile()), { top: 5 });

    expect(output).toContain('← findTilePath');
    expect(output).toMatch(/THIRD-PARTY frames/);
  });

  it('stays quiet when no dependency frame is on screen', () => {
    const output = formatSummary(summarizeProfile(simpleProfile()));

    expect(output).not.toContain('THIRD-PARTY');
    expect(output).not.toContain('←');
  });
});

describe('classifyRunTermination', () => {
  /** Shape of the headless CLI's completion block (headless-runner-cli.ts:87). */
  function runOutput(outcome: string): string {
    return [
      '',
      '📊 Run Complete',
      '━'.repeat(50),
      `Outcome:      ${outcome}`,
      'Final Floor:  1',
    ].join('\n');
  }

  it('accepts every normal termination, win or lose', () => {
    // The headless CLI exits NON-ZERO for anything but a victory, so exit code
    // cannot be the gate — a lost or frame-capped run is still valid to profile.
    for (const outcome of ['VICTORY', 'DEATH', 'TIMEOUT', 'STALLED']) {
      expect(classifyRunTermination(runOutput(outcome))).toEqual({ kind: 'healthy', outcome });
    }
  });

  it('rejects a mid-run simulation throw', () => {
    // `runHeadless` catches exceptions and returns outcome 'error', and the CLI
    // still prints "Run Complete" first — so the marker alone would accept this.
    expect(classifyRunTermination(runOutput('ERROR'))).toEqual({
      kind: 'errored',
      outcome: 'ERROR',
    });
  });

  it('rejects output that never reported an outcome', () => {
    expect(classifyRunTermination('')).toEqual({ kind: 'missing' });
    expect(classifyRunTermination('Fatal error: Unknown forceWeaponId "nope"')).toEqual({
      kind: 'missing',
    });
    // "Run Complete" without an outcome is not enough to trust the profile.
    expect(classifyRunTermination('📊 Run Complete\n')).toEqual({ kind: 'missing' });
  });

  it('does not match an Outcome mentioned mid-line', () => {
    expect(classifyRunTermination('note: the Outcome:      VICTORY was logged')).toEqual({
      kind: 'missing',
    });
  });
});

describe('selectMainThreadProfile', () => {
  it('selects the worker-id 0 profile when workers are also present', () => {
    expect(
      selectMainThreadProfile([
        'CPU.20260728.101010.12345.1.001.cpuprofile',
        'CPU.20260728.101010.12345.0.001.cpuprofile',
      ]),
    ).toBe('CPU.20260728.101010.12345.0.001.cpuprofile');
  });

  it('accepts a single emitted profile unchanged', () => {
    expect(selectMainThreadProfile(['single-thread.cpuprofile'])).toBe('single-thread.cpuprofile');
  });

  it('throws when no worker-id 0 profile exists among multiple candidates', () => {
    expect(() =>
      selectMainThreadProfile([
        'CPU.20260728.101010.12345.1.001.cpuprofile',
        'CPU.20260728.101010.12345.2.001.cpuprofile',
      ]),
    ).toThrow(/found 0 candidate\(s\) with worker-ID 0/);
  });

  it('throws when multiple worker-id 0 profiles exist', () => {
    expect(() =>
      selectMainThreadProfile([
        'CPU.20260728.101010.12345.0.001.cpuprofile',
        'CPU.20260728.101011.12345.0.002.cpuprofile',
        'CPU.20260728.101010.12345.1.001.cpuprofile',
      ]),
    ).toThrow(/found 2 candidate\(s\) with worker-ID 0/);
  });
});

describe('parseArgs (profile-headless)', () => {
  /** Simulate what profile-headless parseArgs receives: just the argv args, no node/script prefix. */
  function args(...a: string[]): string[] {
    return a;
  }

  it('rejects --max-frames 0 with a clear error', () => {
    expect(() => parseArgs(args('--max-frames', '0'))).toThrow(/--max-frames.*positive integer/);
  });

  it('rejects a negative --max-frames', () => {
    expect(() => parseArgs(args('--max-frames', '-1'))).toThrow(/--max-frames.*positive integer/);
  });

  it('rejects a non-integer --max-frames', () => {
    expect(() => parseArgs(args('--max-frames', '3.5'))).toThrow(/--max-frames.*positive integer/);
    expect(() => parseArgs(args('--max-frames', 'NaN'))).toThrow(/--max-frames.*positive integer/);
  });

  it('accepts a valid positive integer --max-frames', () => {
    const result = parseArgs(args('--max-frames', '5000'));
    expect('maxFrames' in result ? (result as { maxFrames: number }).maxFrames : null).toBe(5000);
  });

  it('rejects --ceiling with a speedup < 1 (caught in the ceiling branch)', () => {
    // speedup=0.5 passes regex parsing but predictCeiling throws; parseArgs
    // returns the raw values — the error surfaces when main() calls predictCeiling.
    // The regex allows any decimal, so 0.5 parses successfully.
    const result = parseArgs(args('--ceiling', '10:0.5'));
    expect(result).toHaveProperty('ceiling');
    // Verify that predictCeiling rejects the parsed speedup, proving the
    // ceiling branch in main() must catch this error.
    const [share, speedup] = (result as { ceiling: [number, number] }).ceiling;
    expect(() => predictCeiling(share, speedup)).toThrow(/speedup/);
  });

  it('rejects --ceiling with a share > 100 (caught in the ceiling branch)', () => {
    const result = parseArgs(args('--ceiling', '150:2'));
    expect(result).toHaveProperty('ceiling');
    const [share, speedup] = (result as { ceiling: [number, number] }).ceiling;
    expect(() => predictCeiling(share, speedup)).toThrow(/sharePct/);
  });
});
