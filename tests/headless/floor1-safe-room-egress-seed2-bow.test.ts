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
  samples: SimEvent[];
  firstLeavingMs: number | null;
  firstExitMs: number | null;
  longestLeavingSafeStreakMs: number;
  longestOutOfSafeStreakMsAfterExit: number;
}

function analyzeEgress(samples: readonly SimEvent[]): {
  firstLeavingMs: number | null;
  firstExitMs: number | null;
  longestLeavingSafeStreakMs: number;
  longestOutOfSafeStreakMsAfterExit: number;
} {
  let firstLeavingMs: number | null = null;
  let firstExitMs: number | null = null;
  let longestLeavingSafeStreakMs = 0;
  let activeStreakMs = 0;
  let activeOutOfSafeStreakMs = 0;
  let longestOutOfSafeStreakMsAfterExit = 0;

  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i]!;
    const next = samples[i + 1];
    const dt = next ? Math.max(0, next.gameMs - sample.gameMs) : 0;
    const isLeavingSafe = sample.inSafe === true && sample.reason.includes('Leaving safe room');
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
    if (firstLeavingMs !== null && firstExitMs === null && sample.inSafe === false) {
      firstExitMs = sample.gameMs;
    }
    if (firstExitMs !== null && sample.inSafe === false) {
      activeOutOfSafeStreakMs += dt;
      if (activeOutOfSafeStreakMs > longestOutOfSafeStreakMsAfterExit) {
        longestOutOfSafeStreakMsAfterExit = activeOutOfSafeStreakMs;
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
    longestOutOfSafeStreakMsAfterExit,
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
  const {
    firstLeavingMs,
    firstExitMs,
    longestLeavingSafeStreakMs,
    longestOutOfSafeStreakMsAfterExit,
  } = analyzeEgress(samples);
  return {
    stats,
    samples,
    firstLeavingMs,
    firstExitMs,
    longestLeavingSafeStreakMs,
    longestOutOfSafeStreakMsAfterExit,
  };
}

describe('Floor 1 seed2 bow safe-room egress regression', () => {
  let probe: EgressProbe;

  beforeAll(async () => {
    probe = await runEgressProbe();
  });

  it('exits safe-room mode within 10 game-seconds after leave-safe-room first activates', () => {
    expect(probe.firstLeavingMs).not.toBeNull();
    expect(probe.firstExitMs).not.toBeNull();
    expect(probe.firstExitMs! - probe.firstLeavingMs!).toBeLessThanOrEqual(EGRESS_DEADLINE_MS);
  });

  it('stays out long enough for normal combat progression to resume', () => {
    expect(probe.longestOutOfSafeStreakMsAfterExit).toBeGreaterThanOrEqual(
      MIN_OUT_OF_SAFE_STREAK_MS,
    );
    expect(
      probe.samples.some(
        (sample) =>
          probe.firstExitMs !== null &&
          sample.gameMs > probe.firstExitMs &&
          sample.inSafe === false &&
          sample.state === 'ENGAGE' &&
          !sample.reason.includes('Leaving safe room'),
      ),
    ).toBe(true);
  });

  it('does not reproduce the multi-minute leaving-safe-room deadlock signature', () => {
    expect(probe.longestLeavingSafeStreakMs).toBeLessThan(MAX_LEAVING_SAFE_STREAK_MS);
    expect(probe.stats.outcome).not.toBe('timeout');
  });
});
