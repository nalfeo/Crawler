import { describe, expect, it } from 'vitest';

import { buildCorpus } from '../../../.github/extensions/asset-search/lib/index-builder.mjs';

describe('asset-search index builder brief enrichment', () => {
  it('prefers matching iconBatch item description over top-level batch description', () => {
    const doc = buildCorpus().find((entry) => entry.label === 'ability-icon-magic-missile');
    expect(doc).toBeDefined();
    expect(doc?.briefId).toBe('ability-icons-batch-01');
    expect(doc?.briefText).toContain('Launch a precise arcane bolt');
    expect(doc?.briefText).not.toContain('Ability icon batch 01a');
  });

  it('falls back to top-level brief description when no item-level entry exists', () => {
    const doc = buildCorpus().find((entry) => entry.label === 'cactusfolk-boss-var-1');
    expect(doc).toBeDefined();
    expect(doc?.briefId).toBe('cactusfolk-boss');
    expect(doc?.briefText).toContain('Abuela Saguaro, a towering saguaro cartel matriarch');
  });
});
