/**
 * Measurable stuck / wiggle regression gate (item #3, directive C4).
 *
 * The four exploration directives live in {@link BehaviorTreeAI} and delegate to
 * the pure kernels in `src/game/ai/exploration.ts`. The pure unit tests in
 * `tests/game/exploration.test.ts` prove each kernel in isolation; this test
 * proves the *integrated behaviour*: across a full, deterministic Floor 1 clear
 * the AI does not fall into a sustained stuck / wiggle (oscillation) loop.
 *
 * Rather than eyeballing a recording, it drives the real headless simulation on
 * a fixed seed and reduces the emitted {@link SimEvent} stream with the
 * already-unit-tested {@link summarizeEvents} aggregator, then asserts on the
 * measurable wasted-motion metrics (travel efficiency, wiggle %, and the
 * longest continuous stuck / wiggle episode). A regression that reintroduces a
 * knockback chase loop or a frontier freeze shows up as a long episode or a
 * collapse in travel efficiency, failing this gate deterministically.
 *
 * Thresholds are set with wide margin over the observed baseline (sword:
 * efficiency 0.85, wiggle 17.4%, longest wiggle 0ms; bat: 0.94, 2.6%, 1.25s) so
 * only a real behavioural regression — not normal combat kiting — trips them.
 * The sword wiggle baseline rose from the older 2.4% after Floor 1's
 * active-time budget widened from 360s to 600s (see `floor-run-budget.ts`):
 * with more slack before its AI planner treats the collapse deadline as
 * urgent, it now runs more loot-sweep detours, which register as wiggle.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { summarizeEvents, type EventSummary, type SimEvent } from '../../src/game/ai/event-log.js';

const FIXED_SEED = 6;

interface WiggleProbe {
  outcome: string;
  summary: EventSummary;
  longestWiggleMs: number;
  longestStuckMs: number;
}

async function runWiggleProbe(seed: number, weapon: string): Promise<WiggleProbe> {
  const events: SimEvent[] = [];
  const ai = new BehaviorTreeAI({ seed });
  const stats = await runHeadless(ai, {
    seed,
    forceWeaponId: weapon,
    recordEvent: (event: SimEvent) => events.push(event),
  });
  const summary = summarizeEvents(events);
  return {
    outcome: stats.outcome,
    summary,
    longestWiggleMs: summary.wiggleEpisodes[0]?.durationMs ?? 0,
    longestStuckMs: summary.stuckEpisodes[0]?.durationMs ?? 0,
  };
}

describe('Floor 1 stuck / wiggle behaviour gate', () => {
  // Two weapons on one fixed seed: sword is the efficiency anchor, baseball-bat
  // is the knockback-oscillation guard (its melee knockback is the system most
  // prone to a chase / kite loop). Each run is reused across the assertions via
  // beforeAll so the full simulation runs only once per weapon.
  for (const weapon of ['sword', 'baseball-bat'] as const) {
    describe(`seed ${String(FIXED_SEED)} · ${weapon}`, () => {
      let probe: WiggleProbe;

      beforeAll(async () => {
        probe = await runWiggleProbe(FIXED_SEED, weapon);
      });

      it('clears the floor without deadlocking', () => {
        expect(probe.outcome).toBe('victory');
      });

      it('keeps travel efficient (net displacement ≈ path travelled)', () => {
        // Baseline ~0.94; a freeze / oscillation loop drags this toward 0.
        expect(probe.summary.travelEfficiency).toBeGreaterThan(0.7);
      });

      it('spends little time wiggling (moving a lot, going nowhere)', () => {
        // Baseline: sword 17.4% (loot-sweep detours under the wider 600s
        // budget), bat 2.6%; alarm well below the ~50%+ a real oscillation
        // loop hits.
        expect(probe.summary.wigglePct).toBeLessThan(25);
      });

      it('never sustains a long stuck or wiggle episode', () => {
        // Baseline: longest wiggle ≤1.25s, longest stuck 0s. A true frontier
        // freeze or knockback loop would run for tens of seconds.
        expect(probe.longestWiggleMs).toBeLessThan(5_000);
        expect(probe.longestStuckMs).toBeLessThan(15_000);
      });
    });
  }
});
