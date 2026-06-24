import { describe, expect, it } from 'vitest';

import {
  buildAppleEntry,
  helloKittiesFromActual,
  parseCliArgs,
  verdictFromDelta,
} from '../../scripts/agent/docs/write-apple-metrics';

describe('apple metrics writer', () => {
  it('computes verdicts from delta', () => {
    expect(verdictFromDelta(0)).toBe('exact');
    expect(verdictFromDelta(1)).toBe('under');
    expect(verdictFromDelta(-1)).toBe('over');
    expect(verdictFromDelta(2)).toBe('miss');
    expect(verdictFromDelta(-2)).toBe('miss');
  });

  it('rounds hello kitty values to 2 decimals', () => {
    expect(helloKittiesFromActual(3)).toBe(0.6);
    expect(helloKittiesFromActual(1)).toBe(0.2);
  });

  it('builds canonical apple entry payload', () => {
    expect(
      buildAppleEntry({
        date: '2026-06-24',
        session: 'apple-writer',
        estimated: 3,
        actual: 2,
      }),
    ).toEqual({
      date: '2026-06-24',
      session: 'apple-writer',
      estimated_apples: 3,
      actual_apples: 2,
      delta: -1,
      verdict: 'over',
      hello_kitties: 0.4,
    });
  });

  it('parses valid cli args', () => {
    expect(
      parseCliArgs([
        '--date',
        '2026-06-24',
        '--session',
        'apple-writer',
        '--estimated',
        '3',
        '--actual',
        '2',
      ]),
    ).toEqual({
      date: '2026-06-24',
      session: 'apple-writer',
      estimated: 3,
      actual: 2,
      overwrite: false,
    });
  });

  it('rejects invalid session slug', () => {
    expect(() =>
      parseCliArgs([
        '--date',
        '2026-06-24',
        '--session',
        'Bad Session',
        '--estimated',
        '3',
        '--actual',
        '2',
      ]),
    ).toThrow(/--session/);
  });
});
