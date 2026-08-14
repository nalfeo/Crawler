export const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
export const MAX_RECORDER_BYTES = 2 * 1024 * 1024;
export const MAX_LOG_BYTES = 2 * 1024 * 1024;
export const MAX_COMMENT_CHARS = 2_000;
export const MAX_DESCRIPTION_CHARS = 4_000;

const SURVEY_DIMENSIONS = ['enjoyment', 'immersion', 'mastery', 'control', 'tension'] as const;

export interface PlaytestSurvey {
  readonly enjoyment: number;
  readonly immersion: number;
  readonly mastery: number;
  readonly control: number;
  readonly tension: number;
  readonly comment?: string;
}

export interface RunBundle {
  readonly runStats: Record<string, unknown>;
  readonly recorderJsonl: string;
  readonly logs: string | readonly string[];
  readonly meta: Record<string, unknown>;
  readonly screenshot?: string | { readonly base64: string; readonly filename?: string };
  readonly survey?: Partial<PlaytestSurvey>;
  readonly file_issue?: boolean;
  readonly issue_description?: string;
}

export interface ValidatedBundle {
  readonly bundle: RunBundle;
  readonly requestedRunId?: string;
  readonly screenshotBase64?: string;
  readonly screenshotFilename?: string;
  readonly shouldFileIssue: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function readScreenshot(value: unknown): { base64: string; filename?: string } | undefined {
  if (typeof value === 'string') return { base64: value, filename: 'screenshot.png' };
  if (!isRecord(value) || typeof value.base64 !== 'string') return undefined;
  const filename =
    typeof value.filename === 'string' && /^[a-zA-Z0-9._-]+\.png$/i.test(value.filename)
      ? value.filename
      : 'screenshot.png';
  return { base64: value.base64, filename };
}

export function validateRunBundle(value: unknown, serializedBytes: number): ValidatedBundle {
  if (serializedBytes > MAX_REQUEST_BYTES) {
    throw new Error(`request exceeds ${MAX_REQUEST_BYTES} bytes`);
  }
  if (!isRecord(value)) throw new Error('request body must be a JSON object');
  if (!isRecord(value.runStats)) throw new Error('runStats must be an object');
  if (typeof value.recorderJsonl !== 'string') throw new Error('recorderJsonl must be a string');
  if (byteLength(value.recorderJsonl) > MAX_RECORDER_BYTES) {
    throw new Error(`recorderJsonl exceeds ${MAX_RECORDER_BYTES} bytes`);
  }
  if (
    !(
      typeof value.logs === 'string' ||
      (Array.isArray(value.logs) && value.logs.every((v) => typeof v === 'string'))
    )
  ) {
    throw new Error('logs must be a string or an array of strings');
  }
  const logsBytes =
    typeof value.logs === 'string' ? byteLength(value.logs) : byteLength(value.logs.join('\n'));
  if (logsBytes > MAX_LOG_BYTES) throw new Error(`logs exceeds ${MAX_LOG_BYTES} bytes`);
  if (!isRecord(value.meta)) throw new Error('meta must be an object');
  if (
    value.meta.runId !== undefined &&
    (typeof value.meta.runId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(value.meta.runId))
  ) {
    throw new Error('meta.runId must contain only letters, numbers, dots, underscores, or hyphens');
  }
  const requestedRunId = typeof value.meta.runId === 'string' ? value.meta.runId : undefined;

  const screenshot = readScreenshot(value.screenshot);
  if (value.screenshot !== undefined && screenshot === undefined) {
    throw new Error('screenshot must be base64 PNG data or an object with base64');
  }
  if (screenshot && byteLength(screenshot.base64) > 6 * 1024 * 1024) {
    throw new Error('screenshot exceeds 6 MiB');
  }

  let survey: Partial<PlaytestSurvey> | undefined;
  if (value.survey !== undefined) {
    if (!isRecord(value.survey)) throw new Error('survey must be an object');
    const normalizedSurvey: {
      enjoyment?: number;
      immersion?: number;
      mastery?: number;
      control?: number;
      tension?: number;
      comment?: string;
    } = {};
    for (const dimension of SURVEY_DIMENSIONS) {
      const score = value.survey[dimension];
      if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 5) {
        throw new Error(`survey.${dimension} must be an integer from 1 to 5`);
      }
      normalizedSurvey[dimension] = score;
    }
    if (value.survey.comment !== undefined) {
      if (
        typeof value.survey.comment !== 'string' ||
        value.survey.comment.length > MAX_COMMENT_CHARS
      ) {
        throw new Error(`survey.comment must be at most ${MAX_COMMENT_CHARS} characters`);
      }
      normalizedSurvey.comment = value.survey.comment;
    }
    survey = normalizedSurvey;
  }
  if (
    value.issue_description !== undefined &&
    (typeof value.issue_description !== 'string' ||
      value.issue_description.length > MAX_DESCRIPTION_CHARS)
  ) {
    throw new Error(`issue_description must be at most ${MAX_DESCRIPTION_CHARS} characters`);
  }
  if (value.file_issue !== undefined && typeof value.file_issue !== 'boolean') {
    throw new Error('file_issue must be a boolean');
  }

  const shouldFileIssue = survey !== undefined || value.file_issue === true;
  if (value.file_issue === true && !value.issue_description?.trim()) {
    throw new Error('issue_description is required when file_issue is true');
  }
  return {
    bundle: value as unknown as RunBundle,
    ...(requestedRunId ? { requestedRunId } : {}),
    ...(screenshot
      ? { screenshotBase64: screenshot.base64, screenshotFilename: screenshot.filename }
      : {}),
    shouldFileIssue,
  };
}

export function decodePngBase64(value: string): Buffer {
  const payload = value.replace(/^data:image\/png;base64,/, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.length % 4 !== 0) {
    throw new Error('screenshot is not valid base64');
  }
  const decoded = Buffer.from(payload, 'base64');
  if (decoded.length < 4 || decoded.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('screenshot is not a PNG');
  }
  return decoded;
}
