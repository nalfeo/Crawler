import { describe, expect, it } from 'vitest';
import {
  serializePlaytestSurvey,
  validatePlaytestSurvey,
} from '../../src/shared/playtest-survey.js';

describe('validatePlaytestSurvey', () => {
  const validSurvey = {
    enjoyment: 5,
    immersion: 4,
    mastery: 3,
    control: 2,
    tension: 1,
  };

  it('accepts a survey with every dimension as an integer from 1 to 5', () => {
    expect(validatePlaytestSurvey(validSurvey)).toEqual(validSurvey);
  });

  it('keeps a trimmed, non-empty comment', () => {
    expect(validatePlaytestSurvey({ ...validSurvey, comment: '  Great run!  ' })).toEqual({
      ...validSurvey,
      comment: 'Great run!',
    });
  });

  it('drops a blank comment', () => {
    expect(validatePlaytestSurvey({ ...validSurvey, comment: '   ' })).toEqual(validSurvey);
  });

  it('rejects a survey missing a dimension', () => {
    const { tension: _tension, ...partial } = validSurvey;
    expect(validatePlaytestSurvey(partial)).toBeUndefined();
  });

  it('rejects a fractional score', () => {
    expect(validatePlaytestSurvey({ ...validSurvey, enjoyment: 3.5 })).toBeUndefined();
  });

  it('rejects a score outside the 1-5 range', () => {
    expect(validatePlaytestSurvey({ ...validSurvey, control: 0 })).toBeUndefined();
    expect(validatePlaytestSurvey({ ...validSurvey, control: 6 })).toBeUndefined();
  });

  it('rejects a non-string comment', () => {
    expect(validatePlaytestSurvey({ ...validSurvey, comment: 42 })).toBeUndefined();
  });

  it('rejects non-object input', () => {
    expect(validatePlaytestSurvey(null)).toBeUndefined();
    expect(validatePlaytestSurvey('nope')).toBeUndefined();
  });
});

describe('serializePlaytestSurvey', () => {
  it('carries every dimension and trims a non-empty comment', () => {
    expect(
      serializePlaytestSurvey({
        enjoyment: 5,
        immersion: 4,
        mastery: 3,
        control: 2,
        tension: 1,
        comment: '  Loved it  ',
      }),
    ).toEqual({
      enjoyment: 5,
      immersion: 4,
      mastery: 3,
      control: 2,
      tension: 1,
      comment: 'Loved it',
    });
  });

  it('omits the comment field when blank', () => {
    expect(
      serializePlaytestSurvey({
        enjoyment: 5,
        immersion: 4,
        mastery: 3,
        control: 2,
        tension: 1,
        comment: '   ',
      }),
    ).toEqual({
      enjoyment: 5,
      immersion: 4,
      mastery: 3,
      control: 2,
      tension: 1,
    });
  });
});
