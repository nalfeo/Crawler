import { describe, expect, it } from 'vitest';
import type { ManifestEntry } from '../../../src/shared/generated-assets.js';
import type { SpriteType } from '../../../src/shared/sprite-types.js';
import {
  REFERENCE_COUNT,
  SELECTOR_VERSION,
  referenceSelectorSeed,
  selectReferences,
} from '../../../scripts/sprites/reference-selector.js';

/**
 * Build a valid, ELIGIBLE {@link ManifestEntry} (real, high-quality, typed).
 * Override fields to make it a placeholder / low-quality / off-path / self.
 */
function entry(
  over: Partial<ManifestEntry> & Pick<ManifestEntry, 'briefId'> & { type: SpriteType },
): ManifestEntry {
  const spriteName = over.spriteName ?? `${over.briefId}-var-0`;
  return {
    spriteName,
    assetPath: `generated/${spriteName}.png`,
    approvedAt: '2026-01-01T00:00:00.000Z',
    sourceRun: 'run-001',
    variantIndex: 0,
    anchor: null,
    sensorScore: '9/10',
    judgeScore: '4',
    ...over,
  };
}

/** N same-type eligible items with distinct concepts. */
function pool(type: SpriteType, prefix: string, n: number): ManifestEntry[] {
  return Array.from({ length: n }, (_, i) => entry({ briefId: `${prefix}-${i}-v1`, type }));
}

const SEED = referenceSelectorSeed('subject-lamp-v1');

function names(selected: readonly ManifestEntry[]): string[] {
  return selected.map((e) => e.spriteName);
}

describe('referenceSelectorSeed', () => {
  it('is stable for a brief name and namespaced by version', () => {
    expect(referenceSelectorSeed('lamp-v1')).toBe(referenceSelectorSeed('lamp-v1'));
    expect(SELECTOR_VERSION).toBe('v1');
  });

  it('differs across brief names', () => {
    expect(referenceSelectorSeed('lamp-v1')).not.toBe(referenceSelectorSeed('lamp-v2'));
  });
});

describe('selectReferences — determinism', () => {
  it('returns the same set for identical inputs + seed', () => {
    const candidates = pool('item', 'item', 8);
    const a = selectReferences({
      candidates,
      briefName: 'subject-lamp-v1',
      briefType: 'item',
      count: 3,
      seed: SEED,
    });
    const b = selectReferences({
      candidates,
      briefName: 'subject-lamp-v1',
      briefType: 'item',
      count: 3,
      seed: SEED,
    });
    expect(names(a.selected)).toEqual(names(b.selected));
    expect(a.selected).toHaveLength(3);
  });

  it('is insensitive to candidate input order (stable pre-sort)', () => {
    const candidates = pool('item', 'item', 8);
    const shuffled = [...candidates].reverse();
    const a = selectReferences({
      candidates,
      briefName: 'subject-lamp-v1',
      briefType: 'item',
      count: 3,
      seed: SEED,
    });
    const b = selectReferences({
      candidates: shuffled,
      briefName: 'subject-lamp-v1',
      briefType: 'item',
      count: 3,
      seed: SEED,
    });
    expect(names(a.selected)).toEqual(names(b.selected));
  });

  it('produces different sets for different brief names (statistical)', () => {
    const candidates = pool('item', 'item', 12);
    const first = names(
      selectReferences({
        candidates,
        briefName: 'brief-a',
        briefType: 'item',
        count: 3,
        seed: referenceSelectorSeed('brief-a'),
      }).selected,
    ).join(',');
    let anyDifferent = false;
    for (const other of ['brief-b', 'brief-c', 'brief-d', 'brief-e']) {
      const set = names(
        selectReferences({
          candidates,
          briefName: other,
          briefType: 'item',
          count: 3,
          seed: referenceSelectorSeed(other),
        }).selected,
      ).join(',');
      if (set !== first) anyDifferent = true;
    }
    expect(anyDifferent).toBe(true);
  });
});

