import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  REGISTRY_FILES,
  checkRegistryIntegrity,
  countEntries,
  displayId,
  extractEntries,
  isUsableId,
  type RegistryFileSpec,
  type RegistrySource,
} from '../../../scripts/agent/health/registry-integrity-lib.js';

// ---------------------------------------------------------------------------
// Fixture helpers — every check runs against in-memory sources, so no test
// touches the filesystem except the final real-repo regression test.
// ---------------------------------------------------------------------------

function source(
  id: string,
  scope: string,
  ids: readonly unknown[],
  extra: Partial<RegistrySource> = {},
): RegistrySource {
  return {
    id,
    path: `src/shared/data/${id}.json`,
    scope,
    entries: ids.map((entryId, index) => ({ id: entryId, index })),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Passing case
// ---------------------------------------------------------------------------

describe('checkRegistryIntegrity — clean registries', () => {
  it('returns no findings when every id is unique within and across a scope', () => {
    const findings = checkRegistryIntegrity([
      source('achievements.floor1', 'achievements', ['first-bonk', 'tier4-floor1']),
      source('achievements.floor2', 'achievements', ['floor2-field-kit', 'tier4-floor2']),
      source('weapons', 'weapons', ['sword', 'knife']),
    ]);
    expect(findings).toEqual([]);
  });

  it('allows the same id in two DIFFERENT scopes', () => {
    const findings = checkRegistryIntegrity([
      source('weapons', 'weapons', ['sword']),
      source('achievements.floor1', 'achievements', ['sword']),
    ]);
    expect(findings).toEqual([]);
  });

  it('returns no findings for an empty source list', () => {
    expect(checkRegistryIntegrity([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (a) Duplicate ids WITHIN one file
// ---------------------------------------------------------------------------

describe('checkRegistryIntegrity — duplicate-in-file', () => {
  it('flags the second occurrence of a repeated id, not the first', () => {
    const findings = checkRegistryIntegrity([
      source('boss-abilities.floor2', 'boss-abilities', ['scrap-cart', 'gnash', 'scrap-cart']),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('duplicate-in-file');
    expect(findings[0]?.entryId).toBe('scrap-cart');
    expect(findings[0]?.index).toBe(2);
  });

  it('names the offending file and a concrete remediation', () => {
    const findings = checkRegistryIntegrity([source('weapons', 'weapons', ['bow', 'bow'])]);
    expect(findings[0]?.file).toBe('src/shared/data/weapons.json');
    expect(findings[0]?.remediation).toContain('src/shared/data/weapons.json');
    expect(findings[0]?.remediation).toContain('bow');
  });

  it('reports a triplicated id once per extra occurrence', () => {
    const findings = checkRegistryIntegrity([source('weapons', 'weapons', ['bow', 'bow', 'bow'])]);
    expect(findings.map((f) => f.index)).toEqual([1, 2]);
  });

  it('does not also report an in-file duplicate as a cross-file duplicate', () => {
    const findings = checkRegistryIntegrity([
      source('achievements.floor1', 'achievements', ['tier4']),
      source('achievements.floor2', 'achievements', ['other', 'other']),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('duplicate-in-file');
  });
});

// ---------------------------------------------------------------------------
// (b) Duplicate ids ACROSS files sharing a namespace — the new capability
// ---------------------------------------------------------------------------

describe('checkRegistryIntegrity — duplicate-across-files', () => {
  it('catches the Floor-2 achievements tier4 collision between sibling files', () => {
    const findings = checkRegistryIntegrity([
      source('achievements.floor1', 'achievements', ['first-bonk', 'tier4']),
      source('achievements.floor2', 'achievements', ['floor2-field-kit', 'tier4']),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('duplicate-across-files');
    expect(findings[0]?.entryId).toBe('tier4');
    expect(findings[0]?.file).toBe('src/shared/data/achievements.floor2.json');
    expect(findings[0]?.index).toBe(1);
  });

  it('points the reader at the file that already owns the id', () => {
    const findings = checkRegistryIntegrity([
      source('achievements.floor1', 'achievements', ['tier4']),
      source('achievements.floor2', 'achievements', ['tier4']),
    ]);
    expect(findings[0]?.detail).toContain('src/shared/data/achievements.floor1.json');
    expect(findings[0]?.remediation).toContain('src/shared/data/achievements.floor2.json');
  });

  it('attributes ownership to the first source in list order (deterministic)', () => {
    const reversed = checkRegistryIntegrity([
      source('achievements.floor2', 'achievements', ['tier4']),
      source('achievements.floor1', 'achievements', ['tier4']),
    ]);
    expect(reversed[0]?.file).toBe('src/shared/data/achievements.floor1.json');
  });

  it('flags a collision spanning three files in one scope', () => {
    const findings = checkRegistryIntegrity([
      source('a', 'achievements', ['shared']),
      source('b', 'achievements', ['shared']),
      source('c', 'achievements', ['shared']),
    ]);
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.kind === 'duplicate-across-files')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (c) Empty / blank / non-string ids
// ---------------------------------------------------------------------------

describe('checkRegistryIntegrity — invalid-id', () => {
  it.each([
    ['empty string', ''],
    ['blank string', '   '],
    ['number', 7],
    ['null', null],
    ['missing field (undefined)', undefined],
    ['object', { nested: true }],
  ])('flags an id that is %s', (_label, badId) => {
    const findings = checkRegistryIntegrity([source('weapons', 'weapons', [badId])]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('invalid-id');
    expect(findings[0]?.index).toBe(0);
  });

  it('does not let an invalid id participate in duplicate detection', () => {
    const findings = checkRegistryIntegrity([source('weapons', 'weapons', ['', '', 'sword'])]);
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.kind === 'invalid-id')).toBe(true);
  });

  it('still checks the remaining valid ids in the same file', () => {
    const findings = checkRegistryIntegrity([source('weapons', 'weapons', ['', 'bow', 'bow'])]);
    expect(findings.map((f) => f.kind)).toEqual(['invalid-id', 'duplicate-in-file']);
  });
});

// ---------------------------------------------------------------------------
// (d) Missing / unparseable registry file
// ---------------------------------------------------------------------------

describe('checkRegistryIntegrity — load-error', () => {
  it('reports a load failure as a finding rather than throwing', () => {
    const findings = checkRegistryIntegrity([
      source('weapons', 'weapons', [], { loadError: 'file could not be read (ENOENT)' }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('load-error');
    expect(findings[0]?.file).toBe('src/shared/data/weapons.json');
    expect(findings[0]?.remediation).toContain('registry-integrity-lib.ts');
  });

  it('skips id checks for a failed source but still checks its healthy siblings', () => {
    const findings = checkRegistryIntegrity([
      source('achievements.floor1', 'achievements', ['ghost'], { loadError: 'not valid JSON' }),
      source('achievements.floor2', 'achievements', ['dup', 'dup']),
    ]);
    expect(findings.map((f) => f.kind)).toEqual(['load-error', 'duplicate-in-file']);
  });
});

// ---------------------------------------------------------------------------
// extractEntries — pure shape handling for both real JSON layouts
// ---------------------------------------------------------------------------

const arraySpec: RegistryFileSpec = {
  id: 'weapons',
  path: 'src/shared/data/weapons.json',
  scope: 'weapons',
  idField: 'id',
};

const keyedSpec: RegistryFileSpec = {
  id: 'boss-abilities.floor2',
  path: 'src/shared/data/boss-abilities.floor2.json',
  scope: 'boss-abilities',
  entriesKey: 'entries',
  idField: 'id',
};

describe('extractEntries', () => {
  it('reads a top-level array with index positions preserved', () => {
    const result = extractEntries([{ id: 'sword' }, { id: 'knife' }], arraySpec);
    expect(result.error).toBeUndefined();
    expect(result.entries).toEqual([
      { id: 'sword', index: 0 },
      { id: 'knife', index: 1 },
    ]);
  });

  it('reads entries out of an object with an entries key', () => {
    const result = extractEntries({ schemaVersion: 'v1', entries: [{ id: 'gnash' }] }, keyedSpec);
    expect(result.error).toBeUndefined();
    expect(result.entries).toEqual([{ id: 'gnash', index: 0 }]);
  });

  it('returns an error (not a throw) when a top-level array is expected but absent', () => {
    expect(extractEntries({ entries: [] }, arraySpec).error).toContain('top-level JSON array');
  });

  it('returns an error when the entries key is missing', () => {
    expect(extractEntries({ schemaVersion: 'v1' }, keyedSpec).error).toContain('to be an array');
  });

  it('returns an error when a keyed spec receives an array', () => {
    expect(extractEntries([], keyedSpec).error).toContain('entries');
  });

  it('yields an undefined id for a non-object entry rather than throwing', () => {
    expect(extractEntries([null, 'oops'], arraySpec).entries).toEqual([
      { id: undefined, index: 0 },
      { id: undefined, index: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

describe('helpers', () => {
  it('isUsableId accepts non-blank strings only', () => {
    expect(isUsableId('sword')).toBe(true);
    expect(isUsableId('')).toBe(false);
    expect(isUsableId('  ')).toBe(false);
    expect(isUsableId(3)).toBe(false);
    expect(isUsableId(null)).toBe(false);
  });

  it('displayId renders non-strings readably', () => {
    expect(displayId('sword')).toBe('sword');
    expect(displayId(7)).toBe('7');
    expect(displayId(null)).toBe('null');
    expect(displayId(undefined)).toBe('undefined');
  });

  it('countEntries ignores sources that failed to load', () => {
    const total = countEntries([
      source('a', 's', ['x', 'y']),
      source('b', 's', ['z'], { loadError: 'gone' }),
    ]);
    expect(total).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Regression: the REAL repo registries must be clean.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function loadRealSources(): readonly RegistrySource[] {
  return REGISTRY_FILES.map((spec) => {
    const base = { id: spec.id, path: spec.path, scope: spec.scope, entries: [] } as const;
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(path.join(repoRoot, ...spec.path.split('/')), 'utf8'),
      );
      const result = extractEntries(parsed, spec);
      return result.error !== undefined
        ? { ...base, loadError: result.error }
        : { ...base, entries: result.entries };
    } catch (e) {
      return { ...base, loadError: (e as Error).message };
    }
  });
}

describe('real repository registries', () => {
  it('registers the achievements floor files under one shared scope', () => {
    const scopes = new Map(REGISTRY_FILES.map((s) => [s.id, s.scope]));
    expect(scopes.get('achievements.floor1')).toBe('achievements');
    expect(scopes.get('achievements.floor2')).toBe('achievements');
  });

  it('loads every registered registry file without a load error', () => {
    expect(loadRealSources().filter((s) => s.loadError !== undefined)).toEqual([]);
  });

  it('produces zero findings for the current repo data', () => {
    expect(checkRegistryIntegrity(loadRealSources())).toEqual([]);
  });

  it('checks a non-trivial number of entries (canary against a silent no-op)', () => {
    expect(countEntries(loadRealSources())).toBeGreaterThan(100);
  });
});
