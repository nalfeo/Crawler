/**
 * Pure helpers for turning a V8 `.cpuprofile` into cost attribution.
 *
 * WHY THIS EXISTS
 * ---------------
 * The perf-optimizer skill requires recording a target's share of a surface's
 * cost *before* optimizing it (SKILL.md step 3). Until this module existed the
 * skill mandated that step but shipped no way to perform it, so it was skipped
 * — and the agent's first run optimized a ~2.9% target while a ~21% one sat
 * untouched. See `references/hunting-grounds.md`.
 *
 * SELF vs TOTAL
 * -------------
 * Both are reported because each answers a different question and each alone
 * misleads:
 *   - **self**: which function body was actually executing. Finds hot leaves.
 *     Alone, it hides a subsystem whose cost is spread across many helpers.
 *   - **total** (inclusive): which call tree owns the cost. Finds expensive
 *     subsystems. Alone, it over-credits every ancestor up to the root.
 * Pick a target by looking at both: total tells you which tree to attack, self
 * tells you where inside it the time actually goes.
 *
 * Inclusive time is aggregated per function **without double-counting
 * recursion**: a node's subtree is credited to a function only when no
 * ancestor of that node is already the same function.
 */

/** A `callFrame` as emitted in a V8 `.cpuprofile`. */
export interface CpuProfileCallFrame {
  readonly functionName?: string;
  readonly url?: string;
  readonly lineNumber?: number;
}

/** A single node of the profile's call tree. */
export interface CpuProfileNode {
  readonly id: number;
  readonly callFrame: CpuProfileCallFrame;
  readonly hitCount?: number;
  readonly children?: readonly number[];
}

/** The subset of the `.cpuprofile` document this module reads. */
export interface CpuProfile {
  readonly nodes: readonly CpuProfileNode[];
  readonly startTime?: number;
  readonly endTime?: number;
  /** Node id per sample, in order. */
  readonly samples?: readonly number[];
  /** Microseconds elapsed before each corresponding entry in `samples`. */
  readonly timeDeltas?: readonly number[];
}

/** Attributed cost for one function, aggregated across every node for it. */
export interface FunctionCost {
  /** Stable identity: function name + source location. */
  readonly key: string;
  readonly functionName: string;
  /** Trimmed `url:line`, or `''` for native/synthetic frames. */
  readonly location: string;
  readonly selfMs: number;
  readonly selfPct: number;
  readonly totalMs: number;
  readonly totalPct: number;
}

/** Ranked attribution for one or more merged profiles. */
export interface ProfileSummary {
  /** Total attributed time across all samples. */
  readonly totalMs: number;
  readonly sampleCount: number;
  /** How self time was derived — useful when auditing a surprising number. */
  readonly timingSource: 'timeDeltas' | 'hitCount';
  /** How many profiles were merged into this summary. */
  readonly runCount: number;
  /**
   * Share of total time spent in the Node/tsx/esbuild harness rather than in
   * game code — module resolution, compilation, and file reads at startup.
   *
   * This is fixed startup cost, so on a short run it can dominate and badly
   * distort every other share. Treat anything above
   * {@link HARNESS_OVERHEAD_WARN_PCT} as "this profile is not representative;
   * profile a longer run".
   */
  readonly harnessOverheadPct: number;
  /** Sorted by `selfMs` descending. */
  readonly functions: readonly FunctionCost[];
}

/**
 * Above this share of harness overhead, a profile should not be trusted.
 *
 * Calibrated against real runs: the default full-run panel sits near 10%
 * (startup amortized over a whole floor — a ~1.1x inflation that does not
 * change target selection), while a `--max-frames 3000` truncated run hits
 * ~36% and reorders the entire table. The threshold sits between the two so
 * the warning stays rare enough to still mean something.
 */
export const HARNESS_OVERHEAD_WARN_PCT = 15;

const NATIVE_LOCATION = '';

/**
 * Is this frame the tsx/esbuild/Node module-loading harness rather than the
 * game? Used only to compute an advisory contamination signal — these frames
 * are still listed in the ranking, never silently dropped.
 */
function isHarnessFrame(location: string): boolean {
  return (
    location.startsWith('node:') ||
    location.startsWith('node_modules/esbuild/') ||
    location.startsWith('node_modules/tsx/')
  );
}

/**
 * Trim an absolute path down to something readable and machine-stable, so the
 * same function has the same key regardless of where the repo is checked out.
 */
