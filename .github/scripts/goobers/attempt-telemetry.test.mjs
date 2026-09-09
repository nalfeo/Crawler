import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  attemptLineageKeyFor,
  buildAttemptTelemetry,
  buildRunArtifact,
  contextMetricsFrom,
  emitLaneTelemetry,
  parseJournalLines,
  stageDurationsFrom,
  terminalOutcomeFrom,
  validateRunArtifactPayload,
} from './attempt-telemetry.mjs';

function journal(events) {
  return events.map((event) => JSON.stringify(event)).join('\n');
}

const PR_RUN_EVENTS = [
  { type: 'run.started', ts: '2026-09-09T10:00:00.000Z' },
  { type: 'stage.started', stage: 'query-backlog', ts: '2026-09-09T10:00:00.000Z' },
  {
    type: 'stage.finished',
    stage: 'query-backlog',
    status: 'success',
    ts: '2026-09-09T10:00:02.000Z',
    outputs: { id: '4443' },
  },
  { type: 'stage.started', stage: 'implement', ts: '2026-09-09T10:00:02.000Z' },
  {
    type: 'stage.finished',
    stage: 'implement',
    status: 'success',
    ts: '2026-09-09T10:05:02.000Z',
    usage: { inputTokens: 9000, outputTokens: 2400, promptBytes: 24000, contextBytes: 18000 },
  },
  { type: 'stage.started', stage: 'open-pr', ts: '2026-09-09T10:05:02.000Z' },
  { type: 'stage.finished', stage: 'open-pr', status: 'success', ts: '2026-09-09T10:05:12.000Z' },
  { type: 'run.finished', status: 'completed', ts: '2026-09-09T10:05:15.000Z' },
];

test('parseJournalLines ignores malformed lines instead of throwing', () => {
  const { events, malformedCount } = parseJournalLines(
    ['{"type":"run.started"}', 'not json', '', '{"type":"run.finished","status":"completed"}'].join(
      '\n',
    ),
  );
  assert.equal(events.length, 2);
  assert.equal(malformedCount, 1);
});

test('stage durations come from started/finished pairs and accumulate on repeats', () => {
  const { durations, trace } = stageDurationsFrom([
    ...PR_RUN_EVENTS,
    { type: 'stage.started', stage: 'implement', ts: '2026-09-09T10:06:00.000Z' },
    {
      type: 'stage.finished',
      stage: 'implement',
      status: 'success',
      ts: '2026-09-09T10:06:30.000Z',
    },
  ]);
  assert.equal(durations['query-backlog'], 2000);
  assert.equal(durations.implement, 300000 + 30000);
  // The trace is ordered occurrences, so a repassed stage appears twice.
  assert.deepEqual(trace, ['query-backlog', 'implement', 'open-pr', 'implement']);
});

test('stage durations fall back to an explicit duration field', () => {
  const { durations } = stageDurationsFrom([
    { type: 'stage.finished', stage: 'local-ci', status: 'success', durationMs: 4200 },
  ]);
  assert.equal(durations['local-ci'], 4200);
});

test('context metrics only read counts and byte sizes, never content', () => {
  const metrics = contextMetricsFrom(PR_RUN_EVENTS);
  assert.equal(metrics.promptBytes, 24000);
  assert.equal(metrics.contextArtifactBytes, 18000);
  assert.equal(metrics.modelInputTokens, 9000);
  assert.equal(metrics.modelOutputTokens, 2400);
  assert.equal(metrics.compactionCount, null);
});

test('terminal outcomes normalize each journal phase', () => {
  assert.equal(
    terminalOutcomeFrom({ events: PR_RUN_EVENTS, hasJournal: true, jobStatus: 'success' })
      .terminalOutcome,
    'pr-opened',
  );
  assert.equal(
    terminalOutcomeFrom({
      events: [
        { type: 'stage.finished', stage: 'query-backlog', status: 'no-work' },
        { type: 'run.finished', status: 'completed' },
      ],
      hasJournal: true,
      jobStatus: 'success',
    }).terminalOutcome,
    'no-work',
  );
  assert.equal(
    terminalOutcomeFrom({
      events: [{ type: 'run.finished', status: 'failed' }],
      hasJournal: true,
      jobStatus: 'failure',
    }).terminalOutcome,
    'blocked',
  );
  assert.equal(
    terminalOutcomeFrom({ events: [], hasJournal: true, jobStatus: 'cancelled' }).terminalOutcome,
    'timeout',
  );
  assert.equal(
    terminalOutcomeFrom({ events: [], hasJournal: false, jobStatus: 'failure' }).terminalOutcome,
    'aborted',
  );
});