describe('selectReferences — same-type favouring + broadening', () => {
  it('selects ONLY same-type when the same-type pool is large enough', () => {
    const candidates = [...pool('item', 'item', 6), ...pool('weapon', 'weapon', 6)];
    const result = selectReferences({
      candidates,
      briefName: 'subject-lamp-v1',
      briefType: 'item',
      count: 3,
      seed: SEED,
    });
    expect(result.selected).toHaveLength(3);
    expect(result.selected.every((e) => e.type === 'item')).toBe(true);
    expect(result.sameTypeCount).toBe(6);
  });

  it('includes ALL same-type then fills from other types when same-type is thin', () => {
    const candidates = [...pool('item', 'item', 1), ...pool('weapon', 'weapon', 6)];
    const result = selectReferences({
      candidates,
      briefName: 'subject-lamp-v1',
      briefType: 'item',
      count: 3,
      seed: SEED,
    });
    expect(result.selected).toHaveLength(3);
    const itemCount = result.selected.filter((e) => e.type === 'item').length;
    expect(itemCount).toBe(1); // the sole same-type example is always included
    expect(result.selected.filter((e) => e.type === 'weapon')).toHaveLength(2);
  });

  it('returns all eligible when fewer than count exist (cold start)', () => {
    const candidates = pool('item', 'item', 2);
    const result = selectReferences({
      candidates,
      briefName: 'subject-lamp-v1',
      briefType: 'item',
      count: 3,
      seed: SEED,
    });
    expect(result.selected).toHaveLength(2);
    expect(result.eligibleCount).toBe(2);
  });

  it('returns an empty selection when nothing is eligible (never Kenney)', () => {
    const result = selectReferences({
      candidates: [],
      briefName: 'subject-lamp-v1',
      briefType: 'item',
      count: 3,
      seed: SEED,
    });
    expect(result.selected).toEqual([]);
    expect(result.eligibleCount).toBe(0);
  });
});

