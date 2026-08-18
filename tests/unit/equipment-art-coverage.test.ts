import { describe, expect, it } from 'vitest';

import {
  addedBaselineIds,
  baselineWouldWiden,
  classifyArtStatus,
  evaluateCoverage,
  formatReport,
  nextBaseline,
  type EquipmentArtRow,
} from '../../scripts/agent/health/equipment-art-coverage-lib.js';

/** The production predicate's shape, reproduced so the lib stays fixture-driven. */
const isPlaceholder = (entry: { readonly assetPath: string; readonly briefId: string }): boolean =>
  entry.assetPath.endsWith('-placeholder.png');

function row(
  id: string,
  status: EquipmentArtRow['status'],
  source: EquipmentArtRow['source'] = 'floor2-pool',
): EquipmentArtRow {
  return {
    id,
    source,
    status,
    assetPath: status === 'none' ? null : `generated/${id}.png`,
    briefId: status === 'none' ? null : id,
  };
}

describe('classifyArtStatus', () => {
  it('classifies a missing resolution as none', () => {
    expect(classifyArtStatus(null, isPlaceholder)).toBe('none');
  });

  it('classifies a placeholder entry as placeholder, never as real', () => {
    expect(
      classifyArtStatus(
        { assetPath: 'generated/iron-sword-placeholder.png', briefId: 'iron-sword' },
        isPlaceholder,
      ),
    ).toBe('placeholder');
  });

  it('classifies approved art as real', () => {
    expect(
      classifyArtStatus(
        { assetPath: 'generated/bone-saw-var-0.png', briefId: 'bone-saw' },
        isPlaceholder,
      ),
    ).toBe('real');
  });
});

describe('evaluateCoverage', () => {
  it('passes when every gap is already in the baseline', () => {
    const result = evaluateCoverage([row('a', 'real'), row('b', 'placeholder'), row('c', 'none')], {
      gaps: ['b', 'c'],
    });
    expect(result.ok).toBe(true);
    expect(result.newGaps).toEqual([]);
    expect(result.counts).toEqual({ total: 3, real: 1, placeholder: 1, none: 1 });
  });

  it('FAILS on a new placeholder gap — a placeholder is not coverage', () => {
    const result = evaluateCoverage([row('a', 'real'), row('b', 'placeholder')], { gaps: [] });
    expect(result.ok).toBe(false);
    expect(result.newGaps).toEqual(['b']);
  });

  it('FAILS on a new no-art gap', () => {
    const result = evaluateCoverage([row('a', 'none')], { gaps: [] });
    expect(result.ok).toBe(false);
    expect(result.newGaps).toEqual(['a']);
  });

  it('FAILS when a previously-real piece regresses to a placeholder', () => {
    const result = evaluateCoverage([row('a', 'placeholder')], { gaps: [] });
    expect(result.ok).toBe(false);
    expect(result.newGaps).toEqual(['a']);
  });

  it('reports closed gaps as progress without failing', () => {
    const result = evaluateCoverage([row('a', 'real'), row('b', 'placeholder')], {
      gaps: ['a', 'b'],
    });
    expect(result.ok).toBe(true);
    expect(result.closedGaps).toEqual(['a']);
  });

  it('fails when a baseline id silently leaves the wired ID space', () => {
    // Otherwise the ratchet could be laundered by shrinking the enumerated ID
    // space rather than by shipping art: dropping an un-arted piece out of the
    // reward pool would read exactly like closing the gap.
    const result = evaluateCoverage([row('a', 'real')], { gaps: ['a', 'deleted-piece'] });
    expect(result.ok).toBe(false);
    expect(result.staleBaselineIds).toEqual(['deleted-piece']);
    expect(result.closedGaps).toEqual(['a']);
    // It is NOT a new gap — the distinction matters for the operator message.
    expect(result.newGaps).toEqual([]);
  });

  it('emits gaps in sorted order regardless of row order', () => {
    const result = evaluateCoverage([row('z', 'none'), row('a', 'none'), row('m', 'none')], {
      gaps: ['a', 'm', 'z'],
    });
    expect(result.gaps).toEqual(['a', 'm', 'z']);
  });
});

describe('the ratchet is shrink-only', () => {
  it('nextBaseline records exactly the observed gaps', () => {
    const result = evaluateCoverage([row('a', 'real'), row('b', 'placeholder')], {
      gaps: ['a', 'b'],
    });
    expect(nextBaseline(result)).toEqual({ gaps: ['b'] });
  });

  it('shrinking the baseline is allowed', () => {
    expect(baselineWouldWiden({ gaps: ['a', 'b'] }, { gaps: ['b'] })).toBe(false);
  });

  it('an unchanged baseline is allowed', () => {
    expect(baselineWouldWiden({ gaps: ['a', 'b'] }, { gaps: ['a', 'b'] })).toBe(false);
  });

  it('ADDING an id to the baseline is refused', () => {
    expect(baselineWouldWiden({ gaps: ['a'] }, { gaps: ['a', 'b'] })).toBe(true);
  });

  it('reports ids added to the committed baseline in sorted order', () => {
    expect(addedBaselineIds({ gaps: ['b'] }, { gaps: ['z', 'a', 'b'] })).toEqual(['a', 'z']);
  });

  it('an update after a passing run can never widen', () => {
    // On a passing run every gap is already in the baseline, so the computed
    // next baseline is necessarily a subset. This is the structural property
    // that makes the file shrink-only rather than merely conventionally so.
    const baseline = { gaps: ['b', 'c'] };
    const result = evaluateCoverage(
      [row('a', 'real'), row('b', 'placeholder'), row('c', 'none')],
      baseline,
    );
    expect(result.ok).toBe(true);
    expect(baselineWouldWiden(baseline, nextBaseline(result))).toBe(false);
  });
});

describe('formatReport', () => {
  it('names each failing piece and its status', () => {
    const report = formatReport(evaluateCoverage([row('weapon.war-fan', 'none')], { gaps: [] }));
    expect(report).toContain('weapon.war-fan (none)');
    expect(report).toContain('shrink-only');
  });

  it('states success when there are no new gaps', () => {
    expect(formatReport(evaluateCoverage([row('a', 'real')], { gaps: [] }))).toContain(
      'No new equipment art gaps',
    );
  });
});
