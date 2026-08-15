export interface PlaytestSurvey {
  readonly enjoyment?: number;
  readonly immersion?: number;
  readonly mastery?: number;
  readonly control?: number;
  readonly tension?: number;
  readonly comment?: string;
}

const PLAYTEST_DIMENSIONS = ['enjoyment', 'immersion', 'mastery', 'control', 'tension'] as const;

function isNumberLike(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function serializePlaytestSurvey(input: PlaytestSurvey): PlaytestSurvey {
  const next: PlaytestSurvey = {};
  for (const key of PLAYTEST_DIMENSIONS) {
    const value = input[key];
    if (isNumberLike(value)) {
      next[key] = value;
    }
  }
  const comment = typeof input.comment === 'string' ? input.comment.trim() : '';
  if (comment.length > 0) {
    next.comment = comment;
  }
  return next;
}

export function parsePlaytestSurvey(value: unknown): PlaytestSurvey | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  const survey: PlaytestSurvey = {};
  for (const key of PLAYTEST_DIMENSIONS) {
    if (isNumberLike(obj[key])) {
      survey[key] = obj[key];
    }
  }
  if (typeof obj.comment === 'string') {
    const comment = obj.comment.trim();
    if (comment.length > 0) {
      survey.comment = comment;
    }
  }
  return Object.keys(survey).length > 0 ? survey : undefined;
}

export function validatePlaytestSurvey(value: unknown): PlaytestSurvey | undefined {
  const parsed = parsePlaytestSurvey(value);
  if (!parsed) {
    return undefined;
  }
  for (const key of PLAYTEST_DIMENSIONS) {
    const dimensionValue = parsed[key];
    if (dimensionValue !== undefined && (dimensionValue < 1 || dimensionValue > 5)) {
      return undefined;
    }
  }
  return parsed;
}
