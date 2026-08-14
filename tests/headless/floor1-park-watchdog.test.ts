/**
 * Floor-1 park (near-zero displacement) watchdog gate.
 *
 * Guards against regression to the pre-fix exploration-stall behaviour where the
 * AI parked for 194 s–338 s at a single world position (worstWiggle column in the
 * `ai:winrate-sweep` diagnostic). That class of failure — the nav-wedge / detour
 * oscillation and the ENGAGE-domain thrash on seeded spawner clusters — is now
 * fixed, and this gate makes it non-regressable.
 *
 * ## What it checks
 *
 * For every (seed, weapon) pair in the matrix it records the full {@link SimEvent}
 * stream, reduces it with {@link summarizeEvents}, and asserts:
 *
 *   - `longestWiggleMs`  < 45 s — wiggle = moving a lot but going nowhere
 *     (oscillation/thrash). The pre-fix worst case was 194 s (seed 13) / 338 s
 *     (seed 15 post-spawner). A healthy run's longest wiggle is a few seconds.
 *
 *   - `longestStuckMs`   < 30 s — stuck = contiguous near-zero displacement
 *     measured directly from sampled movement, not from BT `stuckFrames`
 *     (which are reset by local recovery).
 *
 * Thresholds sit far above healthy baselines (sword: longest wiggle ≤ 1.25 s,
 * longest stuck ≈ 0 s; bat: ≤ 1.25 s / ≈ 0 s) so normal combat kiting and
 * the deliberate harvest-node harvests never trip them.
 *
 * ## Coverage
 *
 * Primary sweep: seeds 1–20 × sword (the weapon mentioned for the worst failures
 * in the issue; sword also clears fastest so the sample stays quick). This broad
 * sweep enforces both wiggle and stuck ceilings.
 *
 * Extended stuck matrix: seeds 2, 13, 15, 17 × bow/bat plus seed 8 × bow (current
 * post-fix wiggle hotspot). This matrix enforces both wiggle and contiguous
 * near-zero displacement ceilings.
 *
 * ## Budget
 *
 * Each run uses a bounded frame budget (12 000 frames ≈ 200 s game time). With a
 * 45 s wiggle ceiling this still observes known onset windows plus threshold with
 * margin (e.g. seed 13 wedge onset around ~150 s). A completing run inside
 * the budget records the full event history; a run that exceeds the budget still
 * produces a valid event log for the portion simulated, which is enough to flag a
 * sustained park episode.
 *
 * This sweep is wall-clock heavy because it intentionally runs real headless
 * gameplay across 20 seeds. Keep timeout control at the per-probe level rather
 * than in one monolithic hook so a slower-but-healthy branch does not fail with
 * a suite-level hook timeout before any assertions run.
 */
import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { FLOOR1_DEFAULT_MAX_FRAMES } from '../../src/game/ai/floor1-run-budget.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { summarizeEvents, type EventSummary, type SimEvent } from '../../src/game/ai/event-log.js';

/** Bounded frame budget: covers park onset + a full 45 s sustained episode window. */
const PARK_SLICE_FRAMES = 12_000;

/**
 * Maximum sustained wiggle (oscillation) episode allowed.
 * Pre-fix worst cases: 194 s (seed 13 nav-wedge), 338 s (seed 15 ENGAGE thrash).
 * Current healthy baselines: ≤ 1.25 s per run.
 */
const MAX_WIGGLE_MS = 45_000;

/**
 * Maximum sustained contiguous near-zero displacement episode allowed.
 * This is measured directly from sampled net displacement so it cannot be masked
 * by local BT stuck-frame resets.
 */
const MAX_STUCK_MS = 30_000;
const STUCK_ANCHOR_RADIUS_FT = 12;

// ---------------------------------------------------------------------------
// Seeds from the issue acceptance criteria and the original repro table
// ---------------------------------------------------------------------------

/** Seeds 1–20: the full sample named in the issue acceptance criteria. */
const SEEDS_1_TO_20 = Array.from({ length: 20 }, (_, i) => i + 1) as readonly number[];

