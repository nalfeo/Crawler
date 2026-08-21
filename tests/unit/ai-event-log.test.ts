import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SUMMARY_THRESHOLDS,
  eventsToJsonl,
  getDecisionEventState,
  summarizeEvents,
  type SimEvent,
  type SimEventType,
} from '../../src/game/ai/event-log.js';
import { AIProgressSuppressionSource, AIState } from '../../src/game/ai/types.js';

/** Build a SimEvent with sensible defaults, overriding only what a case cares about. */
function mk(type: SimEventType, gameMs: number, overrides: Partial<SimEvent> = {}): SimEvent {
  return {
    type,
    frame: Math.round(gameMs / 16.667),
    gameMs,
    px: 0,
    py: 0,
    state: 'EXPLORE',
    reason: 'default',
    targetEid: null,
    targetDist: null,
    enemyCount: 0,
    nearestEnemyDist: null,
    level: 0,
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

/**
 * A hand-built stream with known wiggle/idle/stuck/kill structure.
 *
 * Samples are 250ms apart. Time is attributed by the gap to the *next* sample,
 * so the final sample contributes 0ms. durationMs = 1250.
 */
function fixtureEvents(): SimEvent[] {
  return [
    // s0: moving efficiently — not wiggle, not idle, not stuck.
    mk('sample', 0, { state: 'EXPLORE', pathTravel: 2.5, netDisp: 2.25 }),
    // s1: moving a lot but going nowhere — wiggle (eff 0.1 < 0.35). Anchors
    // the stuck window at (100,200).
    mk('sample', 250, { state: 'EXPLORE', pathTravel: 2.5, netDisp: 0.25, px: 100, py: 200 }),
    // s2: still wiggling, 1.4ft from the anchor (within the 12ft radius).
    mk('sample', 500, { state: 'EXPLORE', pathTravel: 2.5, netDisp: 0.25, px: 101, py: 201 }),
    // s3: barely moving — idle (pathTravel 0.125 < 0.1875), still near anchor.
    mk('sample', 750, { state: 'ENGAGE', pathTravel: 0.125, netDisp: 0.125, px: 101, py: 201 }),
    // s4: not moving at all — idle, still near anchor.
    mk('sample', 1000, { state: 'ENGAGE', pathTravel: 0, netDisp: 0, px: 101, py: 201 }),
    // s5: final sample (dt = 0, contributes no time). Far away, but doesn't
    // matter since it contributes no time.
    mk('sample', 1250, { state: 'ENGAGE', pathTravel: 3.75, netDisp: 3.75, px: 140, py: 201 }),
    // Kills used for cadence metrics (not time attribution).
    mk('kill', 500, { note: 'kill 1' }),
    mk('kill', 1000, { note: 'kill 2' }),
  ];
}

describe('summarizeEvents', () => {
  it('attributes state time by the gap to the next sample', () => {
    const summary = summarizeEvents(fixtureEvents());
    expect(summary.totalSamples).toBe(6);
    expect(summary.durationMs).toBe(1250);
    // EXPLORE: s0+s1+s2 = 750ms; ENGAGE: s3+s4 = 500ms (s5 contributes 0).
    expect(summary.stateMs.EXPLORE).toBe(750);
    expect(summary.stateMs.ENGAGE).toBe(500);
    expect(summary.statePct.EXPLORE).toBe(60);
    expect(summary.statePct.ENGAGE).toBe(40);
  });

  it('flags wiggle and idle windows independently', () => {
    const summary = summarizeEvents(fixtureEvents());
    // Wiggle: s1 + s2 = 500ms.
    expect(summary.wiggleMs).toBe(500);
    expect(summary.wigglePct).toBe(40);
    // Idle: s3 + s4 = 500ms.
    expect(summary.idleMs).toBe(500);
    expect(summary.idlePct).toBe(40);
  });

  it('accumulates stuck time across a contiguous wiggle+idle run that never escapes the anchor radius', () => {
    // Override stuckSustainedMs to 0 so this fixture's short run (well under
    // the default 2s "couple of seconds" grace period) still exercises the
    // anchor-radius union logic in isolation.
    const summary = summarizeEvents(fixtureEvents(), {
      ...DEFAULT_SUMMARY_THRESHOLDS,
      stuckSustainedMs: 0,
    });
    // s1..s4 are a contiguous non-excluded wiggle/idle run, all within 12ft
    // of the anchor set at s1 (100,200) — the union is one stuck episode,
    // not just the samples that individually look "idle".
    expect(summary.stuckMs).toBe(1000);
    expect(summary.stuckPct).toBe(80);
    expect(summary.stuckEpisodes).toHaveLength(1);
    expect(summary.stuckEpisodes[0]!.durationMs).toBe(1000);
  });

  it('does not count a short wiggle/idle blip toward stuckMs at all (grace period)', () => {
    // With the default stuckSustainedMs (2000ms), fixtureEvents()'s 1000ms
    // wiggle+idle run never reaches the "couple of seconds" threshold, so it
    // contributes nothing to stuckMs — a brief combat-positioning pause is
    // normal play, not a defect.
    const summary = summarizeEvents(fixtureEvents());
    expect(summary.stuckMs).toBe(0);
    expect(summary.stuckPct).toBe(0);
    expect(summary.stuckEpisodes).toHaveLength(0);
  });

  it('closes a stuck episode once the player escapes the anchor radius', () => {
    const events = [
      mk('sample', 0, { state: 'ENGAGE', pathTravel: 0, netDisp: 0, px: 0, py: 0 }),
      mk('sample', 250, { state: 'ENGAGE', pathTravel: 0, netDisp: 0, px: 0, py: 0 }),
      // Jumps 50ft away — well past the 12ft anchor radius: genuine progress,
      // not stuck, even though this single sample also reads "idle".
      mk('sample', 500, { state: 'ENGAGE', pathTravel: 0.1, netDisp: 0.1, px: 50, py: 0 }),
      mk('sample', 750, { state: 'ENGAGE', pathTravel: 0, netDisp: 0, px: 50, py: 0 }),
    ];
    const summary = summarizeEvents(events, {
      ...DEFAULT_SUMMARY_THRESHOLDS,
      minEpisodeMs: 0,
      stuckSustainedMs: 0,
    });
    // Two separate stuck episodes: 0..500ms parked near (0,0), then a fresh
    // 500..750ms episode anchored at (50,0) after the jump — not one
    // continuous 750ms episode.
    expect(summary.stuckEpisodes).toHaveLength(2);
    expect(summary.stuckEpisodes[0]!.durationMs).toBe(500);
    expect(summary.stuckEpisodes[1]!.durationMs).toBe(250);
  });

  it('commits the full grace period once a stuck window reaches stuckSustainedMs', () => {
    // Player parked in one spot for the whole run — well past the default 2s
    // sustained threshold. The ENTIRE window should count, not just the
    // portion after crossing the threshold.
    const events = [
      mk('sample', 0, { state: 'ENGAGE', pathTravel: 0, netDisp: 0, px: 10, py: 10 }),
      mk('sample', 1000, { state: 'ENGAGE', pathTravel: 0, netDisp: 0, px: 10, py: 10 }),
      mk('sample', 2000, { state: 'ENGAGE', pathTravel: 0, netDisp: 0, px: 10, py: 10 }),
      mk('sample', 3000, { state: 'ENGAGE', pathTravel: 0, netDisp: 0, px: 10, py: 10 }),
      mk('sample', 4000, { state: 'ENGAGE', pathTravel: 0, netDisp: 0, px: 10, py: 10 }),
    ];
    const summary = summarizeEvents(events);
    expect(summary.stuckMs).toBe(4000);
    expect(summary.stuckEpisodes).toHaveLength(1);
    expect(summary.stuckEpisodes[0]!.durationMs).toBe(4000);
    expect(summary.stuckEpisodes[0]!.startMs).toBe(0);
  });

  it('excludes safe-room and vendor-interaction time from wiggle/idle/stuck', () => {
    const events = [
      // Idle-looking samples that are legitimately stationary should not
      // count against the "stuck or wiggle" budget at all.
      mk('sample', 0, { state: 'IDLE', pathTravel: 0, netDisp: 0, inSafe: true }),
      mk('sample', 250, { state: 'INTERACT', pathTravel: 0, netDisp: 0 }),
      mk('sample', 500, { state: 'EXPLORE', pathTravel: 2.5, netDisp: 2.25 }),
    ];
    const summary = summarizeEvents(events);
    expect(summary.stuckMs).toBe(0);
    expect(summary.wiggleMs).toBe(0);
    expect(summary.idleMs).toBe(0);
    expect(summary.excludedMs).toBe(500);
    expect(summary.excludedPct).toBe(100);
  });

  it('computes kill cadence metrics from kill events', () => {
    const summary = summarizeEvents(fixtureEvents());
    expect(summary.kills).toBe(2);
    expect(summary.timeToFirstKillMs).toBe(500);
    expect(summary.killTimestampsMs).toEqual([500, 1000]);
    // Boundaries [0, 500, 1000, 1250] → largest gap is 500.
    expect(summary.longestKillGapMs).toBe(500);
  });

  it('computes travel efficiency from net displacement over path travel', () => {
    const summary = summarizeEvents(fixtureEvents());
    expect(summary.totalPathTravel).toBe(11); // 2.5+2.5+2.5+0.125+0+3.75 = 11.375
    expect(summary.totalNetDisp).toBe(7); // 2.25+0.25+0.25+0.125+0+3.75 = 6.625
    expect(summary.travelEfficiency).toBeCloseTo(6.625 / 11.375, 3);
  });

  it('reports wiggle episodes that exceed the minimum duration', () => {
    const summary = summarizeEvents(fixtureEvents(), {
      ...DEFAULT_SUMMARY_THRESHOLDS,
      minEpisodeMs: 200,
    });
    expect(summary.wiggleEpisodes).toHaveLength(1);
    const episode = summary.wiggleEpisodes[0]!;
    expect(episode.startMs).toBe(250);
    expect(episode.durationMs).toBe(500);
    expect(episode.state).toBe('EXPLORE');
    expect(episode.px).toBe(100);
    expect(episode.py).toBe(200);
  });

  it('returns a zeroed summary for an empty stream', () => {
    const summary = summarizeEvents([]);
    expect(summary.totalSamples).toBe(0);
    expect(summary.durationMs).toBe(0);
    expect(summary.kills).toBe(0);
    expect(summary.timeToFirstKillMs).toBeNull();
    expect(summary.longestKillGapMs).toBeNull();
    expect(summary.travelEfficiency).toBe(0);
  });

  it('buckets suppressed progress navigation separately from ordinary EXPLORE', () => {
    const events = [
      mk('sample', 0, { state: 'EXPLORE', pathTravel: 1, netDisp: 1 }),
      mk('sample', 250, {
        state: 'suppressedProgressNav',
        baseState: 'EXPLORE',
        decisionDebug: {
          state: 'suppressedProgressNav',
          reason: 'progressGoalSuppressed',
          source: AIProgressSuppressionSource.EXPLORE_DWELL_FIXED_POSITION_TARGET,
          criticalChainPhase: 'pre-chain',
          blockedTargetReason: 'Seeking Tutorial Goon to unlock the floor quest',
          suppressedUntilFrame: 420,
          remainingFrames: 120,
        },
        pathTravel: 1,
        netDisp: 1,
      }),
      mk('sample', 500, { state: 'EXPLORE', pathTravel: 1, netDisp: 1 }),
    ];

    const summary = summarizeEvents(events);

    expect(summary.stateMs.EXPLORE).toBe(250);
    expect(summary.stateMs.suppressedProgressNav).toBe(250);
    expect(summary.statePct.EXPLORE).toBe(50);
    expect(summary.statePct.suppressedProgressNav).toBe(50);
  });

  it('uses debug state labels for headless event-state transitions', () => {
    expect(
      getDecisionEventState({
        state: AIState.EXPLORE,
        debug: {
          state: 'suppressedProgressNav',
          reason: 'progressGoalSuppressed',
          source: AIProgressSuppressionSource.EXPLORE_DWELL_FIXED_POSITION_TARGET,
          criticalChainPhase: 'pre-chain',
          blockedTargetReason: 'Seeking Tutorial Goon to unlock the floor quest',
          suppressedUntilFrame: 420,
          remainingFrames: 120,
        },
      }),
    ).toBe('suppressedProgressNav');
  });
});

describe('eventsToJsonl', () => {
  it('serializes one JSON object per line with a trailing newline', () => {
    const events = [mk('sample', 0), mk('kill', 100, { note: 'kill 1' })];
    const jsonl = eventsToJsonl(events);
    const lines = jsonl.split('\n');
    expect(lines).toHaveLength(3); // two records + trailing empty
    expect(lines[2]).toBe('');
    expect(JSON.parse(lines[0]!).type).toBe('sample');
    expect(JSON.parse(lines[1]!).note).toBe('kill 1');
  });

  it('preserves typed suppressed-progress debug payloads', () => {
    const events = [
      mk('sample', 0, {
        state: 'suppressedProgressNav',
        baseState: 'EXPLORE',
        decisionDebug: {
          state: 'suppressedProgressNav',
          reason: 'progressGoalSuppressed',
          source: AIProgressSuppressionSource.QUEST_PROGRESS_DWELL_WATCHDOG,
          criticalChainPhase: 'spell-broker',
          blockedTargetReason: 'Heading to the Slime Rat room',
          suppressedUntilFrame: 900,
          remainingFrames: 300,
        },
      }),
    ];

    const [line] = eventsToJsonl(events).trimEnd().split('\n');
    const parsed = JSON.parse(line!);

    expect(parsed.state).toBe('suppressedProgressNav');
    expect(parsed.baseState).toBe('EXPLORE');
    expect(parsed.decisionDebug).toMatchObject({
      state: 'suppressedProgressNav',
      reason: 'progressGoalSuppressed',
      source: AIProgressSuppressionSource.QUEST_PROGRESS_DWELL_WATCHDOG,
      criticalChainPhase: 'spell-broker',
      blockedTargetReason: 'Heading to the Slime Rat room',
    });
  });
});
