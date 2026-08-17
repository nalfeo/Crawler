import { describe, expect, it } from 'vitest';

import {
  bareConcept,
  buildTaxonomyPlan,
  DESIGN_NAME_REMAP,
  hasLineageTag,
  hasResidualLineageTag,
  isPlaceholder,
  splitVariantKey,
  type TaxonomyEntry,
} from '../../../scripts/sprites/sprite-name-taxonomy.js';

/** Terse entry builder — only the fields the taxonomy actually reads. */
function entry(briefId: string, extra: Partial<TaxonomyEntry> = {}): TaxonomyEntry {
  return { briefId, ...extra };
}

describe('bareConcept', () => {
  it('strips a single trailing lineage tag', () => {
    expect(bareConcept('rat-v1')).toBe('rat');
    expect(bareConcept('slime-v12')).toBe('slime');
    expect(bareConcept('tile-stone-floor-v2')).toBe('tile-stone-floor');
  });

  it('leaves an already-bare concept untouched', () => {
    expect(bareConcept('rat')).toBe('rat');
    expect(bareConcept('welcome-room-bookcase')).toBe('welcome-room-bookcase');
  });

  it('strips only ONE tag so a double tag never silently loses two segments', () => {
    // `iron-ore-v1-v2` is malformed data, not a v2 of `iron-ore`; collapsing it
    // all the way would invent a merge that was never approved.
    expect(bareConcept('iron-ore-v1-v2')).toBe('iron-ore-v1');
  });

  it('applies the design-name remap so a design "v2" is not read as lineage', () => {
    // `angry-roomba-v2` is the Roomba mark 2 — a distinct enemy, not a
    // regenerated `angry-roomba`. See approve.test.ts "leaves a genuine
    // non-item versioned brief VERSIONED".
    expect(bareConcept('angry-roomba-v2-v1')).toBe('angry-roomba-mk2');
    expect(bareConcept('angry-roomba-v2')).toBe('angry-roomba-mk2');
    expect(bareConcept('angry-roomba-v1')).toBe('angry-roomba');
  });

  it('keeps the remapped design name distinct from the base concept', () => {
    expect(bareConcept('angry-roomba-v2-v1')).not.toBe(bareConcept('angry-roomba-v1'));
  });
});

describe('hasLineageTag', () => {
  it('reports a tagged brief as non-canonical', () => {
    expect(hasLineageTag('rat-v1')).toBe(true);
    expect(hasLineageTag('angry-roomba-v2')).toBe(true);
  });

  describe('hasResidualLineageTag', () => {
    it('detects a malformed double tag that a single strip would leave behind', () => {
      expect(hasResidualLineageTag('iron-ore-v1-v2')).toBe(true);
      expect(hasResidualLineageTag('rat-v1')).toBe(false);
      expect(hasResidualLineageTag('angry-roomba-v2-v1')).toBe(false);
    });
  });

  it('reports canonical names — including remap targets — as clean', () => {
    expect(hasLineageTag('rat')).toBe(false);
    // The remap target must never re-trigger the guard, otherwise the rule
    // could not be absolute and would need a permanent allowlist.
    expect(hasLineageTag('angry-roomba-mk2')).toBe(false);
  });

  it('agrees with DESIGN_NAME_REMAP for every declared remap target', () => {
    for (const target of Object.values(DESIGN_NAME_REMAP)) {
      expect(hasLineageTag(target)).toBe(false);
    }
  });
});

describe('splitVariantKey', () => {
  it('splits a variant key into brief and index', () => {
    expect(splitVariantKey('rat-v1-var-9')).toEqual({ brief: 'rat-v1', variantIndex: 9 });
  });

  it('returns null for a key with no variant suffix', () => {
    expect(splitVariantKey('rat-placeholder')).toBeNull();
    expect(splitVariantKey('equipment/weapon/bone-saw')).toBeNull();
  });
});

describe('isPlaceholder', () => {
  it('detects both placeholder markers', () => {
    expect(isPlaceholder(entry('rat', { sourceRun: 'placeholder' }))).toBe(true);
    expect(isPlaceholder(entry('rat', { assetPath: 'generated/rat-placeholder.png' }))).toBe(true);
  });

  it('does not treat real art as a placeholder', () => {
    expect(
      isPlaceholder(entry('rat', { sourceRun: 'run-1', assetPath: 'generated/rat-var-0.png' })),
    ).toBe(false);
  });
});

