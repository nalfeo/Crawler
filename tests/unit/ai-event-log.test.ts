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
    // s1+s2: moving a lot but going nowhere — wiggle (eff 0.1 < 0.35).
    mk('sample', 250, { state: 'EXPLORE', pathTravel: 2.5, netDisp: 0.25, px: 100, py: 200 }),
    mk('sample', 500, { state: 'EXPLORE', pathTravel: 2.5, netDisp: 0.25 }),
    // s3: barely moving — idle (pathTravel 0.125 < 0.1875).
    mk('sample', 750, { state: 'ENGAGE', pathTravel: 0.125, netDisp: 0.125 }),
    // s4: not moving + stuckFrames high — idle AND stuck.
    mk('sample', 1000, { state: 'ENGAGE', pathTravel: 0, netDisp: 0, stuckFrames: 50 }),
    // s5: final sample (dt = 0, contributes no time).
    mk('sample', 1250, { state: 'ENGAGE', pathTravel: 3.75, netDisp: 3.75 }),
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

  it('flags wiggle, idle, and stuck windows independently', () => {
    const summary = summarizeEvents(fixtureEvents());
    // Wiggle: s1 + s2 = 500ms.
    expect(summary.wiggleMs).toBe(500);
    expect(summary.wigglePct).toBe(40);
    // Idle: s3 + s4 = 500ms.
    expect(summary.idleMs).toBe(500);
    expect(summary.idlePct).toBe(40);
    // Stuck: s4 only = 250ms.
    expect(summary.stuckMs).toBe(250);
    expect(summary.stuckPct).toBe(20);
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