function trimUrl(url: string | undefined): string {
  if (!url) return NATIVE_LOCATION;
  const withoutScheme = url.replace(/^file:\/\/\/?/, '');
  const match = /(?:^|[\\/])((?:src|scripts|tests|node_modules)[\\/].*)$/.exec(withoutScheme);
  const relative = match?.[1] ?? withoutScheme;
  return relative.replace(/\\/g, '/');
}

function frameKey(frame: CpuProfileCallFrame): { key: string; name: string; location: string } {
  const name =
    frame.functionName && frame.functionName.length > 0 ? frame.functionName : '(anonymous)';
  const url = trimUrl(frame.url);
  // Include the line number so two same-named functions in one file stay
  // distinct — `compute` is not a rare name.
  const location =
    url === NATIVE_LOCATION
      ? NATIVE_LOCATION
      : `${url}:${typeof frame.lineNumber === 'number' ? frame.lineNumber + 1 : 0}`;
  return { key: `${name}\u0000${location}`, name, location };
}

/**
 * Per-node self time in milliseconds.
 *
 * Prefers `samples` + `timeDeltas` (real elapsed microseconds per sample) and
 * falls back to `hitCount` scaled by the profile's mean sample interval, which
 * is all that is available if the profile was captured without sample arrays.
 */
function computeSelfMs(profile: CpuProfile): {
  selfMsByNode: Map<number, number>;
  sampleCount: number;
  timingSource: 'timeDeltas' | 'hitCount';
} {
  const selfMsByNode = new Map<number, number>();
  const samples = profile.samples;
  const deltas = profile.timeDeltas;

  if (samples && deltas && samples.length > 0 && deltas.length === samples.length) {
    for (let i = 0; i < samples.length; i += 1) {
      const nodeId = samples[i]!;
      // A negative delta is a clock artifact; clamp rather than corrupt totals.
      const deltaUs = Math.max(0, deltas[i]!);
      selfMsByNode.set(nodeId, (selfMsByNode.get(nodeId) ?? 0) + deltaUs / 1000);
    }
    return { selfMsByNode, sampleCount: samples.length, timingSource: 'timeDeltas' };
  }

  let totalHits = 0;
  for (const node of profile.nodes) totalHits += node.hitCount ?? 0;
  const durationMs =
    typeof profile.startTime === 'number' && typeof profile.endTime === 'number'
      ? (profile.endTime - profile.startTime) / 1000
      : totalHits; // degrade to "1 hit == 1 unit" rather than divide by zero
  const msPerHit = totalHits > 0 ? durationMs / totalHits : 0;
  for (const node of profile.nodes) {
    const hits = node.hitCount ?? 0;
    if (hits > 0) selfMsByNode.set(node.id, hits * msPerHit);
  }
  return { selfMsByNode, sampleCount: totalHits, timingSource: 'hitCount' };
}

/**
 * Aggregate a single profile into ranked per-function self and inclusive cost.
 */
