/**
 * Tests for the pure variation-expansion orchestrator.
 *
 * We construct briefs through the real schema (so defaults match prod)
 * and inject a `TextProvider` stub so every behaviour — sufficient
 * seed, opt-out, no-provider, dedupe, graceful failure — is exercised
 * without touching the network.
 */
import { describe, expect, it, vi } from 'vitest';

import { briefSchema, type Brief } from '../../../scripts/sprites/brief-schema.js';
import { expandVariations } from '../../../scripts/sprites/expand-variations.js';
import type {
  ExpandVariationsRequest,
  TextProvider,
} from '../../../scripts/sprites/provider/text-types.js';
import { TextProviderError } from '../../../scripts/sprites/provider/text-types.js';

function makeBrief(overrides: Partial<Brief> = {}): Brief {
  return briefSchema.parse({
    type: 'weapon',
    name: 'skull-mace',
    size: { width: 16, height: 16 },
    palette: { id: 'kenney-roguelike' },
    anchor: { x: 8, y: 14 },
    tags: ['blade'],
    prompt: 'A vertical skull mace.',
    references: [
      { path: 'docs/refs/a.png', note: 'silhouette' },
      { path: 'docs/refs/b.png', note: 'palette anchor' },
    ],
    generation: { sheet: { rows: 4, cols: 4, emptyCells: [], nativeCanvas: 1024 } },
    sensors: {},
    variations: [],
    minVariations: 4,
    ...overrides,
  });
}

function stub(impl: (req: ExpandVariationsRequest) => Promise<ReadonlyArray<string>>): TextProvider {
  return { expandVariations: vi.fn(impl) };
}

describe('expandVariations', () => {
  it('opts out when minVariations is 0 (provider is never called)', async () => {
    const provider = stub(async () => {
      throw new Error('should not be called');
    });
    const brief = makeBrief({ minVariations: 0, variations: ['seed one'] });
    const warn = vi.fn();

    const result = await expandVariations({ brief, provider, warn });

    expect(result.variations).toEqual(['seed one']);
    expect(result.proposed).toEqual([]);
    expect(result.skippedReason).toBe('disabled');
    expect(provider.expandVariations).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns seed unchanged when it already meets the minimum', async () => {
    const provider = stub(async () => {
      throw new Error('should not be called');
    });
    const brief = makeBrief({ minVariations: 2, variations: ['a', 'b', 'c'] });

    const result = await expandVariations({ brief, provider });

    expect(result.variations).toEqual(['a', 'b', 'c']);
    expect(result.skippedReason).toBe('sufficient');
    expect(provider.expandVariations).not.toHaveBeenCalled();
  });

  it('appends provider-proposed entries to the seed and reports a non-skipped run', async () => {
    const provider = stub(async (req) => {
      expect(req.count).toBe(3);
      expect(req.existing).toEqual(['seed one']);
      return ['new alpha', 'new beta', 'new gamma'];
    });
    const brief = makeBrief({ minVariations: 4, variations: ['seed one'] });

    const result = await expandVariations({ brief, provider });

    expect(result.skippedReason).toBeNull();
    expect(result.variations).toEqual(['seed one', 'new alpha', 'new beta', 'new gamma']);
    expect(result.proposed).toEqual(['new alpha', 'new beta', 'new gamma']);
  });

  it('drops provider entries that duplicate the seed (case-insensitive)', async () => {
    const provider = stub(async () => [
      'Seed One', // dup of 'seed one' from seed
      '  seed two  ', // dup once trimmed against seed
      'fresh entry',
    ]);
    const brief = makeBrief({
      minVariations: 5,
      variations: ['seed one', 'seed two'],
    });

    const result = await expandVariations({ brief, provider });

    expect(result.variations).toEqual(['seed one', 'seed two', 'fresh entry']);
  });

  it('drops duplicates within the provider response itself', async () => {
    const provider = stub(async () => ['idea one', 'IDEA ONE', 'idea two', '', '   ']);
    const brief = makeBrief({ minVariations: 5, variations: ['seed'] });

    const result = await expandVariations({ brief, provider });

    expect(result.variations).toEqual(['seed', 'idea one', 'idea two']);
  });

  it('warns and degrades when no provider is configured', async () => {
    const brief = makeBrief({ minVariations: 4, variations: ['seed'] });
    const warn = vi.fn();

    const result = await expandVariations({ brief, provider: null, warn });

    expect(result.skippedReason).toBe('no-provider');
    expect(result.variations).toEqual(['seed']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/no text provider/i);
  });

  it('warns and degrades when the provider throws', async () => {
    const provider = stub(async () => {
      throw new TextProviderError('rate-limit', 'too many requests');
    });
    const brief = makeBrief({ minVariations: 4, variations: ['seed'] });
    const warn = vi.fn();

    const result = await expandVariations({ brief, provider, warn });

    expect(result.skippedReason).toBe('provider-failed');
    expect(result.variations).toEqual(['seed']);
    expect(result.proposed).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/rate-limit/);
  });

  it('also degrades when the provider throws a non-TextProviderError', async () => {
    const provider = stub(async () => {
      throw new Error('boom');
    });
    const brief = makeBrief({ minVariations: 4, variations: [] });
    const warn = vi.fn();

    const result = await expandVariations({ brief, provider, warn });

    expect(result.skippedReason).toBe('provider-failed');
    expect(result.variations).toEqual([]);
    expect(warn.mock.calls[0]?.[0]).toMatch(/boom/);
  });

  it('requests exactly the missing count from the provider', async () => {
    const provider = stub(async (req) => {
      expect(req.count).toBe(6);
      return Array.from({ length: req.count }, (_, i) => `extra-${i}`);
    });
    const brief = makeBrief({ minVariations: 8, variations: ['a', 'b'] });

    const result = await expandVariations({ brief, provider });

    expect(result.variations.length).toBe(8);
    expect(result.variations.slice(0, 2)).toEqual(['a', 'b']);
  });
});
