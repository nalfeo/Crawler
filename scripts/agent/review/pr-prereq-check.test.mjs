import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCaptureTelemetryOpts,
  evaluatePrereqs,
  inferTelemetrySessionSlug,
  summarizePrereqResult,
  telemetryCaptureNote,
} from './pr-prereq-check.mjs';

const CODE_FILE = 'src/core/components/movement.ts';
const HANDOFF = 'docs/knowledge/handoffs/2026-06-29-prereq-check.md';

test('summarizePrereqResult returns ok=true when preflight passes', () => {
  const r = summarizePrereqResult({ decision: 'allow' });
  assert.equal(r.ok, true);
  assert.equal(r.failures.length, 0);
});

test('summarizePrereqResult surfaces the preflight failure section', () => {
  const r = summarizePrereqResult({ decision: 'deny', reason: 'handoff missing' });
  assert.equal(r.ok, false);
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0], /\[pr-preflight\]/);
});

test('evaluatePrereqs fails on a missing handoff', () => {
  const r = evaluatePrereqs([CODE_FILE], [], '.');
  assert.equal(r.ok, false);
  assert.match(r.failures.join('\n'), /No new handoff file added/);
});

test('evaluatePrereqs passes when a handoff is added', () => {
  const r = evaluatePrereqs([CODE_FILE, HANDOFF], [HANDOFF], '.');
  assert.equal(r.ok, true);
});

test('evaluatePrereqs passes docs-only changes', () => {
  const r = evaluatePrereqs(['docs/knowledge/handoffs/2026-06-29-note.md'], [], '.');
  assert.equal(r.ok, true);
});

test('evaluatePrereqs passes docs-update INDEX changes through to preflight', () => {
  const r = evaluatePrereqs(['docs/knowledge/handoffs/INDEX.md'], [], '.', {
    currentBranch: 'automation/docs-update',
  });
  assert.equal(r.ok, true);
});

test('inferTelemetrySessionSlug prefers the handoff slug when present', () => {
  assert.equal(
    inferTelemetrySessionSlug([CODE_FILE], ['docs/knowledge/handoffs/2026-06-29-prereq-check.md']),
    'prereq-check',
  );
});

test('inferTelemetrySessionSlug returns null without a handoff', () => {
  assert.equal(inferTelemetrySessionSlug([CODE_FILE], []), null);
});

function withTelemetryArtifact(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'telemetry-note-'));
  try {
    mkdirSync(join(dir, 'files'), { recursive: true });
    writeFileSync(
      join(dir, 'files', 'guard-telemetry.jsonl'),
      '{"guard_id":"edit-determinism","tool_name":"edit","decision":"allow","ts":"2026-07-02T00:00:00.000Z"}\n',
    );
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('telemetryCaptureNote returns null when no session artifact exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'telemetry-note-empty-'));
  try {
    assert.equal(telemetryCaptureNote(dir, ['src/core/foo.ts'], []), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('telemetryCaptureNote auto-captures when it can infer the session slug', () => {
  withTelemetryArtifact((dir) => {
    const slug = 'telemetry-auto';
    const today = new Date().toISOString().slice(0, 10);
    const note = telemetryCaptureNote(
      dir,
      ['src/core/foo.ts', `docs/knowledge/handoffs/${today}-${slug}.md`],
      [`docs/knowledge/handoffs/${today}-${slug}.md`],
      {
        captureTelemetry(cwd, inferredSlug) {
          assert.equal(cwd, dir);
          assert.equal(inferredSlug, slug);
          mkdirSync(join(dir, 'docs', 'knowledge', 'metrics', 'guard-telemetry'), {
            recursive: true,
          });
          writeFileSync(
            join(dir, 'docs', 'knowledge', 'metrics', 'guard-telemetry', `${today}-${slug}.json`),
            '{}\n',
          );
        },
      },
    );

    assert.ok(note, 'expected a non-null note');
    assert.match(note, /\[guard-telemetry\]/);
    assert.match(note, /Auto-captured guard telemetry/);
    assert.match(note, new RegExp(`${today}-${slug}\\.json`));
  });
});

test('telemetryCaptureNote falls back to the manual reminder when no slug is inferable', () => {
  withTelemetryArtifact((dir) => {
    const note = telemetryCaptureNote(dir, ['src/core/foo.ts'], []);
    assert.ok(note, 'expected a non-null note');
    assert.match(note, /npm run telemetry:capture -- <session-slug>/);
  });
});

test('telemetryCaptureNote surfaces automatic-capture failure details', () => {
  withTelemetryArtifact((dir) => {
    const note = telemetryCaptureNote(
      dir,
      ['src/core/foo.ts', 'docs/knowledge/handoffs/2026-07-11-telemetry-auto.md'],
      ['docs/knowledge/handoffs/2026-07-11-telemetry-auto.md'],
      {
        captureTelemetry() {
          const error = new Error('boom');
          error.stderr = 'capture exploded\n';
          throw error;
        },
      },
    );

    assert.ok(note, 'expected a non-null note');
    assert.match(note, /Automatic guard-telemetry capture failed/);
    assert.match(note, /capture exploded/);
  });
});

test('telemetryCaptureNote returns null once a capture file is staged', () => {
  withTelemetryArtifact((dir) => {
    const note = telemetryCaptureNote(
      dir,
      ['src/core/foo.ts', 'docs/knowledge/metrics/guard-telemetry/2026-07-02-demo.json'],
      [],
    );
    assert.equal(note, null);
  });
});

test('buildCaptureTelemetryOpts uses a single shell command string on Windows', () => {
  const opts = buildCaptureTelemetryOpts(true, 'my-session');
  assert.equal(opts.type, 'shell');
  assert.equal(typeof opts.command, 'string');
  assert.match(opts.command, /my-session/);
  // Must not be an args array — shell: true + args array triggers DEP0190.
  assert.ok(!('args' in opts));
});

test('buildCaptureTelemetryOpts uses execFileSync args array on POSIX', () => {
  const opts = buildCaptureTelemetryOpts(false, 'my-session');
  assert.equal(opts.type, 'execFile');
  assert.deepEqual(opts.args, ['npm', 'run', 'telemetry:capture', '--', 'my-session']);
  // Must not be a single command string — that path is Windows-only.
  assert.ok(!('command' in opts));
});
