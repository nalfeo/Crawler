import type { RunBundle } from '../shared/run-bundle.js';

export const MAX_ISSUE_SCREENSHOT_BASE64_BYTES = 2 * 1024 * 1024;
export const MAX_ISSUE_RECORDER_BYTES = 1024 * 1024;
export const MAX_ISSUE_LOG_BYTES = 512 * 1024;

export interface FileIssuePayload extends RunBundle {
  readonly screenshot?: { readonly base64: string; readonly filename: string };
  readonly file_issue: true;
  readonly issue_description: string;
}

export interface FileIssueResponse {
  readonly runId: string;
  readonly issueUrl?: string;
}

type RunsIngestEnv = ImportMeta & {
  readonly env?: {
    readonly VITE_RUNS_INGEST_URL?: string;
  };
};

function base64ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundRecorderJsonl(value: string): string {
  return boundTextFromEnd(value, MAX_ISSUE_RECORDER_BYTES);
}

function boundTextFromEnd(value: string, limit: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= limit) {
    return value;
  }
  const truncated = new TextDecoder().decode(bytes.slice(-limit));
  const firstCompleteLine = truncated.indexOf('\n');
  return firstCompleteLine >= 0 ? truncated.slice(firstCompleteLine + 1) : truncated;
}

export function serializeIssueScreenshot(canvas: HTMLCanvasElement): string {
  const dataUrl = canvas.toDataURL('image/png');
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  if (!base64 || base64ByteLength(base64) > MAX_ISSUE_SCREENSHOT_BASE64_BYTES) {
    throw new Error('Screenshot is too large to attach. Try again at a smaller window size.');
  }
  return base64;
}

export function buildFileIssuePayload(
  bundle: RunBundle,
  description: string,
  options: { readonly includeLogs: boolean; readonly screenshotBase64?: string },
): FileIssuePayload {
  const issueDescription = description.trim();
  if (!issueDescription) {
    throw new Error('Describe the issue before submitting.');
  }
  return {
    ...bundle,
    recorderJsonl: boundRecorderJsonl(bundle.recorderJsonl),
    logs: options.includeLogs
      ? boundTextFromEnd(bundle.logs.join('\n'), MAX_ISSUE_LOG_BYTES).split('\n')
      : [],
    ...(options.screenshotBase64
      ? { screenshot: { base64: options.screenshotBase64, filename: 'crawler-issue.png' } }
      : {}),
    file_issue: true,
    issue_description: issueDescription,
  };
}

export function getRunsIngestUrl(): string | undefined {
  const value = (import.meta as RunsIngestEnv).env?.VITE_RUNS_INGEST_URL?.trim();
  return value || undefined;
}

export async function submitFileIssue(
  payload: FileIssuePayload,
  endpoint = getRunsIngestUrl(),
  fetchImpl: typeof fetch = fetch,
): Promise<FileIssueResponse> {
  if (!endpoint) {
    throw new Error('Issue reporting is not configured for this build.');
  }
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await response.json().catch(() => null)) as {
    readonly error?: unknown;
    readonly runId?: unknown;
    readonly issueUrl?: unknown;
  } | null;
  if (!response.ok) {
    throw new Error(
      typeof body?.error === 'string'
        ? body.error
        : `Issue submission failed (${response.status}).`,
    );
  }
  if (typeof body?.runId !== 'string') {
    throw new Error('Issue service returned an invalid response.');
  }
  return {
    runId: body.runId,
    ...(typeof body.issueUrl === 'string' ? { issueUrl: body.issueUrl } : {}),
  };
}