describe('buildTaxonomyPlan', () => {
  it('de-versions a simple single-lineage concept', () => {
    const plan = buildTaxonomyPlan({
      'rat-v1-var-0': entry('rat-v1', { variantIndex: 0 }),
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.renames).toHaveLength(1);
    expect(plan.renames[0]).toMatchObject({
      fromKey: 'rat-v1-var-0',
      toKey: 'rat-var-0',
      toBriefId: 'rat',
      renumbered: false,
    });
  });

  it('rejects malformed double lineage tags instead of partially renaming them', () => {
    const plan = buildTaxonomyPlan({
      'iron-ore-v1-v2-var-0': entry('iron-ore-v1-v2', { variantIndex: 0 }),
    });
    expect(plan.renames).toEqual([]);
    expect(plan.conflicts).toEqual([
      expect.objectContaining({
        reason: 'brief id contains more than one trailing lineage tag',
        keys: ['iron-ore-v1-v2-var-0'],
      }),
    ]);
  });

  it('is a no-op on an already-canonical tree (idempotency)', () => {
    const canonical = {
      'rat-var-0': entry('rat', { variantIndex: 0 }),
      'slime-var-1': entry('slime', { variantIndex: 1 }),
    };
    expect(buildTaxonomyPlan(canonical).renames).toEqual([]);
  });

  it('merges a fragmented concept into one bucket', () => {
    const plan = buildTaxonomyPlan({
      'rat-var-9': entry('rat', { variantIndex: 9, approvedAt: '2026-01-01T00:00:00Z' }),
      'rat-v1-var-3': entry('rat-v1', { variantIndex: 3, approvedAt: '2026-02-01T00:00:00Z' }),
    });
    expect(plan.mergedConcepts).toContain('rat');
    expect(plan.conflicts).toEqual([]);
    for (const rename of plan.renames) {
      expect(rename.toBriefId).toBe('rat');
    }
  });

  it('preserves non-colliding indices instead of reshuffling the whole concept', () => {
    const plan = buildTaxonomyPlan({
      'rat-var-9': entry('rat', { variantIndex: 9, approvedAt: '2026-01-01T00:00:00Z' }),
      'rat-v1-var-3': entry('rat-v1', { variantIndex: 3, approvedAt: '2026-02-01T00:00:00Z' }),
    });
    const byFrom = new Map(plan.renames.map((r) => [r.fromKey, r]));
    expect(byFrom.get('rat-v1-var-3')?.toVariantIndex).toBe(3);
    expect(byFrom.get('rat-v1-var-3')?.renumbered).toBe(false);
  });

  it('renumbers a colliding index, keeping BOTH approved variants', () => {
    // Real case: `rat` and `rat-v1` both ship a var-9. Dropping either would
    // silently delete approved art, so one must be renumbered.
    const plan = buildTaxonomyPlan({
      'rat-var-9': entry('rat', { variantIndex: 9, approvedAt: '2026-01-01T00:00:00Z' }),
      'rat-v1-var-9': entry('rat-v1', { variantIndex: 9, approvedAt: '2026-02-01T00:00:00Z' }),
    });
    expect(plan.conflicts).toEqual([]);
    const targets = plan.renames.map((r) => r.toKey);
    // Both survive, on distinct keys.
    expect(new Set([...targets, 'rat-var-9']).size).toBe(2);
    expect(plan.renames.some((r) => r.renumbered)).toBe(true);
  });

  it('renumbers oldest-approval-first so the result is stable', () => {
    const older = entry('rat', { variantIndex: 0, approvedAt: '2026-01-01T00:00:00Z' });
    const newer = entry('rat-v1', { variantIndex: 0, approvedAt: '2026-09-09T00:00:00Z' });
    const plan = buildTaxonomyPlan({ 'rat-var-0': older, 'rat-v1-var-0': newer });
    // The older entry keeps var-0; the newer one is the one that moves.
    const moved = plan.renames.find((r) => r.renumbered);
    expect(moved?.fromKey).toBe('rat-v1-var-0');
  });

  it('produces an identical plan regardless of input key order', () => {
    const a = {
      'slime-v1-var-3': entry('slime-v1', { variantIndex: 3, approvedAt: '2026-02-01T00:00:00Z' }),
      'slime-var-3': entry('slime', { variantIndex: 3, approvedAt: '2026-01-01T00:00:00Z' }),
    };
    const b = {
      'slime-var-3': a['slime-var-3'],
      'slime-v1-var-3': a['slime-v1-var-3'],
    };
    expect(buildTaxonomyPlan(a).renames).toEqual(buildTaxonomyPlan(b).renames);
  });

  it('never plans two entries onto the same destination key', () => {
    const plan = buildTaxonomyPlan({
      'rat-var-0': entry('rat', { variantIndex: 0, approvedAt: '2026-01-01T00:00:00Z' }),
      'rat-v1-var-0': entry('rat-v1', { variantIndex: 0, approvedAt: '2026-02-01T00:00:00Z' }),
      'rat-v2-var-0': entry('rat-v2', { variantIndex: 0, approvedAt: '2026-03-01T00:00:00Z' }),
    });
    const targets = plan.renames.map((r) => r.toKey);
    expect(new Set(targets).size).toBe(targets.length);
    // ...and none collides with an entry that is staying put.
    expect(targets).not.toContain('rat-var-0');
  });

  it('does not let a placeholder block a merge', () => {
    const plan = buildTaxonomyPlan({
      'azure-mushroom-placeholder': entry('azure-mushroom', { sourceRun: 'placeholder' }),
      'azure-mushroom-v1-var-0': entry('azure-mushroom-v1', { variantIndex: 0 }),
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.renames.some((r) => r.toKey === 'azure-mushroom-var-0')).toBe(true);
  });

  it('flags a fragmented concept whose extra key is a packed strip, not a variant', () => {
    const plan = buildTaxonomyPlan({
      'player-walk-cycle': entry('player-walk-cycle', { sourceRun: 'run-1' }),
      'player-walk-cycle-v1-var-0': entry('player-walk-cycle-v1', { variantIndex: 0 }),
    });
    // Renaming a packed frame-strip would need the strip repacked too, so the
    // migration must surface it rather than guess.
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]?.keys).toContain('player-walk-cycle');
  });

  it('excludes conflicted entries from the applied renames', () => {
    const plan = buildTaxonomyPlan({
      'player-walk-cycle': entry('player-walk-cycle', { sourceRun: 'run-1' }),
      'player-walk-cycle-v1-var-0': entry('player-walk-cycle-v1', { variantIndex: 0 }),
    });
    expect(plan.renames.map((r) => r.fromKey)).not.toContain('player-walk-cycle');
  });

  it('leaves an entry whose briefId is already bare but key is tagged consistent', () => {
    const plan = buildTaxonomyPlan({ 'rat-var-0': entry('rat', { variantIndex: 0 }) });
    expect(plan.renames).toEqual([]);
  });
});
