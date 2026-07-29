import { describe, expect, it } from 'vitest';
import {
  REGISTRY,
  canonicalize,
  checkRowOwnership,
  extractBossAbilityRows,
  extractManifestRows,
  type RowMap,
} from '../../../scripts/agent/health/check-aggregate-row-ownership-lib.js';

// ---------------------------------------------------------------------------
// canonicalize
// ---------------------------------------------------------------------------

describe('canonicalize', () => {
  it('returns a stable JSON string for primitives', () => {
    expect(canonicalize(42)).toBe('42');
    expect(canonicalize('hello')).toBe('"hello"');
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(true)).toBe('true');
  });

  it('sorts object keys recursively', () => {
    const result = canonicalize({ z: 1, a: 2, m: 3 });
    expect(result).toBe('{"a":2,"m":3,"z":1}');
  });

  it('sorts nested object keys recursively', () => {
    const result = canonicalize({ b: { y: 10, x: 20 }, a: { q: 5, p: 3 } });
    expect(result).toBe('{"a":{"p":3,"q":5},"b":{"x":20,"y":10}}');
  });

  it('passes arrays through without reordering elements', () => {
    const result = canonicalize([3, 1, 2]);
    expect(result).toBe('[3,1,2]');
  });

  it('handles arrays of objects (sorts keys within each element)', () => {
    const result = canonicalize([
      { z: 1, a: 2 },
      { y: 3, b: 4 },
    ]);
    expect(result).toBe('[{"a":2,"z":1},{"b":4,"y":3}]');
  });

  it('produces identical output for objects with the same data in different key order', () => {
    const a = canonicalize({ x: 1, y: 2 });
    const b = canonicalize({ y: 2, x: 1 });
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// extractManifestRows
// ---------------------------------------------------------------------------

describe('extractManifestRows', () => {
  function makeManifest(entries: Record<string, unknown>): string {
    return JSON.stringify({ version: 1, entries });
  }

  it('extracts entries as rows keyed by entry key', () => {
    const content = makeManifest({
      'sprite-a-var-0': { spriteName: 'sprite-a-var-0', approvedAt: '2026-01-01T00:00:00Z' },
      'sprite-b-var-1': { spriteName: 'sprite-b-var-1', approvedAt: '2026-01-02T00:00:00Z' },
    });
    const rows = extractManifestRows(content);
    expect(rows.size).toBe(2);
    expect(rows.has('sprite-a-var-0')).toBe(true);
    expect(rows.has('sprite-b-var-1')).toBe(true);
  });

  it('handles an empty entries dict', () => {
    const rows = extractManifestRows(makeManifest({}));
    expect(rows.size).toBe(0);
  });

  it('canonicalizes each entry (sorted keys)', () => {
    const content = makeManifest({
      'sprite-x': { z: 1, a: 2 },
    });
    const rows = extractManifestRows(content);
    // Canonical form sorts keys: a before z
    expect(rows.get('sprite-x')).toBe('{"a":2,"z":1}');
  });
});

// ---------------------------------------------------------------------------
// extractBossAbilityRows
// ---------------------------------------------------------------------------

function makeBossAbilitiesJson(opts: {
  entries?: Array<Record<string, unknown>>;
  gates?: Array<Record<string, unknown>>;
}): string {
  return JSON.stringify({
    schemaVersion: 'v1',
    catalogSchemaVersion: 'boss-abilities/v1',
    lastAuditedAt: '2026-07-01',
    gates: opts.gates ?? [],
    entries: opts.entries ?? [],
  });
}

describe('extractBossAbilityRows', () => {
  it('extracts entries keyed as entry:<abilityId>', () => {
    const content = makeBossAbilitiesJson({
      entries: [
        { abilityId: 'boss-slam', designState: 'approved' },
        { abilityId: 'boss-leap', designState: 'not-started' },
      ],
    });
    const rows = extractBossAbilityRows(content);
    expect(rows.has('entry:boss-slam')).toBe(true);
    expect(rows.has('entry:boss-leap')).toBe(true);
  });

  it('extracts gates keyed as gate:<id>', () => {
    const content = makeBossAbilitiesJson({
      gates: [
        { id: 'gate-alpha', state: 'verified' },
        { id: 'gate-beta', state: 'blocked' },
      ],
    });
    const rows = extractBossAbilityRows(content);
    expect(rows.has('gate:gate-alpha')).toBe(true);
    expect(rows.has('gate:gate-beta')).toBe(true);
  });

  it('throws on a duplicate abilityId', () => {
    const content = makeBossAbilitiesJson({
      entries: [
        { abilityId: 'boss-slam', designState: 'approved' },
        { abilityId: 'boss-slam', designState: 'not-started' },
      ],
    });
    expect(() => extractBossAbilityRows(content)).toThrow(/duplicate abilityId/i);
  });

  it('throws on a duplicate gate id', () => {
    const content = makeBossAbilitiesJson({
      gates: [
        { id: 'gate-alpha', state: 'verified' },
        { id: 'gate-alpha', state: 'blocked' },
      ],
    });
    expect(() => extractBossAbilityRows(content)).toThrow(/duplicate gate id/i);
  });

  it('throws when an entry is missing abilityId', () => {
    const content = makeBossAbilitiesJson({
      entries: [{ designState: 'approved' }],
    });
    expect(() => extractBossAbilityRows(content)).toThrow(/missing a string abilityId/i);
  });
});

// ---------------------------------------------------------------------------
// checkRowOwnership
// ---------------------------------------------------------------------------

/** Helper to build a RowMap from a plain object. */
function rowsFrom(obj: Record<string, unknown>): RowMap {
  const m = new Map<string, string>();
  for (const [k, v] of Object.entries(obj)) {
    m.set(k, canonicalize(v));
  }
  return m;
}

describe('checkRowOwnership', () => {
  // --- Passing cases ---

  it('passes when all rows are unchanged (PR == mergeBase == main)', () => {
    const rows = rowsFrom({ 'sprite-a': { x: 1 }, 'sprite-b': { x: 2 } });
    const result = checkRowOwnership(rows, rows, rows);
    expect(result.findings).toHaveLength(0);
    expect(result.rowsChecked).toBe(2);
  });

  it('passes when PR legitimately updates a row (PR ≠ mergeBase ≠ main) without staleness', () => {
    const mergeBase = rowsFrom({ 'boss-slam': { state: 'not-started' } });
    const main = rowsFrom({ 'boss-slam': { state: 'not-started' } });
    const pr = rowsFrom({ 'boss-slam': { state: 'verified' } }); // PR updated it
    const result = checkRowOwnership(pr, mergeBase, main);
    expect(result.findings).toHaveLength(0);
  });

  it('passes for a newly added row (not in mergeBase)', () => {
    const mergeBase = rowsFrom({ 'sprite-a': { x: 1 } });
    const main = rowsFrom({ 'sprite-a': { x: 1 } });
    const pr = rowsFrom({ 'sprite-a': { x: 1 }, 'sprite-new': { x: 99 } });
    const result = checkRowOwnership(pr, mergeBase, main);
    expect(result.findings).toHaveLength(0);
    expect(result.rowsChecked).toBe(1); // only sprite-a is in main
  });

  it('passes when a row was deleted from main (both mergeBase and main had it)', () => {
    // Row was deleted in main — the PR is not responsible
    const mergeBase = rowsFrom({ 'sprite-a': { x: 1 }, 'sprite-gone': { x: 2 } });
    const main = rowsFrom({ 'sprite-a': { x: 1 } }); // sprite-gone removed in main
    const pr = rowsFrom({ 'sprite-a': { x: 1 } }); // PR doesn't have it either
    const result = checkRowOwnership(pr, mergeBase, main);
    expect(result.findings).toHaveLength(0);
    expect(result.rowsChecked).toBe(1);
  });

  it('passes when PR and main both updated the same row to the same value', () => {
    const mergeBase = rowsFrom({ 'boss-slam': { state: 'not-started' } });
    const main = rowsFrom({ 'boss-slam': { state: 'verified' } });
    const pr = rowsFrom({ 'boss-slam': { state: 'verified' } });
    const result = checkRowOwnership(pr, mergeBase, main);
    expect(result.findings).toHaveLength(0);
  });

  // --- Stale row ---

  it('detects a stale row: PR has merge-base value while main has advanced', () => {
    const mergeBase = rowsFrom({ 'don-paco': { state: 'not-started' } });
    const main = rowsFrom({ 'don-paco': { state: 'verified' } }); // PR #2016 advanced it
    const pr = rowsFrom({ 'don-paco': { state: 'not-started' } }); // stale copy from before #2016
    const result = checkRowOwnership(pr, mergeBase, main);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.kind).toBe('stale');
    expect(result.findings[0]!.rowKey).toBe('don-paco');
    expect(result.findings[0]!.detail).toMatch(/stale/i);
  });

  it('detects multiple stale rows in one pass', () => {
    const mergeBase = rowsFrom({
      'ability-a': { state: 'not-started' },
      'ability-b': { state: 'planned' },
      'ability-c': { state: 'done' }, // not stale
    });
    const main = rowsFrom({
      'ability-a': { state: 'verified' },
      'ability-b': { state: 'verified' },
      'ability-c': { state: 'done' },
    });
    const pr = rowsFrom({
      'ability-a': { state: 'not-started' }, // stale
      'ability-b': { state: 'planned' }, // stale
      'ability-c': { state: 'done' }, // fine
    });
    const result = checkRowOwnership(pr, mergeBase, main);
    const stale = result.findings.filter((f) => f.kind === 'stale');
    expect(stale).toHaveLength(2);
    expect(stale.map((f) => f.rowKey).sort()).toEqual(['ability-a', 'ability-b']);
  });

  // --- Deleted row ---

  it('detects a row deleted by the PR', () => {
    const mergeBase = rowsFrom({ 'sprite-a': { x: 1 }, 'sprite-b': { x: 2 } });
    const main = rowsFrom({ 'sprite-a': { x: 1 }, 'sprite-b': { x: 2 } });
    const pr = rowsFrom({ 'sprite-a': { x: 1 } }); // sprite-b deleted
    const result = checkRowOwnership(pr, mergeBase, main);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.kind).toBe('deleted-row');
    expect(result.findings[0]!.rowKey).toBe('sprite-b');
  });

  // --- Deleted field ---

  it('detects a field deleted from a row (opaqueBounds stripping case)', () => {
    const entryWithBounds = { spriteName: 'sprite-a', opaqueBounds: { x: 0, y: 0 } };
    const entryWithoutBounds = { spriteName: 'sprite-a' }; // field stripped

    const mergeBase = rowsFrom({ 'sprite-a': entryWithBounds });
    const main = rowsFrom({ 'sprite-a': entryWithBounds });
    const pr = rowsFrom({ 'sprite-a': entryWithoutBounds });

    const result = checkRowOwnership(pr, mergeBase, main);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.kind).toBe('deleted-field');
    expect(result.findings[0]!.rowKey).toBe('sprite-a');
    expect(result.findings[0]!.fieldPath).toBe('opaqueBounds');
  });

  it('does not report deleted-field when the field was already absent in main', () => {
    // Main already removed the field — PR not responsible
    const entryWith = { spriteName: 'sprite-a', legacyField: 'x' };
    const entryWithout = { spriteName: 'sprite-a' };

    const mergeBase = rowsFrom({ 'sprite-a': entryWith });
    const main = rowsFrom({ 'sprite-a': entryWithout }); // already removed in main
    const pr = rowsFrom({ 'sprite-a': entryWithout }); // matches main

    const result = checkRowOwnership(pr, mergeBase, main);
    expect(result.findings).toHaveLength(0);
  });

  it('does not report deleted-field when the row is already stale (avoids double-reporting)', () => {
    // If the row is stale (Rule 2 fires), Rule 3 should not also fire for missing fields.
    const mergeBase = rowsFrom({
      'sprite-a': { spriteName: 'sprite-a', opaqueBounds: { x: 0 } },
    });
    const main = rowsFrom({
      'sprite-a': { spriteName: 'sprite-a', opaqueBounds: { x: 5 }, extraField: true },
    });
    // PR has same value as mergeBase (stale) — stale check should fire, not deleted-field
    const pr = rowsFrom({
      'sprite-a': { spriteName: 'sprite-a', opaqueBounds: { x: 0 } },
    });

    const result = checkRowOwnership(pr, mergeBase, main);
    const kinds = result.findings.map((f) => f.kind);
    expect(kinds).toContain('stale');
    expect(kinds).not.toContain('deleted-field');
  });

  // --- rowsChecked counter ---

  it('counts rows present in main (excludes rows deleted from main)', () => {
    const mergeBase = rowsFrom({ a: { v: 1 }, b: { v: 2 }, c: { v: 3 } });
    const main = rowsFrom({ a: { v: 1 }, b: { v: 2 } }); // c was deleted in main
    const pr = rowsFrom({ a: { v: 1 }, b: { v: 2 } });
    const result = checkRowOwnership(pr, mergeBase, main);
    expect(result.rowsChecked).toBe(2); // c not in main so not checked
  });

  // --- Three-way regression: row added to main after branch forked ---

  it('detects a row added to main after branch fork that is absent from a stale PR rewrite', () => {
    // Scenario: base={a}, main={a,b} (b added concurrently), PR stale rewrite={a}
    const mergeBase = rowsFrom({ 'sprite-a': { x: 1 } });
    const main = rowsFrom({ 'sprite-a': { x: 1 }, 'sprite-b': { x: 2 } }); // b added after fork
    const pr = rowsFrom({ 'sprite-a': { x: 1 } }); // stale wholesale regeneration omits b
    const result = checkRowOwnership(pr, mergeBase, main);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.kind).toBe('deleted-row');
    expect(result.findings[0]!.rowKey).toBe('sprite-b');
    expect(result.findings[0]!.detail).toMatch(/after this branch forked/i);
    expect(result.rowsChecked).toBe(2); // both a and b are in main
  });

  it('passes when a row added to main after branch fork is also present in the PR', () => {
    // PR also contains the concurrently added row — no violation
    const mergeBase = rowsFrom({ 'sprite-a': { x: 1 } });
    const main = rowsFrom({ 'sprite-a': { x: 1 }, 'sprite-b': { x: 2 } });
    const pr = rowsFrom({ 'sprite-a': { x: 1 }, 'sprite-b': { x: 2 } }); // PR has it too
    const result = checkRowOwnership(pr, mergeBase, main);
    expect(result.findings).toHaveLength(0);
    expect(result.rowsChecked).toBe(2);
  });

  it('rowsChecked is 0 when main has no rows (per-file canary baseline)', () => {
    // If origin/main is empty or not fetched, rowsChecked is 0 even if mergeBase has rows.
    // The CLI-level per-file canary fires on this to flag a configuration failure.
    const mergeBase = rowsFrom({ 'sprite-a': { x: 1 } });
    const main = rowsFrom({}); // main has no rows (e.g. wrong git ref)
    const pr = rowsFrom({ 'sprite-a': { x: 1 } });
    const result = checkRowOwnership(pr, mergeBase, main);
    expect(result.rowsChecked).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  // --- Field-level stale: PR updates one field but leaves another at the stale value ---

  it('detects field-level staleness: PR updates one field but leaves another at stale merge-base value', () => {
    // base={state:'old',note:'x'}, main={state:'new',note:'x'}, PR={state:'old',note:'y'}
    // PR changed note but left state at the stale value — whole-row stale check passes (rows differ)
    // but field-level check must catch state.
    const mergeBase = rowsFrom({ 'boss-slam': { state: 'old', note: 'x' } });
    const main = rowsFrom({ 'boss-slam': { state: 'new', note: 'x' } });
    const pr = rowsFrom({ 'boss-slam': { state: 'old', note: 'y' } });
    const result = checkRowOwnership(pr, mergeBase, main);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.kind).toBe('stale');
    expect(result.findings[0]!.fieldPath).toBe('state');
    expect(result.findings[0]!.rowKey).toBe('boss-slam');
    expect(result.findings[0]!.detail).toMatch(/field '?state'?.*stale/i);
  });

  it('passes when PR updates all stale fields along with other changes', () => {
    const mergeBase = rowsFrom({ 'boss-slam': { state: 'old', note: 'x' } });
    const main = rowsFrom({ 'boss-slam': { state: 'new', note: 'x' } });
    const pr = rowsFrom({ 'boss-slam': { state: 'new', note: 'y' } }); // state updated, note changed
    const result = checkRowOwnership(pr, mergeBase, main);
    expect(result.findings).toHaveLength(0);
  });

  it('detects a field added to main after branch fork that is absent from PR row (PR changed other fields)', () => {
    // Main added newField after branch fork. PR updates another field (x) but doesn't include newField.
    // Because PR changed the row (x: 1→2), Rule 2 doesn't fire — Rule 3 must catch newField.
    const mergeBase = rowsFrom({ 'sprite-a': { x: 1 } });
    const main = rowsFrom({ 'sprite-a': { x: 1, newField: 'added' } }); // newField added to main
    const pr = rowsFrom({ 'sprite-a': { x: 2 } }); // PR changed x but omits newField
    const result = checkRowOwnership(pr, mergeBase, main);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.kind).toBe('deleted-field');
    expect(result.findings[0]!.fieldPath).toBe('newField');
    expect(result.findings[0]!.rowKey).toBe('sprite-a');
    expect(result.findings[0]!.detail).toMatch(/after this branch forked/i);
  });
});

// ---------------------------------------------------------------------------
// REGISTRY — smoke test that the actual data files are parseable
// ---------------------------------------------------------------------------

describe('REGISTRY', () => {
  it('has exactly 2 entries', () => {
    expect(REGISTRY).toHaveLength(2);
  });

  it('manifest.json path is correct', () => {
    expect(REGISTRY[0]?.path).toBe('public/assets/generated/manifest.json');
  });

  it('boss-abilities path is correct', () => {
    expect(REGISTRY[1]?.path).toBe('scripts/agent/data/boss-abilities.floor2.status.json');
  });
});
