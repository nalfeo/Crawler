import { describe, expect, it } from 'vitest';
import {
  KNIP_SUPPRESSIONS,
  extractSuppressionsFromSource,
  findExpiredSuppressions,
  findReasonRestatementViolations,
  type KnipSuppression,
} from '../../../scripts/agent/health/knip-suppressions.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALPHA: KnipSuppression = {
  file: 'src/shared/alpha.ts',
  issues: ['exports'],
  reason: 'Alpha is pending wiring in issue #100.',
  expiresOn: '2030-12-31',
};

const BETA: KnipSuppression = {
  file: 'src/shared/beta.ts',
  issues: ['exports'],
  reason: 'Beta is pending a downstream feature in issue #200.',
  expiresOn: '2030-12-31',
};

// ---------------------------------------------------------------------------
// findExpiredSuppressions
// ---------------------------------------------------------------------------

describe('findExpiredSuppressions', () => {
  it('returns empty when no suppressions are expired', () => {
    const result = findExpiredSuppressions([ALPHA, BETA], '2026-01-01');
    expect(result).toHaveLength(0);
  });

  it('flags a suppression whose expiresOn is before today', () => {
    const expired: KnipSuppression = { ...ALPHA, expiresOn: '2025-01-01' };
    const result = findExpiredSuppressions([expired, BETA], '2026-07-30');
    expect(result).toHaveLength(1);
    const [firstExpired] = result;
    expect(firstExpired!.file).toBe('src/shared/alpha.ts');
  });

  it('flags a suppression whose expiresOn equals today (boundary)', () => {
    const expired: KnipSuppression = { ...ALPHA, expiresOn: '2026-07-30' };
    const result = findExpiredSuppressions([expired], '2026-07-30');
    expect(result).toHaveLength(1);
  });

  it('does NOT flag a suppression expiring tomorrow', () => {
    const future: KnipSuppression = { ...ALPHA, expiresOn: '2026-07-31' };
    const result = findExpiredSuppressions([future], '2026-07-30');
    expect(result).toHaveLength(0);
  });

  it('returns all expired entries when multiple have passed', () => {
    const e1: KnipSuppression = { ...ALPHA, expiresOn: '2020-01-01' };
    const e2: KnipSuppression = { ...BETA, expiresOn: '2021-06-15' };
    const result = findExpiredSuppressions([e1, e2], '2026-07-30');
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// findReasonRestatementViolations
// ---------------------------------------------------------------------------

describe('findReasonRestatementViolations', () => {
  it('flags when expiresOn changes but reason stays the same', () => {
    const previous = [{ ...ALPHA, expiresOn: '2026-07-01' }];
    const current = [ALPHA]; // same reason, but expiresOn is now '2030-12-31'

    const violations = findReasonRestatementViolations(previous, current);
    expect(violations).toHaveLength(1);
    const [firstViolation] = violations;
    expect(firstViolation!.file).toBe('src/shared/alpha.ts');
    expect(firstViolation!.previousExpiresOn).toBe('2026-07-01');
    expect(firstViolation!.currentExpiresOn).toBe('2030-12-31');
  });

  it('passes when expiresOn and reason BOTH change', () => {
    const previous = [{ ...ALPHA, expiresOn: '2026-07-01', reason: 'Old reason.' }];
    const current = [ALPHA]; // new reason and new expiresOn

    expect(findReasonRestatementViolations(previous, current)).toHaveLength(0);
  });

  it('passes when only reason changes (expiresOn unchanged)', () => {
    const previous = [{ ...ALPHA, reason: 'Old reason.' }];
    const current = [ALPHA]; // same expiresOn, different reason

    expect(findReasonRestatementViolations(previous, current)).toHaveLength(0);
  });

  it('does NOT flag when expiresOn is shortened with the same reason', () => {
    const previous = [ALPHA];
    const current = [{ ...ALPHA, expiresOn: '2029-12-31' }];

    expect(findReasonRestatementViolations(previous, current)).toHaveLength(0);
  });

  it('does NOT flag a newly added entry (no previous baseline)', () => {
    const previous: KnipSuppression[] = [];
    const current = [ALPHA];

    expect(findReasonRestatementViolations(previous, current)).toHaveLength(0);
  });

  it('does NOT flag a removed entry (present in previous but not current)', () => {
    const previous = [ALPHA];
    const current: KnipSuppression[] = [];

    expect(findReasonRestatementViolations(previous, current)).toHaveLength(0);
  });

  it('checks each entry independently', () => {
    const previous = [
      { ...ALPHA, expiresOn: '2026-01-01' }, // will violate
      { ...BETA, expiresOn: '2026-01-01', reason: 'Old beta reason.' }, // won't violate (reason changes)
    ];
    const current = [
      ALPHA, // same reason, bumped date → violation
      BETA, // both reason and date changed → no violation
    ];

    const violations = findReasonRestatementViolations(previous, current);
    expect(violations).toHaveLength(1);
    const [firstViolation] = violations;
    expect(firstViolation!.file).toBe('src/shared/alpha.ts');
  });
});

// ---------------------------------------------------------------------------
// extractSuppressionsFromSource
// ---------------------------------------------------------------------------

describe('extractSuppressionsFromSource', () => {
  it('extracts a simple suppressions array from source text', () => {
    const source = `
export const KNIP_SUPPRESSIONS: readonly KnipSuppression[] = [
  {
    file: 'src/shared/foo.ts',
    issues: ['exports'],
    reason: 'Pending wiring.',
    expiresOn: '2030-01-01',
  },
];
`.trim();

    const result = extractSuppressionsFromSource(source);
    expect(result).toHaveLength(1);
    const [firstSuppression] = result;
    expect(firstSuppression!.file).toBe('src/shared/foo.ts');
    expect(firstSuppression!.expiresOn).toBe('2030-01-01');
  });

  it('extracts an empty array', () => {
    const source = 'export const KNIP_SUPPRESSIONS: readonly KnipSuppression[] = [];';
    expect(extractSuppressionsFromSource(source)).toHaveLength(0);
  });

  it('throws when the KNIP_SUPPRESSIONS declaration cannot be found', () => {
    const source = 'export const SOMETHING_ELSE = [];';
    expect(() => extractSuppressionsFromSource(source)).toThrow(
      'Could not find KNIP_SUPPRESSIONS declaration',
    );
  });
});

// ---------------------------------------------------------------------------
// Live KNIP_SUPPRESSIONS list validation
// ---------------------------------------------------------------------------

describe('KNIP_SUPPRESSIONS (live list integrity)', () => {
  it('every entry has a non-empty file path', () => {
    for (const s of KNIP_SUPPRESSIONS) {
      expect(s.file.trim()).not.toBe('');
    }
  });

  it('every entry has at least one issue category', () => {
    for (const s of KNIP_SUPPRESSIONS) {
      expect(s.issues.length).toBeGreaterThan(0);
    }
  });

  it('every entry has a non-empty reason', () => {
    for (const s of KNIP_SUPPRESSIONS) {
      expect(s.reason.trim()).not.toBe('');
    }
  });

  it('every entry has a valid ISO-8601 expiresOn date', () => {
    const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
    for (const s of KNIP_SUPPRESSIONS) {
      expect(s.expiresOn).toMatch(ISO_DATE);
      // Also verify it parses as a real date (e.g. not 2026-13-01).
      const parsed = new Date(s.expiresOn);
      expect(isNaN(parsed.getTime())).toBe(false);
    }
  });

  it('no entry has the placeholder "YYYY-MM-DD" expiry', () => {
    for (const s of KNIP_SUPPRESSIONS) {
      expect(s.expiresOn).not.toBe('YYYY-MM-DD');
    }
  });
});
