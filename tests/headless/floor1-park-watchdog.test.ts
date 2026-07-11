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
 *   - `longestWiggleMs`  < 90 s — wiggle = moving a lot but going nowhere
 *     (oscillation/thrash). The pre-fix worst case was 194 s (seed 13) / 338 s
 *     (seed 15 post-spawner). A healthy run's longest wiggle is a few seconds.
 *
 *   - `longestStuckMs`   < 30 s — stuck = near-zero displacement. The global
 *     dwell watchdog fires every 5 s, so 30 s provides a wide margin while
 *     catching any multi-second park that bypasses all watchdogs.
 *
 * Thresholds sit far above healthy baselines (sword: longest wiggle ≤ 1.25 s,
 * longest stuck ≈ 0 s; bat: ≤ 1.25 s / ≈ 0 s) so normal combat kiting and
 * the deliberate harvest-node harvests never trip them.
 *
 * ## Coverage
 *
 * Primary sweep: seeds 1–20 × sword (the weapon mentioned for the worst failures
 * in the issue; sword also clears fastest so the sample stays quick). This is the
 * contiguous range named in the issue acceptance criteria.
 *
 * Extended: seeds 2 (bow), 13 (sword/bow/bat), 15 (sword), 17 (sword) — the exact
 * seeds and weapons called out in the original repro table. Seed 13 × 3 weapons is
 * already in {@link nav-wedge-repro.test.ts} for wiggle; this gate adds the
 * `longestStuckMs` axis and the out-of-cluster seeds.
 *
 * ## Budget
 *
 * Each run uses a bounded frame budget (12 000 frames ≈ 200 s game time) — well
 * past the park onset window (seed 13 wedged at ~150 s, seed 15 at ~340 s across
 * the full run, but the 33% spike appeared within 200 s). A completing run inside
 * the budget records the full event history; a run that exceeds the budget still
 * produces a valid event log for the portion simulated, which is enough to flag a
 * sustained park episode.
 *
 * At ~1 900 simulated-FPS each truncated run takes ≈ 6 s wall time; the 20-seed
 * sword sweep is ~120 s, comfortably inside the 180 s hook timeout.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { summarizeEvents, type EventSummary, type SimEvent } from '../../src/game/ai/event-log.js';

/** Bounded frame budget: covers the park-onset window without running to completion. */
const PARK_SLICE_FRAMES = 12_000;

/**
 * Maximum sustained wiggle (oscillation) episode allowed.
 * Pre-fix worst cases: 194 s (seed 13 nav-wedge), 338 s (seed 15 ENGAGE thrash).
 * Current healthy baselines: ≤ 1.25 s per run.
 */
const MAX_WIGGLE_MS = 90_000;

/**
 * Maximum sustained stuck (near-zero displacement) episode allowed.
 * Global dwell watchdog fires every 5 s, so any remaining stuck episode that
 * bypasses all watchdogs would exceed 5 s → a 30 s ceiling catches the bug class
 * while tolerating harvesting pauses and normal kite-back frames.
 */
const MAX_STUCK_MS = 30_000;

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
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ParkProbe {
  longestWiggleMs: number;
  longestStuckMs: number;
  summary: EventSummary;
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
    longestStuckMs: summary.stuckEpisodes[0]?.durationMs ?? 0,
    summary,
  };
}

function assertNoSustainedPark(probe: ParkProbe, label: string): void {
  expect(
    probe.longestWiggleMs,
    `[${label}] sustained wiggle episode ${(probe.longestWiggleMs / 1000).toFixed(1)}s ` +
      `exceeds ${MAX_WIGGLE_MS / 1000}s ceiling — regression to pre-fix oscillation`,
  ).toBeLessThan(MAX_WIGGLE_MS);

  expect(
    probe.longestStuckMs,
    `[${label}] sustained stuck (near-zero displacement) episode ` +
      `${(probe.longestStuckMs / 1000).toFixed(1)}s exceeds ${MAX_STUCK_MS / 1000}s ceiling`,
  ).toBeLessThan(MAX_STUCK_MS);
}

/**
 * Hook timeout for the 20-seed sword sweep: 20 runs × ~12 s each on a slow CI
 * runner = ~240 s. Use 10 minutes to give CI plenty of headroom without masking
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
  // 20 × ~12 s wall time per truncated run ≈ 240 s on a CI runner.
  beforeAll(async () => {
    for (const seed of SEEDS_1_TO_20) {
      probes.set(seed, await runParkProbe(seed, 'sword'));
    }
  }, SWEEP_HOOK_TIMEOUT_MS);

  for (const seed of SEEDS_1_TO_20) {
    it(`seed ${seed} · sword never sustains a long park while alive`, () => {
      assertNoSustainedPark(probes.get(seed)!, `seed ${seed} · sword`);
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
        expect(
          probe.longestWiggleMs,
          `sustained wiggle ${(probe.longestWiggleMs / 1000).toFixed(1)}s > ${MAX_WIGGLE_MS / 1000}s`,
        ).toBeLessThan(MAX_WIGGLE_MS);
      });

      it('never sustains a long stuck (near-zero displacement) episode', () => {
        expect(
          probe.longestStuckMs,
          `sustained stuck ${(probe.longestStuckMs / 1000).toFixed(1)}s > ${MAX_STUCK_MS / 1000}s`,
        ).toBeLessThan(MAX_STUCK_MS);
      });
    });
  }
});
