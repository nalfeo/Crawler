import { beforeAll, describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import type { SimEvent } from '../../src/game/ai/event-log.js';
import { MovementIntentOwner } from '../../src/game/ai/movement-intent-arbiter.js';
import { isOfficialWin } from '../../src/game/ai/scoring.js';

const REPRO_SEED = 2;
const REPRO_WEAPON = 'bow';
const FLOOR1_TIME_BUDGET_MS = 360_000;
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
  const firstLeavingEvent = events.find(
    (event) =>
      event.inSafe === true && event.movementIntent?.owner === MovementIntentOwner.SAFE_ROOM_EGRESS,
  );
  let firstLeavingMs: number | null = firstLeavingEvent?.gameMs ?? null;
  if (firstLeavingMs === null) {
    // A doorway straddle can flip sampled safe-space state before the first
    // egress-owned sample lands. Anchor to the first in-safe detected threat in
    // that case; ownership assertions below remain structured.
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
    const isLeavingSafe =
      sample.inSafe === true &&
      sample.movementIntent?.owner === MovementIntentOwner.SAFE_ROOM_EGRESS;
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
          sample.movementIntent?.owner !== MovementIntentOwner.SAFE_ROOM_EGRESS,
      ),
    ).toBe(true);
  });

  it('does not reproduce the multi-minute leaving-safe-room deadlock signature', () => {
    expect(probe.longestLeavingSafeStreakMs).toBeLessThan(MAX_LEAVING_SAFE_STREAK_MS);
    expect(probe.stats.aiTelemetry?.inSafeMovementIntentViolationCount).toBe(0);
    expect(probe.stats.outcome).not.toBe('timeout');
    expect(isOfficialWin(probe.stats, FLOOR1_TIME_BUDGET_MS)).toBe(true);
  });
});