export function summarizeProfile(profile: CpuProfile): ProfileSummary {
  const { selfMsByNode, sampleCount, timingSource } = computeSelfMs(profile);

  const nodesById = new Map<number, CpuProfileNode>();
  for (const node of profile.nodes) nodesById.set(node.id, node);

  // Roots are nodes nothing points at. A profile normally has exactly one, but
  // never assume that — a malformed or merged profile can have several.
  const childIds = new Set<number>();
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) childIds.add(child);
  }
  const roots = profile.nodes.filter((n) => !childIds.has(n.id));

  // Post-order subtree totals, iteratively — profiles can nest deeply enough
  // that recursion risks a stack overflow.
  const subtreeMs = new Map<number, number>();
  const order: number[] = [];
  const stack: number[] = roots.map((r) => r.id);
  const pushed = new Set<number>(stack);
  while (stack.length > 0) {
    const id = stack.pop()!;
    order.push(id);
    for (const child of nodesById.get(id)?.children ?? []) {
      if (!pushed.has(child) && nodesById.has(child)) {
        pushed.add(child);
        stack.push(child);
      }
    }
  }
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const id = order[i]!;
    let sum = selfMsByNode.get(id) ?? 0;
    for (const child of nodesById.get(id)?.children ?? []) {
      sum += subtreeMs.get(child) ?? 0;
    }
    subtreeMs.set(id, sum);
  }

  const selfByKey = new Map<string, number>();
  const totalByKey = new Map<string, number>();
  const metaByKey = new Map<string, { name: string; location: string }>();

  for (const node of profile.nodes) {
    const { key, name, location } = frameKey(node.callFrame);
    metaByKey.set(key, { name, location });
    const self = selfMsByNode.get(node.id) ?? 0;
    if (self > 0) selfByKey.set(key, (selfByKey.get(key) ?? 0) + self);
  }

  // Inclusive pass: credit a node's whole subtree to its function only if that
  // function is not already on the ancestor chain, so recursive frames are
  // counted once instead of once per level.
  const activeKeys = new Map<string, number>();
  const visited = new Set<number>();
  const walk: Array<{ id: number; entered: boolean; key: string }> = [];
  for (const root of roots) {
    walk.push({ id: root.id, entered: false, key: '' });
    while (walk.length > 0) {
      const frame = walk[walk.length - 1]!;
      if (frame.entered) {
        const depth = activeKeys.get(frame.key) ?? 1;
        if (depth <= 1) activeKeys.delete(frame.key);
        else activeKeys.set(frame.key, depth - 1);
        walk.pop();
        continue;
      }
      frame.entered = true;
      const node = nodesById.get(frame.id)!;
      const { key } = frameKey(node.callFrame);
      frame.key = key;
      const depth = activeKeys.get(key) ?? 0;
      if (depth === 0) {
        totalByKey.set(key, (totalByKey.get(key) ?? 0) + (subtreeMs.get(frame.id) ?? 0));
      }
      activeKeys.set(key, depth + 1);
      for (const child of node.children ?? []) {
        // `visited` also guards against a cycle in a malformed profile, which
        // would otherwise spin here forever.
        if (nodesById.has(child) && !visited.has(child)) {
          visited.add(child);
          walk.push({ id: child, entered: false, key: '' });
        }
      }
    }
  }

  let totalMs = 0;
  for (const ms of selfMsByNode.values()) totalMs += ms;

  const functions: FunctionCost[] = [];
  const keys = new Set<string>([...selfByKey.keys(), ...totalByKey.keys()]);
  for (const key of keys) {
    const meta = metaByKey.get(key) ?? { name: '(unknown)', location: NATIVE_LOCATION };
    const selfMs = selfByKey.get(key) ?? 0;
    const totalMsForKey = totalByKey.get(key) ?? 0;
    functions.push({
      key,
      functionName: meta.name,
      location: meta.location,
      selfMs,
      selfPct: totalMs > 0 ? (100 * selfMs) / totalMs : 0,
      totalMs: totalMsForKey,
      totalPct: totalMs > 0 ? (100 * totalMsForKey) / totalMs : 0,
    });
  }
  functions.sort((a, b) => b.selfMs - a.selfMs || a.key.localeCompare(b.key));

  let harnessMs = 0;
  for (const fn of functions) {
    if (isHarnessFrame(fn.location)) harnessMs += fn.selfMs;
  }

  return {
    totalMs,
    sampleCount,
    timingSource,
    runCount: 1,
    harnessOverheadPct: totalMs > 0 ? (100 * harnessMs) / totalMs : 0,
    functions,
  };
}

/**
 * Merge several profiles' summaries into one.
 *
 * A single seed/weapon can overfit to one run's route and combat conditions, so
 * the CLI profiles a small panel and merges. Shares are recomputed against the
 * combined total.
 */