/**
 * Additional (seed, weapon) pairs called out explicitly in the issue repro table
 * or the spawner-related follow-up that are NOT already covered by the
 * seeds 1–20 sword sweep above (all seeds 1–20 are in that sweep, so these
 * add the *cross-weapon* axis for the worst-offending seeds).
 */
const EXTENDED_CASES: ReadonlyArray<{ seed: number; weapon: string; label: string }> = [
  { seed: 2, weapon: 'bow', label: 'seed 2 · bow (issue repro table)' },
  { seed: 2, weapon: 'baseball-bat', label: 'seed 2 · baseball-bat' },
  { seed: 13, weapon: 'bow', label: 'seed 13 · bow (nav-wedge cluster)' },
  { seed: 13, weapon: 'baseball-bat', label: 'seed 13 · baseball-bat (nav-wedge cluster)' },
  { seed: 15, weapon: 'bow', label: 'seed 15 · bow (ENGAGE-thrash cluster)' },
  { seed: 15, weapon: 'baseball-bat', label: 'seed 15 · baseball-bat (ENGAGE-thrash cluster)' },
  { seed: 17, weapon: 'bow', label: 'seed 17 · bow (issue repro table)' },
  { seed: 17, weapon: 'baseball-bat', label: 'seed 17 · baseball-bat' },
  { seed: 8, weapon: 'bow', label: 'seed 8 · bow (current worst post-fix wiggle hotspot)' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ParkProbe {
  longestWiggleMs: number;
  longestStuckMs: number;
  summary: EventSummary;
}

function makeSyntheticSample(
  gameMs: number,
  px: number,
  py: number,
  overrides: Partial<SimEvent> = {},
): SimEvent {
  return {
    type: 'sample',
    frame: Math.floor(gameMs / 16),
    gameMs,
    px,
    py,
    state: 'EXPLORE',
    reason: 'synthetic',
    targetEid: null,
    targetDist: null,
    enemyCount: 0,
    nearestEnemyDist: null,
    level: 1,
    xp: 0,
    kills: 0,
    health: 100,
    stuckFrames: 0,
    pathLen: 0,
    netDisp: 0,
    pathTravel: 0,
    ...overrides,
  };
}

function computeLongestNearZeroDispMs(events: readonly SimEvent[]): number {
  const samples = events.filter((event) => event.type === 'sample');
  let currentMs = 0;
  let longestMs = 0;
  let anchorX = 0;
  let anchorY = 0;
  let hasAnchor = false;
  for (let i = 0; i < samples.length - 1; i += 1) {
    const sample = samples[i]!;
    const next = samples[i + 1]!;
    const dt = Math.max(0, next.gameMs - sample.gameMs);
    const isSafeRoomPause = sample.inSafe === true;
    const isProgressSuppressionHold = sample.state === 'suppressedProgressNav';
    const isExcluded = isSafeRoomPause || isProgressSuppressionHold;
    if (!hasAnchor && !isExcluded) {
      hasAnchor = true;
      anchorX = sample.px;
      anchorY = sample.py;
    }
    const distFromAnchor = hasAnchor
      ? Math.hypot(sample.px - anchorX, sample.py - anchorY)
      : Infinity;
    const isNearAnchor = distFromAnchor <= STUCK_ANCHOR_RADIUS_FT;
    if (!isExcluded && isNearAnchor) {
      currentMs += dt;
      longestMs = Math.max(longestMs, currentMs);
    } else {
      currentMs = 0;
      hasAnchor = false;
    }
  }
  return longestMs;
}

async function runParkProbe(seed: number, weapon: string): Promise<ParkProbe> {
  const events: SimEvent[] = [];
  const ai = new BehaviorTreeAI({ seed });
  await runHeadless(ai, {
    seed,
    forceWeaponId: weapon,
    maxFrames: PARK_SLICE_FRAMES,
    planningMaxFrames: FLOOR1_DEFAULT_MAX_FRAMES,
    maxWallTimeMs: Number.POSITIVE_INFINITY,
    recordEvent: (event: SimEvent): void => {
      events.push(event);
    },
  });
  const summary = summarizeEvents(events);
  return {
    longestWiggleMs: summary.wiggleEpisodes[0]?.durationMs ?? 0,
    longestStuckMs: computeLongestNearZeroDispMs(events),
    summary,
  };
}

function assertNoSustainedWiggle(probe: ParkProbe, label: string): void {
  expect(probe.summary.totalSamples, `[${label}] expected sampled telemetry`).toBeGreaterThan(0);
  expect(
    probe.longestWiggleMs,
    `[${label}] sustained wiggle episode ${(probe.longestWiggleMs / 1000).toFixed(1)}s ` +
      `exceeds ${MAX_WIGGLE_MS / 1000}s ceiling — regression to pre-fix oscillation`,
  ).toBeLessThan(MAX_WIGGLE_MS);
}

function assertNoSustainedStuck(probe: ParkProbe, label: string): void {
  expect(
    probe.longestStuckMs,
    `[${label}] sustained stuck (near-zero displacement) episode ` +
      `${(probe.longestStuckMs / 1000).toFixed(1)}s exceeds ${MAX_STUCK_MS / 1000}s ceiling`,
  ).toBeLessThan(MAX_STUCK_MS);
}

/** Per-probe wall-clock timeout for a bounded 12,000-frame headless run. */
const PROBE_TIMEOUT_MS = 2 * 60 * 1000;

// ---------------------------------------------------------------------------
// Deterministic synthetic coverage for the stuck-detector helper
// ---------------------------------------------------------------------------

describe('computeLongestNearZeroDispMs', () => {
  it('detects a >30s contiguous near-zero displacement episode', () => {
    const events: SimEvent[] = [];
    for (let i = 0; i <= 31; i += 1) {
      events.push(makeSyntheticSample(i * 1000, 100, 100));
    }
    expect(computeLongestNearZeroDispMs(events)).toBeGreaterThan(30_000);
  });

  it('excludes safe-room stationary windows', () => {
    const events: SimEvent[] = [];
    for (let i = 0; i <= 40; i += 1) {
      events.push(makeSyntheticSample(i * 1000, 200, 200, { inSafe: true }));
    }
    expect(computeLongestNearZeroDispMs(events)).toBe(0);
  });

  it('resets accumulation when movement leaves the anchor radius', () => {
    const events: SimEvent[] = [];
    for (let i = 0; i <= 20; i += 1) {
      events.push(makeSyntheticSample(i * 1000, 300, 300));
    }
    events.push(makeSyntheticSample(21_000, 340, 340, { netDisp: 40, pathTravel: 40 }));
    for (let i = 22; i <= 38; i += 1) {
      events.push(makeSyntheticSample(i * 1000, 340, 340));
    }
    expect(computeLongestNearZeroDispMs(events)).toBeLessThan(30_000);
  });

  it('detects bounded oscillation inside the anchor radius', () => {
    const events: SimEvent[] = [];
    for (let i = 0; i <= 35; i += 1) {
      const px = i % 2 === 0 ? 400 : 408;
      events.push(makeSyntheticSample(i * 1000, px, 400, { netDisp: 8, pathTravel: 8 }));
    }
    expect(computeLongestNearZeroDispMs(events)).toBeGreaterThan(30_000);
  });
});

// ---------------------------------------------------------------------------
// Sweep: seeds 1–20 × sword
// ---------------------------------------------------------------------------

describe('Floor-1 park watchdog — seeds 1–20 (sword)', () => {
  for (const seed of SEEDS_1_TO_20) {
    it(
      `seed ${seed} · sword never sustains long park episodes`,
      async () => {
        const probe = await runParkProbe(seed, 'sword');
        assertNoSustainedWiggle(probe, `seed ${seed} · sword`);
        assertNoSustainedStuck(probe, `seed ${seed} · sword`);
      },
      PROBE_TIMEOUT_MS,
    );
  }
});

// ---------------------------------------------------------------------------
// Extended: historically problematic (seed, weapon) pairs — cross-weapon axis
// ---------------------------------------------------------------------------

describe('Floor-1 park watchdog — extended seed/weapon pairs from issue', () => {
  for (const { seed, weapon, label } of EXTENDED_CASES) {
    it(
      `${label} never sustains long park episodes`,
      async () => {
        const probe = await runParkProbe(seed, weapon);
        assertNoSustainedWiggle(probe, label);
        assertNoSustainedStuck(probe, label);
      },
      PROBE_TIMEOUT_MS,
    );
  }
});
