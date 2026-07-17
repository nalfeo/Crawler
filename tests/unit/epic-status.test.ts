import { describe, expect, it } from 'vitest';
import {
  validateEpicState,
  computeReadySlices,
  formatStatusTable,
  formatMaterializationPlan,
  type EpicState,
  type SliceNode,
} from '../../scripts/agent/epic-status-lib.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSlice(
  id: string,
  status: SliceNode['status'],
  deps: string[] = [],
  overrides: Partial<SliceNode> = {},
): SliceNode {
  const tierMatch = id.match(/^slice:([A-Z])(\d+)$/);
  if (!tierMatch || tierMatch[1] === undefined || tierMatch[2] === undefined) {
    throw new Error(`Invalid slice id: ${id}`);
  }
  const tier = tierMatch[1] as 'A' | 'B' | 'C';
  const seq = parseInt(tierMatch[2], 10);
  return {
    id,
    title: `Test slice ${id}`,
    tier,
    seq,
    status,
    scope: `Scope for ${id}`,
    deferred: false,
    github_issue: null,
    pr: null,
    commit_evidence: null,
    dependencies: deps,
    ...overrides,
  };
}

function makeMinimalState(slices: SliceNode[]): EpicState {
  return {
    epic_id: 'test-epic',
    title: 'Test Epic',
    github_issue: 42,
    schema_version: '1.0.0',
    updated_at: '2026-07-17T12:00:00.000Z',
    hard_release_gate: {
      description: 'Test gate',
      checkpoints: [
        {
          id: 'cp1',
          label: 'Checkpoint 1',
          target_min: 1.5,
          target_max: 2.5,
          measured_value: null,
          status: 'pending',
          evidence_commit: null,
        },
      ],
      status: 'pending',
      evidence_commit: null,
    },
    slices,
  };
}

// ---------------------------------------------------------------------------
// validateEpicState
// ---------------------------------------------------------------------------