export function mergeSummaries(summaries: readonly ProfileSummary[]): ProfileSummary {
  if (summaries.length === 0) {
    return {
      totalMs: 0,
      sampleCount: 0,
      timingSource: 'hitCount',
      runCount: 0,
      harnessOverheadPct: 0,
      functions: [],
    };
  }
  if (summaries.length === 1) return summaries[0]!;

  let totalMs = 0;
  let sampleCount = 0;
  let runCount = 0;
  const selfByKey = new Map<string, number>();
  const totalByKey = new Map<string, number>();
  const metaByKey = new Map<string, { name: string; location: string }>();

  for (const summary of summaries) {
    totalMs += summary.totalMs;
    sampleCount += summary.sampleCount;
    runCount += summary.runCount;
    for (const fn of summary.functions) {
      selfByKey.set(fn.key, (selfByKey.get(fn.key) ?? 0) + fn.selfMs);
      totalByKey.set(fn.key, (totalByKey.get(fn.key) ?? 0) + fn.totalMs);
      metaByKey.set(fn.key, { name: fn.functionName, location: fn.location });
    }
  }

  const functions: FunctionCost[] = [];
  for (const [key, meta] of metaByKey) {
    const selfMs = selfByKey.get(key) ?? 0;
    const totalMsForKey = totalByKey.get(key) ?? 0;
    functions.push({
      key,
      functionName: meta.name,
      location: meta.location,
      selfMs,
      selfPct: totalMs > 0 ? (100 * selfMs) / totalMs : 0,
      totalMs: totalMsForKey,
      totalPct: totalMs > 0 ? (100 * totalMsForKey) / totalMs : 0,
    });
  }
  functions.sort((a, b) => b.selfMs - a.selfMs || a.key.localeCompare(b.key));

  // Mixed timing sources would make the merged numbers incomparable; report the
  // weaker source so the caller knows precision was degraded somewhere.
  const timingSource = summaries.every((s) => s.timingSource === 'timeDeltas')
    ? 'timeDeltas'
    : 'hitCount';

  let harnessMs = 0;
  for (const fn of functions) {
    if (isHarnessFrame(fn.location)) harnessMs += fn.selfMs;
  }

  return {
    totalMs,
    sampleCount,
    timingSource,
    runCount,
    harnessOverheadPct: totalMs > 0 ? (100 * harnessMs) / totalMs : 0,
    functions,
  };
}

/**
 * Amdahl ceiling: the largest end-to-end win available from making a component
 * `speedup`x faster, given it is `sharePct` of the measured total.
 *
 * Use the share for the scope the optimization can actually affect — `selfPct`
 * when you are only speeding up a function's own body, `totalPct` when you are
 * eliminating or restructuring the whole call tree beneath it.
 *
 * `speedup = Infinity` (making the component free) returns `sharePct`.
 */
export function predictCeiling(sharePct: number, speedup: number): number {
  if (!Number.isFinite(sharePct) || sharePct < 0) {
    throw new Error(`sharePct must be a non-negative finite number, got ${sharePct}`);
  }
  if (Number.isNaN(speedup) || speedup < 1) {
    throw new Error(`speedup must be >= 1, got ${speedup}`);
  }
  if (speedup === Infinity) return sharePct;
  return sharePct * (1 - 1 / speedup);
}

export interface FormatOptions {
  readonly top?: number;
  readonly sortBy?: 'self' | 'total';
}

/** Render a summary as a fixed-width table for a terminal or a PR body. */
export function formatSummary(summary: ProfileSummary, options: FormatOptions = {}): string {
  const top = options.top ?? 25;
  const sortBy = options.sortBy ?? 'self';
  const ranked =
    sortBy === 'total'
      ? [...summary.functions].sort((a, b) => b.totalMs - a.totalMs || a.key.localeCompare(b.key))
      : summary.functions;

  const lines: string[] = [];
  lines.push(
    `Attributed ${summary.totalMs.toFixed(0)}ms across ${summary.runCount} run(s), ` +
      `${summary.sampleCount} samples (timing source: ${summary.timingSource})`,
  );
  lines.push(
    `Node/tsx/esbuild startup overhead: ${summary.harnessOverheadPct.toFixed(1)}% ` +
      `(inflates every share below by ~${(100 / (100 - summary.harnessOverheadPct)).toFixed(2)}x)`,
  );
  if (summary.harnessOverheadPct >= HARNESS_OVERHEAD_WARN_PCT) {
    lines.push('');
    lines.push(
      `⚠️  Startup is a fixed cost, so at ${summary.harnessOverheadPct.toFixed(1)}% it is not just`,
      '   inflating shares — it is REORDERING them. This ranking is NOT representative',
      '   of steady state. Profile longer and/or more runs before choosing a target:',
      '   drop --max-frames, and prefer the default panel (3 seeds x full runs).',
    );
  }
  lines.push('');
  lines.push('   self%    total%  function                              location');
  lines.push('  ------  --------  ------------------------------------  --------');
  for (const fn of ranked.slice(0, top)) {
    lines.push(
      `  ${fn.selfPct.toFixed(2).padStart(5)}%  ${fn.totalPct.toFixed(2).padStart(6)}%  ` +
        `${fn.functionName.slice(0, 36).padEnd(36)}  ${fn.location}`,
    );
  }
  return lines.join('\n');
}