describe('selectReferences — eligibility filtering', () => {
  it('excludes asset-level disliked sprites', () => {
    const disliked = entry({ briefId: 'bad-reference', type: 'item' });
    const good = entry({ briefId: 'good-reference', type: 'item' });
    const result = selectReferences({
      candidates: [disliked, good],
      briefName: 'subject-v1',
      briefType: 'item',
      count: 3,
      seed: SEED,
      dislikedSpriteNames: new Set([disliked.spriteName]),
    });
    expect(names(result.selected)).toEqual([good.spriteName]);
  });

  it('excludes placeholders (all three placeholder signals)', () => {
    const candidates: ManifestEntry[] = [
      entry({ briefId: 'good-v1', type: 'item' }),
      entry({
        briefId: 'ph-run',
        type: 'item',
        spriteName: 'ph-run-var-0',
        sourceRun: 'placeholder',
      }),
      entry({
        briefId: 'ph-sensor',
        type: 'item',
        spriteName: 'ph-sensor-var-0',
        sensorScore: 'placeholder',
      }),
      entry({
        briefId: 'ph-path',
        type: 'item',
        spriteName: 'aether-dust',
        assetPath: 'generated/aether-dust-placeholder.png',
      }),
    ];
    const result = selectReferences({
      candidates,
      briefName: 'subject-v1',
      briefType: 'item',
      count: 3,
      seed: SEED,
    });
    expect(names(result.selected)).toEqual(['good-v1-var-0']);
  });

  it('excludes the brief itself by EXACT briefId but allows other variants of the concept', () => {
    const candidates: ManifestEntry[] = [
      entry({ briefId: 'lamp-v2', type: 'item', spriteName: 'lamp-v2-var-0' }),
      entry({ briefId: 'lamp-v1', type: 'item', spriteName: 'lamp-v1-var-0' }),
    ];
    const result = selectReferences({
      candidates,
      briefName: 'lamp-v2', // generating v2 …
      briefType: 'item',
      count: 3,
      seed: SEED,
    });
    // … excludes v2's own approved variant but CAN reference v1.
    expect(names(result.selected)).toEqual(['lamp-v1-var-0']);
  });

  it('excludes entries whose assetPath is not under generated/', () => {
    const candidates: ManifestEntry[] = [
      entry({ briefId: 'good-v1', type: 'item' }),
      entry({
        briefId: 'kenney-ref',
        type: 'item',
        spriteName: 'kenney-ref',
        assetPath: 'kenney/roguelike/lamp.png',
      }),
    ];
    const result = selectReferences({
      candidates,
      briefName: 'subject-v1',
      briefType: 'item',
      count: 3,
      seed: SEED,
    });
    expect(names(result.selected)).toEqual(['good-v1-var-0']);
  });

  it('excludes traversal / escaping assetPaths (generated/ prefix is not enough)', () => {
    const candidates: ManifestEntry[] = [
      entry({ briefId: 'good-v1', type: 'item' }),
      // All start with "generated/" but escape the tree or aren't PNGs — a
      // smuggled Kenney/other-file reference must never survive eligibility.
      entry({
        briefId: 'escape-1',
        type: 'item',
        spriteName: 'escape-1',
        assetPath: 'generated/../kenney/roguelike/spritesheet.png',
      }),
      entry({
        briefId: 'escape-2',
        type: 'item',
        spriteName: 'escape-2',
        assetPath: 'generated/../../etc/passwd.png',
      }),
      entry({
        briefId: 'winsep',
        type: 'item',
        spriteName: 'winsep',
        assetPath: 'generated\\..\\kenney\\x.png',
      }),
      entry({
        briefId: 'notpng',
        type: 'item',
        spriteName: 'notpng',
        assetPath: 'generated/lamp.json',
      }),
    ];
    const result = selectReferences({
      candidates,
      briefName: 'subject-v1',
      briefType: 'item',
      count: 5,
      seed: SEED,
    });
    expect(names(result.selected)).toEqual(['good-v1-var-0']);
    expect(result.eligibleCount).toBe(1);
  });

  it('excludes untyped entries', () => {
    const candidates: ManifestEntry[] = [
      entry({ briefId: 'good-v1', type: 'item' }),
      { ...entry({ briefId: 'untyped-v1', type: 'item' }), type: null },
    ];
    const result = selectReferences({
      candidates,
      briefName: 'subject-v1',
      briefType: 'item',
      count: 3,
      seed: SEED,
    });
    expect(names(result.selected)).toEqual(['good-v1-var-0']);
  });

  it('enforces the quality floor: judge < 3 and sensor < 0.75 are excluded, null judge is kept', () => {
    const candidates: ManifestEntry[] = [
      entry({ briefId: 'lowjudge-v1', type: 'item', judgeScore: '2' }),
      entry({ briefId: 'lowsensor-v1', type: 'item', sensorScore: '7/10' }),
      entry({ briefId: 'nulljudge-v1', type: 'item', judgeScore: null }),
      entry({ briefId: 'floorsensor-v1', type: 'item', sensorScore: '3/4' }), // exactly 0.75
      entry({ briefId: 'badsensor-v1', type: 'item', sensorScore: 'unknown' }),
    ];
    const result = selectReferences({
      candidates,
      briefName: 'subject-v1',
      briefType: 'item',
      count: 5,
      seed: SEED,
    });
    expect(new Set(names(result.selected))).toEqual(
      new Set(['nulljudge-v1-var-0', 'floorsensor-v1-var-0']),
    );
  });

  it('fails closed on a present-but-malformed judgeScore (only null is treated as unscored)', () => {
    const candidates: ManifestEntry[] = [
      entry({ briefId: 'good-v1', type: 'item', judgeScore: '4' }),
      entry({ briefId: 'unscored-v1', type: 'item', judgeScore: null }), // legit unscored → kept
      entry({ briefId: 'junk-v1', type: 'item', judgeScore: 'unknown' }), // malformed → excluded
      entry({ briefId: 'zero-v1', type: 'item', judgeScore: '0' }), // out of 1–5 → excluded
      // Leading-digit garbage that `Number.parseInt` would have silently accepted
      // (as 3, 3, and 5 respectively) — must all fail closed under strict parsing.
      entry({ briefId: 'trailing-v1', type: 'item', judgeScore: '3abc' }),
      entry({ briefId: 'float-v1', type: 'item', judgeScore: '3.5' }),
      entry({ briefId: 'ratio-v1', type: 'item', judgeScore: '5/5' }),
    ];
    const result = selectReferences({
      candidates,
      briefName: 'subject-v1',
      briefType: 'item',
      count: 5,
      seed: SEED,
    });
    expect(new Set(names(result.selected))).toEqual(
      new Set(['good-v1-var-0', 'unscored-v1-var-0']),
    );
  });
});

