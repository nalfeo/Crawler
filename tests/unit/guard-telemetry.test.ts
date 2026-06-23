import { describe, expect, it } from 'vitest';

import {
  parseGuardTelemetryJsonl,
  parseGuardTelemetrySummaryFromHandoff,
  renderGuardTelemetryHandoffSection,
  summarizeGuardTelemetry,
} from '../../scripts/agent/docs/guard-telemetry';

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
