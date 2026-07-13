import { beforeAll, describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import type { SimEvent } from '../../src/game/ai/event-log.js';

const REPRO_SEED = 2;
const REPRO_WEAPON = 'bow';
const EGRESS_DEADLINE_MS = 10_000;
const MAX_LEAVING_SAFE_STREAK_MS = 30_000;
const MIN_OUT_OF_SAFE_STREAK_MS = 3_000;

interface EgressProbe {
  stats: Awaited<ReturnType<typeof runHeadless>>;
  events: SimEvent[];
  samples: SimEvent[];
  firstLeavingMs: number | null;
  firstExitMs: number | null;
  longestLeavingSafeStreakMs: number;
  longestOutOfSafeStreakMs: number;
}

function analyzeEgress(
  events: readonly SimEvent[],
  samples: readonly SimEvent[],
): {
  firstLeavingMs: number | null;
  firstExitMs: number | null;
  longestLeavingSafeStreakMs: number;
  longestOutOfSafeStreakMs: number;
} {
  // The old `LeaveSafeRoom` behavior-tree owner (and its `reason.includes(
  // 'Leaving safe room')` telemetry signature) was deleted by the safe-room
  // route constraint redesign — see
  // `docs/knowledge/adr/2026-07-13-safe-room-route-constraint-layer.md`. The
  // successor signal is the post-selection route overlay's lifecycle: a
  // monotonically-increasing `totalActivations` counter is the proxy for
  // "the AI has committed to leaving", and `phase === 'active'` is the proxy
  // for "currently executing the legal exit segment" while the raw in/out
  // boundary flag may still (flickerily) read in-safe.
  const firstActivationEvent = events.find(
    (event) => (event.safeRoomRoute?.totalActivations ?? 0) >= 1,
  );
  let firstLeavingMs: number | null = firstActivationEvent?.gameMs ?? null;
  if (firstLeavingMs === null) {
    // In seed2+bow, doorway straddle can flip sampled telemetry before the
    // first explicit route activation sample lands. Anchor the egress window
    // to the first in-safe sample with a detected nearby enemy in that case.
    const firstInSafeWithDetectedThreat = samples.find(
      (sample) => sample.inSafe === true && typeof sample.nearestEnemyDist === 'number',
    );
    firstLeavingMs = firstInSafeWithDetectedThreat?.gameMs ?? null;
  }
  let firstExitMs: number | null = null;
  let longestLeavingSafeStreakMs = 0;
  let activeStreakMs = 0;
  let activeOutOfSafeStreakMs = 0;
  let longestOutOfSafeStreakMs = 0;

  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i]!;
    const next = samples[i + 1];
    const dt = next ? Math.max(0, next.gameMs - sample.gameMs) : 0;
    const isLeavingSafe = sample.inSafe === true && sample.safeRoomRoute?.phase === 'active';
    if (isLeavingSafe) {
      if (firstLeavingMs === null) {
        firstLeavingMs = sample.gameMs;
      }
      activeStreakMs += dt;
      if (activeStreakMs > longestLeavingSafeStreakMs) {
        longestLeavingSafeStreakMs = activeStreakMs;
      }
      continue;
    }
    if (
      firstLeavingMs !== null &&
      sample.gameMs >= firstLeavingMs &&
      firstExitMs === null &&
      sample.inSafe === false
    ) {
      firstExitMs = sample.gameMs;
    }
    if (sample.inSafe === false) {
      activeOutOfSafeStreakMs += dt;
      if (activeOutOfSafeStreakMs > longestOutOfSafeStreakMs) {
        longestOutOfSafeStreakMs = activeOutOfSafeStreakMs;
      }
    } else {
      activeOutOfSafeStreakMs = 0;
    }
    activeStreakMs = 0;
  }

  return {
    firstLeavingMs,
    firstExitMs,
    longestLeavingSafeStreakMs,
    longestOutOfSafeStreakMs,
  };
}

async function runEgressProbe(): Promise<EgressProbe> {
  const events: SimEvent[] = [];
  const stats = await runHeadless(new BehaviorTreeAI({ seed: REPRO_SEED }), {
    seed: REPRO_SEED,
    forceWeaponId: REPRO_WEAPON,
    eventSampleInterval: 10,
    recordEvent: (event: SimEvent): void => {
      events.push(event);
    },
  });
  const samples = events.filter((event) => event.type === 'sample');
  const { firstLeavingMs, firstExitMs, longestLeavingSafeStreakMs, longestOutOfSafeStreakMs } =
    analyzeEgress(events, samples);
  return {
    stats,
    events,
    samples,
    firstLeavingMs,
    firstExitMs,
    longestLeavingSafeStreakMs,
    longestOutOfSafeStreakMs,
  };
}

describe('Floor 1 seed2 bow safe-room egress regression', () => {
  let probe: EgressProbe;

  beforeAll(async () => {
    probe = await runEgressProbe();
  });

  it('exits safe-room mode within 10 game-seconds after leave-safe-room first activates', () => {
    const firstLeavingMs = probe.firstLeavingMs;
    const firstExitMs = probe.firstExitMs;
    expect(firstLeavingMs).not.toBeNull();
    expect(firstExitMs).not.toBeNull();
    expect(firstExitMs! - firstLeavingMs!).toBeLessThanOrEqual(EGRESS_DEADLINE_MS);
  });

  it('stays out long enough for normal combat progression to resume', () => {
    expect(probe.longestOutOfSafeStreakMs).toBeGreaterThanOrEqual(MIN_OUT_OF_SAFE_STREAK_MS);
    expect(
      probe.samples.some(
        (sample) =>
          sample.inSafe === false &&
          sample.state === 'ENGAGE' &&
          sample.safeRoomRoute?.phase !== 'active',
      ),
    ).toBe(true);
  });

  it('does not reproduce the multi-minute leaving-safe-room deadlock signature', () => {
    expect(probe.longestLeavingSafeStreakMs).toBeLessThan(MAX_LEAVING_SAFE_STREAK_MS);
    expect(probe.stats.outcome).not.toBe('timeout');
  });

  it('surfaces safe-room route telemetry end-to-end in RunStats for cloud divergence evidence', () => {
    // The route overlay replaces the deleted `LeaveSafeRoom` owner node; a real
    // full run must still activate at least once (there is a legal exit door in
    // this fixture) and must never get durably stuck (activations should
    // eventually resolve via completion rather than piling up as blocked).
    const telemetry = probe.stats.safeRoomRouteTelemetry;
    expect(telemetry).toBeDefined();
    expect(telemetry!.activations).toBeGreaterThan(0);
    expect(telemetry!.completions).toBeGreaterThan(0);
  });
});
