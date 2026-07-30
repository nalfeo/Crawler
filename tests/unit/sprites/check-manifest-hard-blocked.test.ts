/**
 * Regression tests for the pure hard-block validator in
 * check-manifest-hard-blocked.ts.
 *
 * The CI gate exercises only the success path (against the already-clean
 * repository manifest); these tests exercise the failure cases so the
 * enforcement logic cannot silently regress.
 */

import { describe, expect, it } from 'vitest';
import {
  validateNoHardBlockedEntries,
  type ManifestEntryShape,
} from '../../../scripts/sprites/check-manifest-hard-blocked.js';

// ---------------------------------------------------------------------------
// validateNoHardBlockedEntries
// ---------------------------------------------------------------------------

describe('validateNoHardBlockedEntries', () => {
  it('returns no errors for an empty entries object', () => {
    expect(validateNoHardBlockedEntries({})).toEqual([]);
  });

  it('returns no errors when all entries have hardBlocked=false', () => {
    const entries: Record<string, ManifestEntryShape> = {
      'iron-sword-var-0': { judgeScorecard: { hardBlocked: false } },
      'staff-var-1': { judgeScorecard: { hardBlocked: false, hardBlockInstruction: null } },
    };
    expect(validateNoHardBlockedEntries(entries)).toEqual([]);
  });

  it('returns no errors when entries have no judgeScorecard', () => {
    const entries: Record<string, ManifestEntryShape> = {
      'iron-sword-var-0': {},
      'staff-var-1': { judgeScorecard: null },
    };
    expect(validateNoHardBlockedEntries(entries)).toEqual([]);
  });

  it('reports an error for an entry with hardBlocked=true', () => {
    const entries: Record<string, ManifestEntryShape> = {
      'welcome-room-floor-stain-var-1': {
        judgeScorecard: {
          hardBlocked: true,
          hardBlockInstruction: 'I HATE THIS SO MUCH YOU MAY NOT USE THIS IN GAME',
        },
      },
    };
    const errors = validateNoHardBlockedEntries(entries);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"welcome-room-floor-stain-var-1"');
    expect(errors[0]).toContain('hardBlocked=true');
    expect(errors[0]).toContain('I HATE THIS SO MUCH YOU MAY NOT USE THIS IN GAME');
  });

  it('reports an entry with hardBlocked=true even without a hardBlockInstruction', () => {
    const entries: Record<string, ManifestEntryShape> = {
      'some-sprite-var-2': {
        judgeScorecard: { hardBlocked: true },
      },
    };
    const errors = validateNoHardBlockedEntries(entries);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"some-sprite-var-2"');
    expect(errors[0]).toContain('hardBlocked=true');
  });

  it('reports all entries with hardBlocked=true (not just the first)', () => {
    const entries: Record<string, ManifestEntryShape> = {
      'a-var-0': { judgeScorecard: { hardBlocked: true } },
      'b-var-1': { judgeScorecard: { hardBlocked: false } },
      'c-var-2': { judgeScorecard: { hardBlocked: true } },
    };
    const errors = validateNoHardBlockedEntries(entries);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('"a-var-0"');
    expect(errors[1]).toContain('"c-var-2"');
  });

  it('uses a custom label in error messages', () => {
    const entries: Record<string, ManifestEntryShape> = {
      'x-var-0': { judgeScorecard: { hardBlocked: true } },
    };
    const errors = validateNoHardBlockedEntries(entries, 'custom-manifest.json');
    expect(errors[0]).toContain('custom-manifest.json');
  });

  it('includes fix instructions in the error message', () => {
    const entries: Record<string, ManifestEntryShape> = {
      'x-var-0': { judgeScorecard: { hardBlocked: true } },
    };
    const errors = validateNoHardBlockedEntries(entries);
    expect(errors[0]).toContain('sprites:unapprove');
  });
});
