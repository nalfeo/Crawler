import { describe, expect, it } from 'vitest';
import {
  decodePngBase64,
  validateRunBundle,
} from '../../functions/dev-build-ingest/src/validation.js';

const validRun = {
  runStats: { outcome: 'win' },
  recorderJsonl: '{"frame":1}\n',
  logs: 'ok',
  meta: { version: 'dev' },
};

describe('dev-build ingest validation', () => {
  it('accepts silent run bundles without filing an issue', () => {
    expect(validateRunBundle(validRun, JSON.stringify(validRun).length).shouldFileIssue).toBe(
      false,
    );
  });

  it('requires all five survey dimensions and gates issue filing', () => {
    const result = validateRunBundle(
      {
        ...validRun,
        survey: { enjoyment: 5, immersion: 4, mastery: 3, control: 4, tension: 2, comment: 'good' },
      },
      100,
    );
    expect(result.shouldFileIssue).toBe(true);
  });

  it('rejects out-of-range survey scores and issue reports without descriptions', () => {
    expect(() => validateRunBundle({ ...validRun, survey: { enjoyment: 6 } }, 100)).toThrow(
      'survey.enjoyment',
    );
    expect(() => validateRunBundle({ ...validRun, file_issue: true }, 100)).toThrow(
      'issue_description',
    );
  });

  it('decodes PNG data URLs and rejects non-PNG bytes', () => {
    const png = 'iVBORw0KGgo=';
    expect(decodePngBase64(`data:image/png;base64,${png}`).readUInt32BE(0)).toBe(0x89504e47);
    expect(() => decodePngBase64('bm90IHBuZw==')).toThrow('not a PNG');
  });
});