test('an attempt built from a real journal validates against its own contract', () => {
  const attempt = buildAttemptTelemetry({
    events: PR_RUN_EVENTS,
    issueNumber: '4443',
    runId: 'a82b1983',
    attemptNumber: 1,
    jobStatus: 'success',
  });
  assert.equal(attempt.contractVersion, 'v1');
  assert.equal(attempt.attemptLineageKey, 'issue-4443:run-a82b1983:attempt-1');
  assert.equal(attempt.parentAttemptLineageKey, null);
  assert.equal(attempt.terminalOutcome, 'pr-opened');
  assert.equal(attempt.totalElapsedMs, 315000);
  assert.deepEqual(
    validateRunArtifactPayload(buildRunArtifact({ issueNumber: '4443', attempts: [attempt] })),
    [],
  );
});

test('a retry only claims a parent lineage the caller can prove', () => {
  const withoutParent = buildAttemptTelemetry({
    events: PR_RUN_EVENTS,
    issueNumber: '4443',
    runId: 'b91c2094',
    attemptNumber: 3,
    jobStatus: 'success',
  });
  assert.equal(withoutParent.attemptNumber, 3);
  assert.equal(withoutParent.retryCount, 2);
  // A rerun mints a fresh Goobers run ID, so a parent derived from THIS run's
  // ID would name an attempt that never existed.
  assert.equal(withoutParent.parentAttemptLineageKey, null);

  const withParent = buildAttemptTelemetry({
    events: PR_RUN_EVENTS,
    issueNumber: '4443',
    runId: 'b91c2094',
    attemptNumber: 2,
    parentAttemptLineageKey: attemptLineageKeyFor({
      issueNumber: '4443',
      runId: 'a82b1983',
      attemptNumber: 1,
    }),
  });
  assert.equal(withParent.parentAttemptLineageKey, 'issue-4443:run-a82b1983:attempt-1');
  // Both attempts share the `issue-<n>` lineage root that links them.
  assert.ok(withParent.attemptLineageKey.startsWith('issue-4443:'));
  assert.ok(withoutParent.attemptLineageKey.startsWith('issue-4443:'));
});

test('a journal-less attempt is still emitted, with an explicit unavailable reason', () => {
  const attempt = buildAttemptTelemetry({
    events: [],
    hasJournal: false,
    issueNumber: '4443',
    attemptNumber: 1,
    jobStatus: 'failure',
  });
  assert.equal(attempt.terminalOutcome, 'aborted');
  assert.equal(attempt.promptBytes, null);
  assert.match(attempt.unavailableReason, /no run journal/);
  assert.deepEqual(
    validateRunArtifactPayload(buildRunArtifact({ issueNumber: '4443', attempts: [attempt] })),
    [],
  );
});

