import { describe, expect, it } from 'vitest';

import {
  KNOWN_TEST_FIXTURE_GUARD_IDS,
  aggregateSources,
  analyzeGuards,
  buildCaptureRecord,
  cleanTelemetryRecord,
  guardFamily,
  parseGuardTelemetryJsonl,
  parseGuardTelemetrySummaryFromHandoff,
  renderGuardTelemetryHandoffSection,
  resolveSessionSlug,
  summarizeGuardTelemetry,
  type AggregateResult,
  type GuardTelemetryEvent,
  type SourceRecord,
} from '../../scripts/agent/docs/guard-telemetry';

const CONFIGURED = new Set([
  'edit-determinism',
  'edit-guard-self-protection',
  'pr-preflight',
  'pr-review-ledger',
  'shell-rm-rf-repo',
]);

function event(partial: Partial<GuardTelemetryEvent>): GuardTelemetryEvent {
  return {
    ts: '2026-07-02T00:00:00.000Z',
    guard_id: 'edit-determinism',
    tool_name: 'edit',
    decision: 'allow',
    ...partial,
  };
}

function makeAggregate(partial: Partial<AggregateResult>): AggregateResult {
  return {
    guards: {},
    tools: {},
    totalEvents: 0,
    cleanSessionCount: 0,
    quarantinedCount: 0,
    unexpectedByFile: [],
    ...partial,
  };
}

describe('guard telemetry docs helpers', () => {
  it('summarizes JSONL guard events into a handoff-safe summary', () => {
    const events = parseGuardTelemetryJsonl(
      [
        JSON.stringify({
          schema: 'agent-os-guard-telemetry-event/v1',
          _type: 'guard-telemetry',
          ts: '2026-06-21T00:00:00.000Z',
          guard_id: 'edit-determinism',
          tool_name: 'edit',
          decision: 'allow',
        }),
        JSON.stringify({
          schema: 'agent-os-guard-telemetry-event/v1',
          _type: 'guard-telemetry',
          ts: '2026-06-21T00:00:01.000Z',
          guard_id: 'edit-determinism',
          tool_name: 'edit',
          decision: 'deny',
          reason: 'Math.random()',
        }),
        JSON.stringify({
          schema: 'agent-os-guard-telemetry-event/v1',
          _type: 'guard-telemetry',
          ts: '2026-06-21T00:00:02.000Z',
          guard_id: 'pr-preflight',
          tool_name: 'create_pull_request',
          decision: 'deny',
          reason: 'missing handoff',
        }),
      ].join('\n'),
    );

    const summary = summarizeGuardTelemetry(events);

    expect(summary).toEqual({
      schema: 'agent-os-guard-telemetry-summary/v1',
      artifact: 'files/guard-telemetry.jsonl',
      events: 3,
      guards: {
        'edit-determinism': { allow: 1, deny: 1 },
        'pr-preflight': { deny: 1 },
      },
      tools: {
        create_pull_request: 1,
        edit: 2,
      },
    });
  });

  it('round-trips a telemetry handoff section', () => {
    const section = renderGuardTelemetryHandoffSection({
      schema: 'agent-os-guard-telemetry-summary/v1',
      artifact: 'files/guard-telemetry.jsonl',
      events: 2,
      guards: {
        'edit-guard-self-protection': { ask: 2 },
      },
      tools: {
        edit: 2,
      },
    });

    const parsed = parseGuardTelemetrySummaryFromHandoff(
      `# Session Handoff: Example\n\n${section}\n\n## What's Next\n\n- ship it\n`,
    );

    expect(parsed).toEqual({
      schema: 'agent-os-guard-telemetry-summary/v1',
      artifact: 'files/guard-telemetry.jsonl',
      events: 2,
      guards: {
        'edit-guard-self-protection': { ask: 2 },
      },
      tools: {
        edit: 2,
      },
    });
  });

  it('skips malformed JSONL lines instead of throwing', () => {
    const events = parseGuardTelemetryJsonl(
      [
        '{"guard_id":"pr-preflight","tool_name":"create_pull_request","decision":"deny","ts":"2026-06-21T00:00:00.000Z"}',
        '{"guard_id":"truncated"',
      ].join('\n'),
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.guard_id).toBe('pr-preflight');
  });

  it('returns null for malformed handoff JSON blocks', () => {
    const parsed = parseGuardTelemetrySummaryFromHandoff(
      `# Session Handoff: Example\n\n## Agent-OS Telemetry\n\n\`\`\`json\n{"schema":"agent-os-guard-telemetry-summary/v1"\n\`\`\`\n`,
    );

    expect(parsed).toBeNull();
  });
});