describe('selectReferences — concept collapse + quality weighting', () => {
  it('collapses multiple variants of one concept to a single best entry', () => {
    const candidates: ManifestEntry[] = [
      entry({ briefId: 'torch-v1', type: 'item', spriteName: 'torch-v1-var-0', judgeScore: '3' }),
      entry({ briefId: 'torch-v1', type: 'item', spriteName: 'torch-v1-var-1', judgeScore: '5' }),
      entry({ briefId: 'torch-v1', type: 'item', spriteName: 'torch-v1-var-2', judgeScore: '4' }),
    ];
    const result = selectReferences({
      candidates,
      briefName: 'subject-v1',
      briefType: 'item',
      count: 3,
      seed: SEED,
    });
    // One concept → exactly one reference, and it's the best-scoring variant.
    expect(names(result.selected)).toEqual(['torch-v1-var-1']);
    expect(result.eligibleCount).toBe(1);
  });

  it('yields distinct concepts across a 3-ref set', () => {
    const candidates: ManifestEntry[] = [
      ...[0, 1, 2].map((i) =>
        entry({ briefId: 'torch-v1', type: 'item', spriteName: `torch-v1-var-${i}` }),
      ),
      ...[0, 1, 2].map((i) =>
        entry({ briefId: 'lantern-v1', type: 'item', spriteName: `lantern-v1-var-${i}` }),
      ),
      ...[0, 1, 2].map((i) =>
        entry({ briefId: 'candle-v1', type: 'item', spriteName: `candle-v1-var-${i}` }),
      ),
    ];
    const result = selectReferences({
      candidates,
      briefName: 'subject-v1',
      briefType: 'item',
      count: 3,
      seed: SEED,
    });
    const concepts = new Set(result.selected.map((e) => e.briefId));
    expect(concepts.size).toBe(3);
  });

  it('favours higher-quality concepts over many seeds (statistical)', () => {
    const candidates: ManifestEntry[] = [
      entry({ briefId: 'high-v1', type: 'item', sensorScore: '10/10', judgeScore: '5' }),
      entry({ briefId: 'low-v1', type: 'item', sensorScore: '3/4', judgeScore: '3' }),
      entry({ briefId: 'mid-v1', type: 'item', sensorScore: '8/10', judgeScore: '4' }),
    ];
    let highWins = 0;
    let lowWins = 0;
    const trials = 400;
    for (let i = 0; i < trials; i += 1) {
      const first = selectReferences({
        candidates,
        briefName: `brief-${i}`,
        briefType: 'item',
        count: 1,
        seed: referenceSelectorSeed(`brief-${i}`),
      }).selected[0];
      if (first?.briefId === 'high-v1') highWins += 1;
      if (first?.briefId === 'low-v1') lowWins += 1;
    }
    expect(highWins).toBeGreaterThan(lowWins);
  });
});

describe('selectReferences — metadata + defaults', () => {
  it('reports requestedCount, eligibleCount, and sameTypeCount', () => {
    const candidates = [...pool('item', 'item', 4), ...pool('weapon', 'weapon', 2)];
    const result = selectReferences({
      candidates,
      briefName: 'subject-v1',
      briefType: 'item',
      count: REFERENCE_COUNT,
      seed: SEED,
    });
    expect(result.requestedCount).toBe(3);
    expect(result.eligibleCount).toBe(6);
    expect(result.sameTypeCount).toBe(4);
    expect(result.seed).toBe(SEED);
  });

  it('returns an empty selection for a non-positive count', () => {
    const result = selectReferences({
      candidates: pool('item', 'item', 4),
      briefName: 'subject-v1',
      briefType: 'item',
      count: 0,
      seed: SEED,
    });
    expect(result.selected).toEqual([]);
  });
});
