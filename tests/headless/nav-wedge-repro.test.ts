/**
 * Nav-wedge cluster reproduction gate (Floor-1 objective-selection thrash).
 *
 * The Floor-1 AI-runner has a latent **objective-selection oscillation**: when
 * the player sits on the safe-room mouth, `world.playerInSafeRoom` flickers
 * frame-to-frame as the body straddles the boundary, and the non-sticky
 * quest-giver detour (`withQuestGiverDetour` in {@link BehaviorTreeAI}) flips
 * the travel target between the main progress objective ("Seeking the merchant
 * fetch item") and a nearby quest NPC ("Detouring to spell-quest-giver") every
 * single frame. The move vector reverses each frame, so the player is pinned at
 * the doorway going nowhere — a multi-minute wiggle that burns the whole
 * floor-collapse budget and loses the run.
 *
 * Seed 13 is the dramatic instance: without the fix the player wedges at
 * (~388,364) for ~180s (wiggle 61.7%, travel efficiency collapses 0.98 → 0.60).
 * The wedge is weapon-sensitive in aggregate but the objective-selection thrash
 * itself is weapon-agnostic, so this gate drives the whole recovered 13-cluster
 * (sword / bow / baseball-bat — all three flipped loss→win with the fix) on the
 * real headless simulation with a **bounded** frame budget (fast, deterministic)
 * and reduces the {@link SimEvent} stream with the already-unit-tested
 * {@link summarizeEvents} aggregator, asserting the wedge signature is absent on
 * every variant: no long sustained wiggle episode and low aggregate wiggle time.
 *
 * RED before the fix: the longest wiggle episode is tens of seconds and wiggle%
 * is well above the threshold. GREEN after the detour-hysteresis fix: the player
 * commits to one objective, threads the mouth, and resumes efficient travel.
 *
 * The budget is deliberately short (well under a full ~360s clear) so the run is
 * cheap to iterate on; the wedge onset (~150s) is comfortably inside it. Outcome
 * is not asserted here (no run clears the floor inside the truncated budget) —
 * the aggregate win-rate is gated by the full sweep, not this micro-slice.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { FLOOR1_DEFAULT_MAX_FRAMES } from '../../src/game/ai/floor1-run-budget.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { summarizeEvents, type EventSummary, type SimEvent } from '../../src/game/ai/event-log.js';

/** Bounded budget: past the ~150s wedge onset, far under a full clear. */
const WEDGE_SLICE_FRAMES = 12_000;

/**
 * The recovered nav-wedge cluster: every (seed, weapon) that flipped loss→win
 * with the detour-hysteresis fix and must never wiggle-regress. All share seed 13
 * (the safe-room-mouth detour oscillation); the weapon axis proves the fix is not
 * weapon-specific.
 */
const WEDGE_CASES: ReadonlyArray<{ seed: number; weapon: string; label: string }> = [
  { seed: 13, weapon: 'bow', label: 'seed 13 · bow' },
  { seed: 13, weapon: 'sword', label: 'seed 13 · sword' },
  { seed: 13, weapon: 'baseball-bat', label: 'seed 13 · baseball-bat' },
];

interface WedgeProbe {
  summary: EventSummary;
  longestWiggleMs: number;
  longestStuckMs: number;
}

async function runWedgeProbe(seed: number, weapon: string): Promise<WedgeProbe> {
  const events: SimEvent[] = [];
  const ai = new BehaviorTreeAI({ seed });
  await runHeadless(ai, {
    seed,
    forceWeaponId: weapon,
    maxFrames: WEDGE_SLICE_FRAMES,
    planningMaxFrames: FLOOR1_DEFAULT_MAX_FRAMES,
    recordEvent: (event: SimEvent) => events.push(event),
  });
  const summary = summarizeEvents(events);
  return {
    summary,
    longestWiggleMs: summary.wiggleEpisodes[0]?.durationMs ?? 0,
    longestStuckMs: summary.stuckEpisodes[0]?.durationMs ?? 0,
  };
}

describe('Floor 1 nav-wedge (objective-selection thrash) gate', () => {
  for (const { seed, weapon, label } of WEDGE_CASES) {
    describe(`${label} (safe-room-mouth detour oscillation)`, () => {
      let probe: WedgeProbe;

      // One truncated headless run, reused across assertions.
      beforeAll(async () => {
        probe = await runWedgeProbe(seed, weapon);
      });

      it('never sustains a long wiggle episode at the safe-room mouth', () => {
        // Pre-fix: a single wiggle episode runs ~50s+ within this budget (the full
        // run wedges ~180s). A healthy run's longest wiggle is a few seconds.
        expect(probe.longestWiggleMs).toBeLessThan(20_000);
      });

      it('spends little aggregate time wiggling (moving a lot, going nowhere)', () => {
        // Pre-fix: wiggle% is ~25%+ over the budget. Healthy travel is a few %.
        expect(probe.summary.wigglePct).toBeLessThan(15);
      });

      it('keeps travel efficient (net displacement ≈ path travelled)', () => {
        // Pre-fix: efficiency collapses toward 0.6 as the pinned oscillation
        // accumulates path travel with zero net displacement.
        expect(probe.summary.travelEfficiency).toBeGreaterThan(0.85);
      });
    });
  }
});