describe('guardFamily', () => {
  it('maps configured guard ids to their tool family by prefix', () => {
    expect(guardFamily('shell-rm-rf-repo')).toBe('shell');
    expect(guardFamily('edit-determinism')).toBe('edit');
    expect(guardFamily('pr-preflight')).toBe('pr');
  });

  it('classifies non-prefixed ids as other', () => {
    expect(guardFamily('boom')).toBe('other');
    expect(guardFamily('ctx')).toBe('other');
  });
});

describe('summarizeGuardTelemetry options (back-compat + filtering)', () => {
  it('adds no session field by default', () => {
    const summary = summarizeGuardTelemetry([event({})]);
    expect('session' in summary).toBe(false);
  });

  it('filters to allowed guard ids and stamps the session', () => {
    const events = [
      event({ guard_id: 'edit-determinism', decision: 'allow' }),
      event({ guard_id: 'boom', tool_name: 'powershell', decision: 'crash' }),
    ];

    const summary = summarizeGuardTelemetry(events, 'files/guard-telemetry.jsonl', {
      allowedGuardIds: CONFIGURED,
      session: 'demo',
    });

    expect(summary.session).toBe('demo');
    expect(summary.events).toBe(1);
    expect(summary.guards).toEqual({ 'edit-determinism': { allow: 1 } });
    expect(summary.tools).toEqual({ edit: 1 });
  });
});

describe('cleanTelemetryRecord', () => {
  it('keeps configured guard counts untouched', () => {
    const result = cleanTelemetryRecord({ 'edit-determinism': { allow: 1, deny: 2 } }, CONFIGURED);
    expect(result.quarantined).toBe(false);
    expect(result.guards).toEqual({ 'edit-determinism': { allow: 1, deny: 2 } });
    expect(result.fixtureIds).toEqual([]);
    expect(result.unexpectedIds).toEqual([]);
  });

  it('quarantines the whole record on a known fixture id, dropping synthetic real-id counts too', () => {
    const result = cleanTelemetryRecord(
      {
        'edit-guard-self-protection': { ask: 92 },
        boom: { crash: 92 },
        'shell-bad': { deny: 92 },
      },
      CONFIGURED,
    );
    expect(result.quarantined).toBe(true);
    // The synthetic edit-guard-self-protection:92 must NOT survive.
    expect(result.guards).toEqual({});
    expect(result.fixtureIds).toEqual(['boom', 'shell-bad']);
  });

  it('drops only unknown non-fixture ids and keeps the rest of the record', () => {
    const result = cleanTelemetryRecord(
      { 'pr-preflight': { deny: 1 }, 'edit-typoo': { allow: 3 } },
      CONFIGURED,
    );
    expect(result.quarantined).toBe(false);
    expect(result.guards).toEqual({ 'pr-preflight': { deny: 1 } });
    expect(result.unexpectedIds).toEqual(['edit-typoo']);
  });

  it('recognizes every documented fixture id', () => {
    for (const id of KNOWN_TEST_FIXTURE_GUARD_IDS) {
      const result = cleanTelemetryRecord({ [id]: { deny: 1 } }, CONFIGURED);
      expect(result.quarantined).toBe(true);
    }
  });
});

describe('buildCaptureRecord', () => {
  it('filters to configured ids, counts ignored events, and records unexpected ids', () => {
    const record = buildCaptureRecord(
      [
        event({ guard_id: 'edit-determinism', decision: 'allow' }),
        event({ guard_id: 'boom', tool_name: 'powershell', decision: 'crash' }),
        event({ guard_id: 'edit-typo', decision: 'allow' }),
      ],
      { session: 'demo', date: '2026-07-02', configuredIds: CONFIGURED },
    );

    expect(record.schema).toBe('agent-os-guard-telemetry-capture/v1');
    expect(record.session).toBe('demo');
    expect(record.events).toBe(1);
    expect(record.guards).toEqual({ 'edit-determinism': { allow: 1 } });
    expect(record.ignored_events).toBe(2);
    // boom is a known fixture (not "unexpected"); edit-typo is a real surprise.
    expect(record.unexpected_guard_ids).toEqual(['edit-typo']);
  });

  it('is idempotent for the same inputs', () => {
    const events = [
      event({ guard_id: 'pr-preflight', tool_name: 'create_pull_request', decision: 'deny' }),
    ];
    const first = buildCaptureRecord(events, {
      session: 'demo',
      date: '2026-07-02',
      configuredIds: CONFIGURED,
    });
    const second = buildCaptureRecord(events, {
      session: 'demo',
      date: '2026-07-02',
      configuredIds: CONFIGURED,
    });
    expect(second).toEqual(first);
  });
});

