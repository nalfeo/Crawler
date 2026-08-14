import { describe, expect, it, vi } from 'vitest';
import {
  buildFileIssuePayload,
  MAX_ISSUE_RECORDER_BYTES,
  MAX_ISSUE_LOG_BYTES,
  MAX_ISSUE_SCREENSHOT_BASE64_BYTES,
  serializeIssueScreenshot,
  submitFileIssue,
} from '../../src/engine/file-issue.js';
import type { RunBundle } from '../../src/shared/run-bundle.js';

const bundle: RunBundle<Record<string, unknown>> = {
  runStats: { elapsedMs: 1200 },
  recorderJsonl: '{"event":"tick"}',
  logs: ['[info] test'],
  meta: { endReason: 'quit', floorId: 'floor1', seed: 42 },
};

describe('file issue payload', () => {
  it('selects requested attachments and supplies PR2 issue metadata', () => {
    expect(
      buildFileIssuePayload(bundle, 'The player became stuck.', {
        includeLogs: false,
        screenshotBase64: 'iVBORw0KGgo=',
      }),
    ).toEqual({
      ...bundle,
      logs: [],
      screenshot: { base64: 'iVBORw0KGgo=', filename: 'crawler-issue.png' },
      file_issue: true,
      issue_description: 'The player became stuck.',
    });
  });

  it('rejects an empty issue description before a network request', () => {
    expect(() => buildFileIssuePayload(bundle, '   ', { includeLogs: true })).toThrow(
      'Describe the issue',
    );
  });

  it('keeps the most recent complete recorder lines within the client bound', () => {
    const payload = buildFileIssuePayload(
      { ...bundle, recorderJsonl: `${'x'.repeat(MAX_ISSUE_RECORDER_BYTES)}\n{"event":"recent"}` },
      'A report',
      { includeLogs: true },
    );
    expect(new TextEncoder().encode(payload.recorderJsonl).byteLength).toBeLessThanOrEqual(
      MAX_ISSUE_RECORDER_BYTES,
    );
    expect(payload.recorderJsonl).toBe('{"event":"recent"}');
  });

  it('keeps the newest complete log line within the client bound', () => {
    const payload = buildFileIssuePayload(
      { ...bundle, logs: [`${'x'.repeat(MAX_ISSUE_LOG_BYTES)}\n[error] recent`] },
      'A report',
      { includeLogs: true },
    );
    expect(new TextEncoder().encode(payload.logs.join('\n')).byteLength).toBeLessThanOrEqual(
      MAX_ISSUE_LOG_BYTES,
    );
    expect(payload.logs).toEqual(['[error] recent']);
  });
});

describe('issue screenshot serialization', () => {
  it('removes the PNG data URL prefix', () => {
    const canvas = { toDataURL: () => 'data:image/png;base64,iVBORw0KGgo=' } as HTMLCanvasElement;
    expect(serializeIssueScreenshot(canvas)).toBe('iVBORw0KGgo=');
  });

  it('rejects encoded screenshots over the client bound', () => {
    const canvas = {
      toDataURL: () => `data:image/png;base64,${'a'.repeat(MAX_ISSUE_SCREENSHOT_BASE64_BYTES + 1)}`,
    } as HTMLCanvasElement;
    expect(() => serializeIssueScreenshot(canvas)).toThrow('Screenshot is too large');
  });
});

describe('file issue submission', () => {
  it('posts the PR2 contract and returns the created issue URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ runId: 'run-1', issueUrl: 'https://example.test/issues/1' }), {
        status: 201,
      }),
    );
    const payload = buildFileIssuePayload(bundle, 'An issue', { includeLogs: true });

    await expect(submitFileIssue(payload, 'https://ingest.test/runs', fetchImpl)).resolves.toEqual({
      runId: 'run-1',
      issueUrl: 'https://example.test/issues/1',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://ingest.test/runs',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
