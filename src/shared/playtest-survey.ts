export interface PlaytestSurvey {
  readonly enjoyment: number;
  readonly immersion: number;
  readonly mastery: number;
  readonly control: number;
  readonly tension: number;
  readonly comment?: string;
}

const PLAYTEST_DIMENSIONS = ['enjoyment', 'immersion', 'mastery', 'control', 'tension'] as const;

function isValidDimensionScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5;
}

export function serializePlaytestSurvey(input: PlaytestSurvey): PlaytestSurvey {
  const next: Record<string, unknown> = {};
  for (const key of PLAYTEST_DIMENSIONS) {
    next[key] = input[key];
  }
  const comment = typeof input.comment === 'string' ? input.comment.trim() : '';
  if (comment.length > 0) {
    next.comment = comment;
  }
  return next as unknown as PlaytestSurvey;
}

/**
 * Parses and validates a candidate survey payload against the PR2 ingest
 * contract: every dimension must be present as an integer from 1 to 5. Any
 * missing or out-of-range dimension makes the whole survey invalid, since a
 * partially valid payload would pass client-side checks and then be rejected
 * by `/runs`.
 */
export function validatePlaytestSurvey(value: unknown): PlaytestSurvey | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  const survey: Record<string, unknown> = {};
  for (const key of PLAYTEST_DIMENSIONS) {
    const score = obj[key];
    if (!isValidDimensionScore(score)) {
      return undefined;
    }
    survey[key] = score;
  }
  if (obj.comment !== undefined) {
    if (typeof obj.comment !== 'string') {
      return undefined;
    }
    const comment = obj.comment.trim();
    if (comment.length > 0) {
      survey.comment = comment;
    }
  }
  return survey as unknown as PlaytestSurvey;
}