describe('aggregateSources', () => {
  function handoff(file: string, guards: SourceRecord['guards'], session?: string): SourceRecord {
    return {
      origin: 'handoff',
      file,
      session,
      date: new Date('2026-07-02T00:00:00Z'),
      guards,
      tools: {},
    };
  }
  function metrics(file: string, guards: SourceRecord['guards'], session: string): SourceRecord {
    return {
      origin: 'metrics',
      file,
      session,
      date: new Date('2026-07-02T00:00:00Z'),
      guards,
      tools: {},
    };
  }

  it('lets a metrics record win over a handoff block for the same session (no double count)', () => {
    const sources = [
      handoff('h.md', { 'pr-preflight': { deny: 1 } }, 'sess-1'),
      metrics('m.json', { 'pr-preflight': { deny: 5 } }, 'sess-1'),
    ];
    const result = aggregateSources(sources, CONFIGURED);
    expect(result.cleanSessionCount).toBe(1);
    expect(result.guards).toEqual({ 'pr-preflight': { deny: 5 } });
  });

  it('does not collapse distinct legacy handoffs that lack a session key', () => {
    const sources = [
      handoff('a.md', { 'pr-preflight': { deny: 1 } }),
      handoff('b.md', { 'pr-preflight': { deny: 2 } }),
    ];
    const result = aggregateSources(sources, CONFIGURED);
    expect(result.cleanSessionCount).toBe(2);
    expect(result.guards).toEqual({ 'pr-preflight': { deny: 3 } });
  });

  it('quarantines contaminated records and counts them separately', () => {
    const sources = [
      handoff('good.md', { 'edit-determinism': { allow: 1 } }, 's1'),
      handoff('bad.md', { 'edit-guard-self-protection': { ask: 92 }, boom: { crash: 92 } }, 's2'),
    ];
    const result = aggregateSources(sources, CONFIGURED);
    expect(result.quarantinedCount).toBe(1);
    expect(result.cleanSessionCount).toBe(1);
    expect(result.guards).toEqual({ 'edit-determinism': { allow: 1 } });
  });

  it('surfaces unexpected ids while keeping the real counts', () => {
    const sources = [
      handoff('h.md', { 'pr-preflight': { deny: 1 }, 'pr-renamed': { deny: 1 } }, 's1'),
    ];
    const result = aggregateSources(sources, CONFIGURED);
    expect(result.cleanSessionCount).toBe(1);
    expect(result.guards).toEqual({ 'pr-preflight': { deny: 1 } });
    expect(result.unexpectedByFile).toEqual([{ file: 'h.md', ids: ['pr-renamed'] }]);
  });
});

describe('analyzeGuards (per-family dead-guard gating)', () => {
  const configured = ['edit-determinism', 'pr-preflight', 'pr-review-ledger', 'shell-rm-rf-repo'];

  it('marks a guard alive when it has events', () => {
    const verdicts = analyzeGuards(
      makeAggregate({ guards: { 'pr-preflight': { deny: 3 } }, cleanSessionCount: 3 }),
      configured,
    );
    expect(verdicts.find((v) => v.guardId === 'pr-preflight')?.status).toBe('alive');
  });

  it('flags a dead guard only when its own family has enough evidence', () => {
    const verdicts = analyzeGuards(
      makeAggregate({ guards: { 'pr-preflight': { deny: 10 } }, cleanSessionCount: 3 }),
      configured,
    );
    // pr-review-ledger shares the pr family (10 events, 3 sessions) → dead.
    expect(verdicts.find((v) => v.guardId === 'pr-review-ledger')?.status).toBe('dead');
  });

  it('does not let one family vouch for another (edit traffic ≠ pr evidence)', () => {
    const verdicts = analyzeGuards(
      makeAggregate({ guards: { 'edit-determinism': { allow: 40 } }, cleanSessionCount: 3 }),
      configured,
    );
    // pr-review-ledger's family has 0 events → unobserved, never dead.
    expect(verdicts.find((v) => v.guardId === 'pr-review-ledger')?.status).toBe('unobserved');
    expect(verdicts.find((v) => v.guardId === 'shell-rm-rf-repo')?.status).toBe('unobserved');
  });

  it('stays low-confidence (unobserved) below the clean-session floor', () => {
    const verdicts = analyzeGuards(
      makeAggregate({ guards: { 'pr-preflight': { deny: 20 } }, cleanSessionCount: 2 }),
      configured,
    );
    expect(verdicts.find((v) => v.guardId === 'pr-review-ledger')?.status).toBe('unobserved');
  });
});

describe('resolveSessionSlug', () => {
  it('kebab-cases an explicit session name', () => {
    expect(resolveSessionSlug('My Feature!!')).toBe('my-feature');
  });

  it('passes a clean slug through unchanged', () => {
    expect(resolveSessionSlug('guard-telemetry-repair')).toBe('guard-telemetry-repair');
  });
});
