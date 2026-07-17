import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateEpicState,
  computeReadySlices,
  formatStatusTable,
  formatMaterializationPlan,
  type EpicState,
  type SliceNode,
} from '../../scripts/agent/epic-status-lib.js';
import { parseArgs, runGitHubReconcile } from '../../scripts/agent/epic-status.js';

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
  const defaultCommitEvidence = status === 'validated' || status === 'merged' ? '1234567' : null;
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
    commit_evidence: defaultCommitEvidence,
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

  it('rejects unknown top-level properties', () => {
    const state = makeMinimalState([makeSlice('slice:A0', 'validated')]);
    expect(() =>
      validateEpicState({ ...state, unexpected_root_key: true } as EpicState & {
        unexpected_root_key: boolean;
      }),
    ).toThrow(/unrecognized key/i);
  });

  it('rejects unknown nested slice properties', () => {
    const state = makeMinimalState([
      {
        ...makeSlice('slice:A0', 'validated'),
        github_isse: 42,
      } as SliceNode & { github_isse: number },
    ]);
    expect(() => validateEpicState(state)).toThrow(/unrecognized key/i);
  });

  it('rejects done slices without commit evidence', () => {
    const state = makeMinimalState([
      makeSlice('slice:A0', 'validated', [], { commit_evidence: null }),
    ]);
    expect(() => validateEpicState(state)).toThrow(/done status validated but no commit_evidence/i);
  });

  it('rejects an invalid slice status', () => {
    const slice = { ...makeSlice('slice:A0', 'validated'), status: 'not-a-status' };
    expect(() => validateEpicState(makeMinimalState([slice as unknown as SliceNode]))).toThrow();
  });

  it('rejects a state with duplicate slice IDs', () => {
    const state = makeMinimalState([
      makeSlice('slice:A0', 'validated'),
      makeSlice('slice:A0', 'planned'), // duplicate
    ]);
    expect(() => validateEpicState(state)).toThrow(/Duplicate slice id/);
  });

  it('rejects a slice with a self-reference dependency', () => {
    const state = makeMinimalState([makeSlice('slice:A0', 'planned', ['slice:A0'])]);
    expect(() => validateEpicState(state)).toThrow(/self-reference/);
  });

  it('detects a cycle in the dependency graph', () => {
    const state = makeMinimalState([
      makeSlice('slice:A0', 'planned', ['slice:B1']),
      makeSlice('slice:B1', 'planned', ['slice:A0']),
    ]);
    expect(() => validateEpicState(state)).toThrow(/cycle/);
  });

  it('rejects duplicate gate checkpoint IDs', () => {
    const state = makeMinimalState([makeSlice('slice:A0', 'validated')]);
    const dupCp = { ...state };
    dupCp.hard_release_gate = {
      ...state.hard_release_gate,
      checkpoints: [
        state.hard_release_gate.checkpoints[0]!,
        state.hard_release_gate.checkpoints[0]!, // duplicate cp id
      ],
    };
    expect(() => validateEpicState(dupCp)).toThrow(/Duplicate gate checkpoint id/);
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

  it('excludes deferred planned slices from the ready queue', () => {
    const state = makeMinimalState([makeSlice('slice:A0', 'planned', [], { deferred: true })]);
    expect(computeReadySlices(state)).toHaveLength(0);
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

  it('excludes deferred:true slices even when status is planned and all deps are validated', () => {
    const state = makeMinimalState([
      makeSlice('slice:A0', 'validated'),
      makeSlice('slice:B1', 'planned', ['slice:A0'], { deferred: true }),
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

  it('shows actual dependency statuses for ready slices', () => {
    const state = makeMinimalState([
      makeSlice('slice:A0', 'merged'),
      makeSlice('slice:B1', 'planned', ['slice:A0']),
    ]);
    const out = formatMaterializationPlan(state);
    expect(out).toContain('slice:A0 (merged)');
    expect(out).not.toContain('all validated');
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

  it('excludes deferred planned slices from the blocked list', () => {
    const state = makeMinimalState([
      makeSlice('slice:A0', 'planned'),
      makeSlice('slice:B1', 'planned', ['slice:A0'], { deferred: true }),
    ]);
    const out = formatMaterializationPlan(state);
    expect(out).not.toContain('### slice:B1');
  });

  it('shows no ready slices message when none exist', () => {
    const state = makeMinimalState([makeSlice('slice:A0', 'in_progress')]);
    const out = formatMaterializationPlan(state);
    expect(out).toContain('No slices are currently computed-ready');
  });

  it('excludes deferred:true slices from the Blocked section', () => {
    const state = makeMinimalState([
      makeSlice('slice:A0', 'planned'),
      makeSlice('slice:B1', 'planned', ['slice:A0'], { deferred: true }),
    ]);
    const out = formatMaterializationPlan(state);
    // B1 is deferred so it must NOT appear in the Blocked section
    expect(out).not.toContain('slice:B1');
  });
});

// ---------------------------------------------------------------------------
// Smoke test: validate the checked-in floor-2-equipment epic-state.json
// ---------------------------------------------------------------------------

describe('floor-2-equipment epic-state.json smoke test', () => {
  it('parses and validates against the live state file', () => {
    const here = fileURLToPath(import.meta.url);
    const stateFile = path.resolve(
      here,
      '../../../docs/knowledge/epics/floor-2-equipment/epic-state.json',
    );
    const raw = JSON.parse(readFileSync(stateFile, 'utf-8'));
    const state = validateEpicState(raw);
    // Structural sanity
    expect(state.epic_id).toBe('floor-2-equipment');
    expect(state.slices.length).toBeGreaterThanOrEqual(7);
    // Every dep must reference an existing slice id
    const ids = new Set(state.slices.map((s) => s.id));
    for (const slice of state.slices) {
      for (const dep of slice.dependencies) {
        expect(ids.has(dep), `${slice.id} dep ${dep} missing`).toBe(true);
      }
    }
    // Hard gate has at least 2 checkpoints
    expect(state.hard_release_gate.checkpoints.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

function argv(...args: string[]): string[] {
  return ['node', 'epic-status.js', ...args];
}

describe('parseArgs', () => {
  it('parses a valid epic-id with no flags', () => {
    const result = parseArgs(argv('floor-2-equipment'));
    expect(result).toEqual({
      epicId: 'floor-2-equipment',
      github: false,
      reconcile: false,
      materializationPlan: false,
    });
  });

  it('parses --materialization-plan flag', () => {
    const result = parseArgs(argv('floor-2-equipment', '--materialization-plan'));
    expect(result.materializationPlan).toBe(true);
    expect(result.epicId).toBe('floor-2-equipment');
  });

  it('parses --github --reconcile flags', () => {
    const result = parseArgs(argv('floor-2-equipment', '--github', '--reconcile'));
    expect(result.github).toBe(true);
    expect(result.reconcile).toBe(true);
  });

  it('throws when no epic-id is provided', () => {
    expect(() => parseArgs(argv())).toThrow(/Usage/);
  });

  it('throws when first arg is a flag (no positional epic-id)', () => {
    expect(() => parseArgs(argv('--github'))).toThrow(/Usage/);
  });

  it('throws when epic-id is not kebab-case', () => {
    expect(() => parseArgs(argv('Floor_2_Equipment'))).toThrow(/kebab-case/);
  });

  it('throws when --reconcile is used without --github', () => {
    expect(() => parseArgs(argv('floor-2-equipment', '--reconcile'))).toThrow(
      /--reconcile requires --github/,
    );
  });
});

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('accepts the default offline mode', () => {
    expect(parseArgs(['node', 'epic-status.ts', 'floor-2-equipment'])).toEqual({
      epicId: 'floor-2-equipment',
      github: false,
      reconcile: false,
      materializationPlan: false,
    });
  });

  it('rejects unknown flags and extra args', () => {
    expect(() =>
      parseArgs(['node', 'epic-status.ts', 'floor-2-equipment', '--materialisation-plan']),
    ).toThrow(/Unknown argument/);
    expect(() =>
      parseArgs(['node', 'epic-status.ts', 'floor-2-equipment', 'extra-positional-arg']),
    ).toThrow(/Unknown argument/);
  });

  it('rejects github mode without reconcile', () => {
    expect(() => parseArgs(['node', 'epic-status.ts', 'floor-2-equipment', '--github'])).toThrow(
      /--github requires --reconcile/,
    );
  });

  it('rejects conflicting mode combinations', () => {
    expect(() =>
      parseArgs([
        'node',
        'epic-status.ts',
        'floor-2-equipment',
        '--materialization-plan',
        '--github',
        '--reconcile',
      ]),
    ).toThrow(/cannot be combined/);
  });
});

describe('runGitHubReconcile', () => {
  it('checks pull request state when a slice records a PR', async () => {
    const state = makeMinimalState([
      makeSlice('slice:A0', 'planned', [], { github_issue: null, pr: 77 }),
    ]);
    const writes: string[] = [];
    const fetchImpl: typeof fetch = (async (input: string | URL | Request) => {
      expect(String(input)).toContain('/pulls/77');
      return {
        ok: true,
        status: 200,
        json: async () => ({ merged: true, state: 'closed' }),
      } as Response;
    }) as typeof fetch;

    const discrepancies = await runGitHubReconcile(state, {
      fetchImpl,
      token: 'test-token',
      stdout: { write: (chunk: string) => writes.push(chunk) },
      stderr: { write: (chunk: string) => writes.push(chunk) },
    });

    expect(discrepancies).toBe(1);
    expect(writes.join('')).toContain(
      'PR #77 is merged on GitHub but slice is not validated/merged',
    );
  });

  it('still audits the PR when the issue fetch fails', async () => {
    const state = makeMinimalState([
      makeSlice('slice:A0', 'planned', [], { github_issue: 42, pr: 77 }),
    ]);
    const writes: string[] = [];
    const fetchImpl: typeof fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/issues/42')) {
        return { ok: false, status: 500, json: async () => ({}) } as Response;
      }
      if (url.includes('/pulls/77')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ merged: true, state: 'closed' }),
        } as Response;
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const discrepancies = await runGitHubReconcile(state, {
      fetchImpl,
      token: 'test-token',
      stdout: { write: (chunk: string) => writes.push(chunk) },
      stderr: { write: (chunk: string) => writes.push(chunk) },
    });

    expect(discrepancies).toBe(2);
    expect(writes.join('')).toContain('HTTP 500 for issue #42');
    expect(writes.join('')).toContain(
      'PR #77 is merged on GitHub but slice is not validated/merged',
    );
  });
});
