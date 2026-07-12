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
 * sweep enforces the wiggle ceiling.
 *
 * Extended stuck matrix: seeds 2, 13, 15, 17 × sword/bow/bat — the exact repro
 * seed cluster, expanded across weapons. This matrix enforces both wiggle and
 * contiguous near-zero displacement ceilings.
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
 * At ~1 900 simulated-FPS each truncated run takes ≈ 8 s wall time; the 20-seed
 * sword sweep is ~160 s, comfortably inside the 10-minute hook timeout.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
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
const STUCK_NET_DISP_EPSILON_FT = 2;
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
  { seed: 2, weapon: 'sword', label: 'seed 2 · sword (issue repro table)' },
  { seed: 2, weapon: 'bow', label: 'seed 2 · bow (issue repro table)' },
  { seed: 2, weapon: 'baseball-bat', label: 'seed 2 · baseball-bat' },
  { seed: 13, weapon: 'sword', label: 'seed 13 · sword (nav-wedge cluster)' },
  { seed: 13, weapon: 'bow', label: 'seed 13 · bow (nav-wedge cluster)' },
  { seed: 13, weapon: 'baseball-bat', label: 'seed 13 · baseball-bat (nav-wedge cluster)' },
  { seed: 15, weapon: 'sword', label: 'seed 15 · sword (ENGAGE-thrash cluster)' },
  { seed: 15, weapon: 'bow', label: 'seed 15 · bow (ENGAGE-thrash cluster)' },
  { seed: 15, weapon: 'baseball-bat', label: 'seed 15 · baseball-bat (ENGAGE-thrash cluster)' },
  { seed: 17, weapon: 'sword', label: 'seed 17 · sword (issue repro table)' },
  { seed: 17, weapon: 'bow', label: 'seed 17 · bow (issue repro table)' },
  { seed: 17, weapon: 'baseball-bat', label: 'seed 17 · baseball-bat' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ParkProbe {
  longestWiggleMs: number;
  longestStuckMs: number;
  summary: EventSummary;
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
    const isNearZeroDisp = sample.netDisp <= STUCK_NET_DISP_EPSILON_FT;
    const isSafeRoomPause = sample.inSafe === true;
    if (!hasAnchor && isNearZeroDisp) {
      hasAnchor = true;
      anchorX = sample.px;
      anchorY = sample.py;
    }
    const distFromAnchor = hasAnchor
      ? Math.hypot(sample.px - anchorX, sample.py - anchorY)
      : Infinity;
    const isNearAnchor = distFromAnchor <= STUCK_ANCHOR_RADIUS_FT;
    if (!isSafeRoomPause && isNearZeroDisp && isNearAnchor) {
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

/**
 * Hook timeout for the 20-seed sword sweep: 20 runs × ~12 s each on a slow CI
 * runner = ~160 s. Use 10 minutes to give CI plenty of headroom without masking
 * a genuine performance regression (the per-run budget already bounds each run).
 */
const SWEEP_HOOK_TIMEOUT_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Sweep: seeds 1–20 × sword
// ---------------------------------------------------------------------------

describe('Floor-1 park watchdog — seeds 1–20 (sword)', () => {
  const probes = new Map<number, ParkProbe>();

  // Run all 20 seeds sequentially inside a single beforeAll so the simulation
  // cost is paid once; each seed then gets its own it() assertions.
  // 20 × ~8 s wall time per truncated run ≈ 160 s on a CI runner.
  beforeAll(async () => {
    for (const seed of SEEDS_1_TO_20) {
      probes.set(seed, await runParkProbe(seed, 'sword'));
    }
  }, SWEEP_HOOK_TIMEOUT_MS);

  for (const seed of SEEDS_1_TO_20) {
    it(`seed ${seed} · sword never sustains a long wiggle episode`, () => {
      assertNoSustainedWiggle(probes.get(seed)!, `seed ${seed} · sword`);
    });
  }
});

// ---------------------------------------------------------------------------
// Extended: historically problematic (seed, weapon) pairs — cross-weapon axis
// ---------------------------------------------------------------------------

describe('Floor-1 park watchdog — extended seed/weapon pairs from issue', () => {
  for (const { seed, weapon, label } of EXTENDED_CASES) {
    describe(label, () => {
      let probe: ParkProbe;

      beforeAll(async () => {
        probe = await runParkProbe(seed, weapon);
      });

      it('never sustains a long wiggle (oscillation) episode', () => {
        assertNoSustainedWiggle(probe, label);
      });

      it('never sustains a long stuck (near-zero displacement) episode', () => {
        assertNoSustainedStuck(probe, label);
      });
    });
  }
});