test('emitLaneTelemetry writes a validated record per assigned slot', () => {
  const laneRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'goobers-telemetry-'));
  try {
    const runDir = path.join(laneRoot, 'slot-0', 'gaggles', 'crawler', 'runs', 'a82b1983');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'events.jsonl'), `${journal(PR_RUN_EVENTS)}\n`);
    fs.mkdirSync(path.join(laneRoot, 'slot-1'), { recursive: true });

    const { emitted, errors } = emitLaneTelemetry({
      laneRoot,
      lane: 0,
      slots: ['0', '1', '2'],
      assignments: [
        { lane: 0, slot: 0, issue: '4443' },
        { lane: 0, slot: 1, issue: '4444' },
        { lane: 1, slot: 2, issue: '4445' },
      ],
      attemptNumber: 1,
      jobStatus: 'failure',
    });

    assert.deepEqual(errors, []);
    // slot 2 belongs to another lane, so this lane must not claim it.
    assert.deepEqual(
      emitted.map((entry) => entry.issueNumber),
      ['4443', '4444'],
    );

    const withJournal = JSON.parse(
      fs.readFileSync(
        path.join(laneRoot, 'slot-0', 'diagnostics', 'attempt-telemetry.json'),
        'utf8',
      ),
    );
    assert.equal(withJournal.contractVersion, 'v1');
    assert.equal(withJournal.attempts[0].terminalOutcome, 'pr-opened');
    assert.equal(withJournal.attempts[0].stageDurations.implement, 300000);

    const journalLess = JSON.parse(
      fs.readFileSync(
        path.join(laneRoot, 'slot-1', 'diagnostics', 'attempt-telemetry.json'),
        'utf8',
      ),
    );
    assert.equal(journalLess.attempts[0].terminalOutcome, 'aborted');
    assert.match(journalLess.attempts[0].unavailableReason, /no run journal/);

    // Privacy: no prompt text or credential-shaped value reaches the artifact.
    const serialized = JSON.stringify(withJournal);
    assert.ok(!serialized.includes('prompt:'));
    assert.ok(!/gh[pous]_[A-Za-z0-9]/.test(serialized));
  } finally {
    fs.rmSync(laneRoot, { recursive: true, force: true });
  }
});

test('usage recorded in a spans sidecar is merged into the context metrics', () => {
  const laneRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'goobers-telemetry-spans-'));
  try {
    const runDir = path.join(laneRoot, 'slot-0', 'gaggles', 'crawler', 'runs', 'c31f');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'events.jsonl'),
      `${journal(PR_RUN_EVENTS.filter((event) => !event.usage))}\n`,
    );
    fs.writeFileSync(
      path.join(runDir, 'spans.jsonl'),
      `${journal([{ name: 'implement', usage: { inputTokens: 5000, outputTokens: 1200 }, compactions: 2 }])}\n`,
    );

    const { emitted, errors } = emitLaneTelemetry({
      laneRoot,
      lane: 0,
      slots: ['0'],
      assignments: [{ lane: 0, slot: 0, issue: '4443' }],
    });
    assert.deepEqual(errors, []);
    const attempt = emitted[0].payload.attempts[0];
    assert.equal(attempt.modelInputTokens, 5000);
    assert.equal(attempt.modelOutputTokens, 1200);
    assert.equal(attempt.compactionCount, 2);
    // Metrics the runtime never reported still demand an explicit reason.
    assert.equal(attempt.promptBytes, null);
    assert.match(attempt.unavailableReason, /promptBytes/);
  } finally {
    fs.rmSync(laneRoot, { recursive: true, force: true });
  }
});

test('an invalid record is never written as a conforming artifact', () => {
  const laneRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'goobers-telemetry-invalid-'));
  try {
    const runDir = path.join(laneRoot, 'slot-0', 'gaggles', 'crawler', 'runs', 'd4a2');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'events.jsonl'), `${journal(PR_RUN_EVENTS)}\n`);

    const { emitted, errors } = emitLaneTelemetry({
      laneRoot,
      lane: 0,
      slots: ['0'],
      assignments: [{ lane: 0, slot: 0, issue: '4443' }],
      validate: () => ['issueNumber must be a numeric string'],
    });

    assert.equal(emitted.length, 0);
    assert.equal(errors.length, 1);
    const diagnostics = path.join(laneRoot, 'slot-0', 'diagnostics');
    assert.equal(fs.existsSync(path.join(diagnostics, 'attempt-telemetry.json')), false);
    assert.match(
      fs.readFileSync(path.join(diagnostics, 'attempt-telemetry.invalid.txt'), 'utf8'),
      /numeric string/,
    );
  } finally {
    fs.rmSync(laneRoot, { recursive: true, force: true });
  }
});

test('validateRunArtifactPayload is fail-closed on a contract violation', () => {
  const attempt = buildAttemptTelemetry({
    events: PR_RUN_EVENTS,
    issueNumber: '4443',
    runId: 'a82b1983',
  });
  const errors = validateRunArtifactPayload(
    buildRunArtifact({
      issueNumber: '4443',
      attempts: [{ ...attempt, terminalOutcome: 'mostly-done' }],
    }),
  );
  assert.ok(errors.length > 0);
});