describe('validateEpicState', () => {
  it('accepts a valid minimal state', () => {
    const state = makeMinimalState([makeSlice('slice:A0', 'validated')]);
    expect(() => validateEpicState(state)).not.toThrow();
  });

  it('rejects a state missing required fields', () => {
    expect(() => validateEpicState({ epic_id: 'x' })).toThrow(/Epic state validation failed/);
  });

  it('rejects an invalid epic_id', () => {
    const state = makeMinimalState([makeSlice('slice:A0', 'validated')]);
    const invalid = { ...state, epic_id: 'Has Uppercase' };
    expect(() => validateEpicState(invalid)).toThrow();
  });

  it('rejects a slice with an invalid id format', () => {
    const bad = makeSlice('slice:A0', 'validated');
    const state = makeMinimalState([{ ...bad, id: 'bad-id' }]);
    expect(() => validateEpicState(state)).toThrow();
  });

  it('rejects a slice referencing an unknown dependency', () => {
    const state = makeMinimalState([
      makeSlice('slice:A0', 'validated'),
      // slice:Z9 has the right format but is not in the slices array
      makeSlice('slice:B1', 'planned', ['slice:Z9']),
    ]);
    expect(() => validateEpicState(state)).toThrow(/unknown dependency/);
  });

  it('rejects an invalid slice status', () => {
    const slice = { ...makeSlice('slice:A0', 'validated'), status: 'not-a-status' };
    expect(() => validateEpicState(makeMinimalState([slice as unknown as SliceNode]))).toThrow();
  });

  it('accepts all valid slice statuses', () => {
    const statuses: SliceNode['status'][] = [
      'planned',
      'claimed',
      'in_progress',
      'merged',
      'validated',
      'deferred',
      'blocked',
    ];
    for (const status of statuses) {
      const state = makeMinimalState([makeSlice('slice:A0', status)]);
      expect(() => validateEpicState(state)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// computeReadySlices
// ---------------------------------------------------------------------------

describe('computeReadySlices', () => {
  it('returns a planned slice with no deps', () => {
    const state = makeMinimalState([makeSlice('slice:A0', 'planned')]);
    expect(computeReadySlices(state).map((s) => s.id)).toEqual(['slice:A0']);
  });

  it('returns a planned slice whose deps are all validated', () => {
    const state = makeMinimalState([
      makeSlice('slice:A0', 'validated'),
      makeSlice('slice:B1', 'planned', ['slice:A0']),
    ]);
    expect(computeReadySlices(state).map((s) => s.id)).toEqual(['slice:B1']);
  });

  it('returns a planned slice whose deps are all merged', () => {
    const state = makeMinimalState([
      makeSlice('slice:A0', 'merged'),
      makeSlice('slice:B1', 'planned', ['slice:A0']),
    ]);
    expect(computeReadySlices(state).map((s) => s.id)).toEqual(['slice:B1']);
  });

  it('excludes a planned slice with an unresolved dep', () => {
    const state = makeMinimalState([
      makeSlice('slice:A0', 'planned'),
      makeSlice('slice:B1', 'planned', ['slice:A0']),
    ]);
    // A0 is planned (not done), so B1 must be excluded
    expect(computeReadySlices(state).map((s) => s.id)).toEqual(['slice:A0']);
  });

  it('excludes slices not in planned status', () => {
    const state = makeMinimalState([
      makeSlice('slice:A0', 'claimed'),
      makeSlice('slice:B1', 'validated'),
      makeSlice('slice:B2', 'deferred'),
    ]);
    expect(computeReadySlices(state)).toHaveLength(0);
  });

  it('handles a multi-dep slice where only some deps are done', () => {
    const state = makeMinimalState([
      makeSlice('slice:A0', 'validated'),
      makeSlice('slice:B1', 'planned'), // dep of C1 — not done
      makeSlice('slice:B2', 'validated'),
      makeSlice('slice:C1', 'planned', ['slice:B1', 'slice:B2']),
    ]);
    const ready = computeReadySlices(state).map((s) => s.id);
    // B1 is ready (no deps), C1 is NOT (dep B1 is planned)
    expect(ready).toContain('slice:B1');
    expect(ready).not.toContain('slice:C1');
  });

  it('returns multiple ready slices when parallel deps are met', () => {
    const state = makeMinimalState([
      makeSlice('slice:A0', 'validated'),
      makeSlice('slice:B1', 'planned', ['slice:A0']),
      makeSlice('slice:B2', 'planned', ['slice:A0']),
      makeSlice('slice:B3', 'planned', ['slice:A0']),
    ]);
    const ready = computeReadySlices(state).map((s) => s.id);
    expect(ready).toEqual(['slice:B1', 'slice:B2', 'slice:B3']);
  });
});

// ---------------------------------------------------------------------------
// formatStatusTable
// ---------------------------------------------------------------------------

describe('formatStatusTable', () => {
  it('includes epic title and issue number', () => {
    const state = makeMinimalState([makeSlice('slice:A0', 'planned')]);
    const out = formatStatusTable(state);
    expect(out).toContain('Test Epic');
    expect(out).toContain('#42');
  });

  it('includes hard release gate status', () => {
    const state = makeMinimalState([makeSlice('slice:A0', 'validated')]);
    const out = formatStatusTable(state);
    expect(out).toContain('PENDING');
  });

  it('includes a row for each slice', () => {
    const state = makeMinimalState([
      makeSlice('slice:A0', 'validated'),
      makeSlice('slice:B1', 'planned', ['slice:A0']),
    ]);
    const out = formatStatusTable(state);
    expect(out).toContain('slice:A0');
    expect(out).toContain('slice:B1');
  });

  it('lists computed-ready slices', () => {
    const state = makeMinimalState([
      makeSlice('slice:A0', 'validated'),
      makeSlice('slice:B1', 'planned', ['slice:A0']),
    ]);
    const out = formatStatusTable(state);
    expect(out).toContain('B1');
  });

  it('shows none when no slices are ready', () => {
    const state = makeMinimalState([makeSlice('slice:A0', 'in_progress')]);
    const out = formatStatusTable(state);
    expect(out).toContain('(none)');
  });
});

// ---------------------------------------------------------------------------
// formatMaterializationPlan
// ---------------------------------------------------------------------------

describe('formatMaterializationPlan', () => {
  it('includes a heading for the epic', () => {
    const state = makeMinimalState([makeSlice('slice:A0', 'validated')]);
    const out = formatMaterializationPlan(state);
    expect(out).toContain('# Materialization plan');
    expect(out).toContain('Test Epic');
  });

  it('lists ready slices with suggested issue title', () => {
    const state = makeMinimalState([
      makeSlice('slice:A0', 'validated'),
      makeSlice('slice:B1', 'planned', ['slice:A0']),
    ]);
    const out = formatMaterializationPlan(state);
    expect(out).toContain('slice:B1');
    expect(out).toContain('feat(test-epic)');
  });

  it('lists blocked slices with unresolved deps', () => {
    const state = makeMinimalState([
      makeSlice('slice:A0', 'planned'),
      makeSlice('slice:B1', 'planned', ['slice:A0']),
    ]);
    const out = formatMaterializationPlan(state);
    // B1 is blocked because A0 is planned, not validated
    expect(out).toContain('Blocked');
    expect(out).toContain('slice:B1');
  });

  it('shows no ready slices message when none exist', () => {
    const state = makeMinimalState([makeSlice('slice:A0', 'in_progress')]);
    const out = formatMaterializationPlan(state);
    expect(out).toContain('No slices are currently computed-ready');
  });
});
