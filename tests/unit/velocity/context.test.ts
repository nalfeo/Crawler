import { describe, expect, it } from 'vitest';
import {
  EMPTY_CONTEXT,
  extractContextMetrics,
  isSafeSessionId,
  parseEvents,
  readContextMetrics,
  sessionEventLogPath,
  type RawEvent,
} from '../../../scripts/agent/velocity/context';

describe('isSafeSessionId', () => {
  it('accepts real session uuids', () => {
    expect(isSafeSessionId('90f5c170-539e-4299-8d07-1370323dd39f')).toBe(true);
  });

  it.each(['../../etc/passwd', 'a/b', 'a\\b', '.', '..', '', 'a b'])(
    'rejects path-like id %j',
    (id) => {
      expect(isSafeSessionId(id)).toBe(false);
    },
  );
});

describe('sessionEventLogPath', () => {
  it('points at the session-state event log', () => {
    const path = sessionEventLogPath('abc');
    expect(path).toContain('session-state');
    expect(path.endsWith('events.jsonl')).toBe(true);
  });
});

describe('parseEvents', () => {
  it('skips a partially flushed final line rather than losing the session', () => {
    const text = '{"type":"a"}\n{"type":"b"}\n{"type":"c"';
    expect(parseEvents(text).map((e) => e.type)).toEqual(['a', 'b']);
  });

  it('ignores blank lines', () => {
    expect(parseEvents('\n\n{"type":"a"}\n\n')).toHaveLength(1);
  });
});

describe('extractContextMetrics', () => {
  it('reports measured zeros for a session that never compacted or called a tool', () => {
    // available:true is the point — these zeros are an observation, not a gap.
    expect(extractContextMetrics([{ type: 'session.start' }])).toEqual({
      ...EMPTY_CONTEXT,
      available: true,
    });
  });

  it('marks an unreadable session as unmeasured rather than zero', () => {
    expect(readContextMetrics(null).available).toBe(false);
    expect(readContextMetrics('no-such-session-id-12345').available).toBe(false);
  });

  it('counts compactions and takes the peak pre-compaction context', () => {
    const events: RawEvent[] = [
      {
        type: 'session.compaction_complete',
        data: { preCompactionTokens: 160_194, compactionTokensUsed: 900 },
      },
      {
        type: 'session.compaction_complete',
        data: { preCompactionTokens: 161_744, compactionTokensUsed: 1_100 },
      },
    ];
    const metrics = extractContextMetrics(events);
    expect(metrics.compactions).toBe(2);
    expect(metrics.peakContextTokens).toBe(161_744);
    expect(metrics.compactionTokensUsed).toBe(2_000);
  });

  it('attributes the biggest result to the tool that produced it', () => {
    const events: RawEvent[] = [
      { type: 'tool.execution_start', data: { toolCallId: '1', toolName: 'view' } },
      { type: 'tool.execution_complete', data: { toolCallId: '1', result: { content: 'ab' } } },
      { type: 'tool.execution_start', data: { toolCallId: '2', toolName: 'grep' } },
      {
        type: 'tool.execution_complete',
        data: { toolCallId: '2', result: { content: 'abcdefgh' } },
      },
    ];
    const metrics = extractContextMetrics(events);
    expect(metrics.toolResultBytes).toBe(10);
    expect(metrics.largestToolResultBytes).toBe(8);
    expect(metrics.largestToolResultName).toBe('grep');
  });

  it('handles string results and results with no matching start event', () => {
    const events: RawEvent[] = [
      { type: 'tool.execution_complete', data: { toolCallId: 'x', result: 'hello' } },
    ];
    const metrics = extractContextMetrics(events);
    expect(metrics.toolResultBytes).toBe(5);
    expect(metrics.largestToolResultName).toBeNull();
  });

  it('ignores tool completions carrying no result', () => {
    const metrics = extractContextMetrics([{ type: 'tool.execution_complete', data: {} }]);
    expect(metrics.toolResultBytes).toBe(0);
  });
});

describe('readContextMetrics', () => {
  it('returns zeros rather than throwing for a null or unsafe session id', () => {
    expect(readContextMetrics(null)).toEqual(EMPTY_CONTEXT);
    expect(readContextMetrics('../escape')).toEqual(EMPTY_CONTEXT);
  });

  it('returns zeros when the session has no event log', () => {
    expect(readContextMetrics('session-that-does-not-exist-0000')).toEqual(EMPTY_CONTEXT);
  });
});
