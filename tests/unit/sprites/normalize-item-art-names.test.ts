import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyPlanToData,
  filesByteEqual,
  planConcept,
  planMigration,
  type CatalogRecordRaw,
  type GeneratedManifest,
  type ManifestEntry,
} from '../../../scripts/sprites/normalize-item-art-names.js';

// --- fixture factories -----------------------------------------------------

function real(key: string, briefId: string, opts: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    briefId,
    spriteName: key,
    assetPath: `generated/${key}.png`,
    sourceRun: 'generated/runs/example/2026-01-01',
    variantIndex: 0,
    anchor: { x: 10, y: 20, source: 'derived' },
    contentHash: `hash-${key}`,
    type: null,
    ...opts,
  };
}

function placeholder(concept: string): ManifestEntry {
  const key = `${concept}-placeholder`;
  return {
    briefId: concept,
    spriteName: key,
    assetPath: `generated/${key}.png`,
    sourceRun: 'placeholder',
    variantIndex: 0,
    anchor: null,
  };
}

function manifest(entries: Record<string, ManifestEntry>): GeneratedManifest {
  return { version: 1, entries };
}

function catalogSprite(key: string, briefId: string): CatalogRecordRaw {
  return {
    id: `generated:${key}`,
    kind: 'sprite',
    label: key,
    description: `Generated sprite from brief: ${briefId}.`,
    tags: ['generated', 'pipeline-approved'],
    spriteId: key,
    sheetKey: 'generated-manifest',
    assetPath: `generated/${key}.png`,
    frame: 0,
    col: 0,
    row: 0,
  };
}

function catalogSheet(key: string): CatalogRecordRaw {
  return {
    id: `sheet:${key}`,
    kind: 'sheet',
    label: key,
    description: `Sheet ${key}.`,
    tags: [],
    sheetKey: key,
    path: `sheets/${key}.png`,
    frameWidth: 16,
    frameHeight: 16,
    margin: 0,
    spacing: 0,
    cols: 4,
  };
}

// --- planConcept / planMigration -------------------------------------------

describe('planConcept — single lineage + placeholder', () => {
  it('renames the real versioned art to a bare key and retires the placeholder', () => {
    const m = manifest({
      'iron-ore-v1-var-0': real('iron-ore-v1-var-0', 'iron-ore-v1'),
      'iron-ore-placeholder': placeholder('iron-ore'),
    });
    const { renames, retires, errors } = planConcept(m, { concept: 'iron-ore' });

    expect(errors).toEqual([]);
    expect(renames).toHaveLength(1);
    expect(renames[0]).toMatchObject({
      oldKey: 'iron-ore-v1-var-0',
      newKey: 'iron-ore-var-0',
      oldBriefId: 'iron-ore-v1',
      newBriefId: 'iron-ore',
      newAssetPath: 'generated/iron-ore-var-0.png',
    });
    expect(retires).toHaveLength(1);
    expect(retires[0]).toMatchObject({ key: 'iron-ore-placeholder', reason: 'placeholder' });
  });

  it('renames every variant in a multi-variant single lineage', () => {
    const m = manifest({
      'bone-shard-v1-var-1': real('bone-shard-v1-var-1', 'bone-shard-v1'),
      'bone-shard-v1-var-3': real('bone-shard-v1-var-3', 'bone-shard-v1'),
      'bone-shard-v1-var-6': real('bone-shard-v1-var-6', 'bone-shard-v1'),
      'bone-shard-placeholder': placeholder('bone-shard'),
    });
    const { renames, retires, errors } = planConcept(m, { concept: 'bone-shard' });

    expect(errors).toEqual([]);
    expect(renames.map((r) => r.newKey).sort()).toEqual([
      'bone-shard-var-1',
      'bone-shard-var-3',
      'bone-shard-var-6',
    ]);
    expect(renames.every((r) => r.newBriefId === 'bone-shard')).toBe(true);
    expect(retires).toHaveLength(1);
  });

  it('does not confuse a `-var-N` bare key with a `-vN` lineage (idempotent, already bare)', () => {
    const m = manifest({ 'iron-ore-var-0': real('iron-ore-var-0', 'iron-ore') });
    const plan = planMigration(m, [{ concept: 'iron-ore' }]);
    expect(plan.clean).toBe(true);
    expect(plan.renames).toEqual([]);
    expect(plan.retires).toEqual([]);
  });
});

describe('planConcept — multi-lineage', () => {
  it('refuses to guess when >1 real lineage and no keepVersion', () => {
    const m = manifest({
      'baseball-bat-v1-var-0': real('baseball-bat-v1-var-0', 'baseball-bat-v1'),
      'baseball-bat-v3-var-6': real('baseball-bat-v3-var-6', 'baseball-bat-v3'),
    });
    const { renames, retires, errors } = planConcept(m, { concept: 'baseball-bat' });
    expect(renames).toEqual([]);
    expect(retires).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('real lineages');
  });

  it('keeps the requested lineage and retires the others when keepVersion is set', () => {
    const m = manifest({
      'baseball-bat-v1-var-0': real('baseball-bat-v1-var-0', 'baseball-bat-v1'),
      'baseball-bat-v3-var-6': real('baseball-bat-v3-var-6', 'baseball-bat-v3'),
    });
    const { renames, retires, errors } = planConcept(m, {
      concept: 'baseball-bat',
      keepVersion: 1,
    });
    expect(errors).toEqual([]);
    expect(renames).toHaveLength(1);
    expect(renames[0]).toMatchObject({
      oldKey: 'baseball-bat-v1-var-0',
      newKey: 'baseball-bat-var-0',
    });
    expect(retires).toHaveLength(1);
    expect(retires[0]).toMatchObject({ key: 'baseball-bat-v3-var-6', reason: 'non-keep-lineage' });
  });

  it('errors when the requested keepVersion is absent', () => {
    const m = manifest({
      'flame-dagger-v2-var-3': real('flame-dagger-v2-var-3', 'flame-dagger-v2'),
    });
    const { errors } = planConcept(m, { concept: 'flame-dagger', keepVersion: 1 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('keepVersion v1 not found');
  });
});

describe('planConcept — collisions / idempotency', () => {
  it('drops the stale versioned key when the bare target already exists with the SAME art (identical contentHash)', () => {
    const m = manifest({
      'iron-ore-v1-var-0': real('iron-ore-v1-var-0', 'iron-ore-v1', { contentHash: 'same-bytes' }),
      'iron-ore-var-0': real('iron-ore-var-0', 'iron-ore', { contentHash: 'same-bytes' }),
    });
    const { renames, retires, errors } = planConcept(m, { concept: 'iron-ore' });
    expect(errors).toEqual([]);
    expect(renames).toEqual([]);
    expect(retires).toHaveLength(1);
    expect(retires[0]).toMatchObject({ key: 'iron-ore-v1-var-0', reason: 'non-keep-lineage' });
    // Proven identical by contentHash -> no on-disk byte re-check needed.
    expect(retires[0]!.verifyAgainstPath).toBeUndefined();
  });

  it('hard-errors when the bare target exists with the same briefId but a DIFFERENT contentHash', () => {
    const m = manifest({
      'iron-ore-v1-var-0': real('iron-ore-v1-var-0', 'iron-ore-v1', { contentHash: 'old-bytes' }),
      'iron-ore-var-0': real('iron-ore-var-0', 'iron-ore', { contentHash: 'new-bytes' }),
    });
    const { renames, retires, errors } = planConcept(m, { concept: 'iron-ore' });
    // both-exist-different-bytes MUST fail rather than silently discard the old art.
    expect(renames).toEqual([]);
    expect(retires).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('different contentHash');
  });

  it('tags a collision retire for on-disk byte-verification when contentHash is absent', () => {
    const m = manifest({
      'iron-ore-v1-var-0': real('iron-ore-v1-var-0', 'iron-ore-v1', { contentHash: undefined }),
      'iron-ore-var-0': real('iron-ore-var-0', 'iron-ore', { contentHash: undefined }),
    });
    const { retires, errors } = planConcept(m, { concept: 'iron-ore' });
    expect(errors).toEqual([]);
    expect(retires).toHaveLength(1);
    // No hash to prove identity -> defer to a disk byte comparison in the apply step.
    expect(retires[0]).toMatchObject({
      key: 'iron-ore-v1-var-0',
      reason: 'non-keep-lineage',
      verifyAgainstPath: 'generated/iron-ore-var-0.png',
    });
  });

  it('hard-errors when the bare target exists with a different briefId', () => {
    const m = manifest({
      'iron-ore-v1-var-0': real('iron-ore-v1-var-0', 'iron-ore-v1'),
      'iron-ore-var-0': real('iron-ore-var-0', 'something-else'),
    });
    const { errors } = planConcept(m, { concept: 'iron-ore' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('different briefId');
  });
});

// --- applyPlanToData -------------------------------------------------------

describe('applyPlanToData — manifest', () => {
  it('returns entries in canonical sorted order, rewrites the renamed entry, drops the placeholder', () => {
    const m = manifest({
      'other-a': real('other-a', 'other-a'),
      'iron-ore-v1-var-0': real('iron-ore-v1-var-0', 'iron-ore-v1', { facingDirection: 'right' }),
      'other-b': real('other-b', 'other-b'),
      'iron-ore-placeholder': placeholder('iron-ore'),
    });
    const plan = planMigration(m, [{ concept: 'iron-ore' }]);
    const next = applyPlanToData(m, [], plan);

    // Keys are sorted lexicographically (canonical order enforced by check:sort-assets).
    // 'iron-ore-var-0' < 'other-a' < 'other-b', placeholder dropped.
    expect(Object.keys(next.manifest.entries)).toEqual(['iron-ore-var-0', 'other-a', 'other-b']);

    const migrated = next.manifest.entries['iron-ore-var-0']!;
    expect(migrated.briefId).toBe('iron-ore');
    expect(migrated.spriteName).toBe('iron-ore-var-0');
    expect(migrated.assetPath).toBe('generated/iron-ore-var-0.png');
    // Non-name fields are preserved verbatim.
    expect(migrated.sourceRun).toBe('generated/runs/example/2026-01-01');
    expect(migrated.contentHash).toBe('hash-iron-ore-v1-var-0');
    expect(migrated.facingDirection).toBe('right');
    expect(migrated.anchor).toEqual({ x: 10, y: 20, source: 'derived' });

    // Original manifest object is untouched (pure).
    expect(m.entries['iron-ore-v1-var-0']).toBeDefined();
  });
});

describe('applyPlanToData — catalog', () => {
  it('repoints the renamed generated entry, returns catalog in canonical sorted order', () => {
    const m = manifest({
      'iron-ore-v1-var-0': real('iron-ore-v1-var-0', 'iron-ore-v1'),
      'iron-ore-placeholder': placeholder('iron-ore'),
    });
    const zebra = catalogSprite('zebra-var-0', 'zebra');
    const catalog: CatalogRecordRaw[] = [
      zebra,
      catalogSprite('iron-ore-v1-var-0', 'iron-ore-v1'),
      catalogSheet('generated-manifest'),
    ];
    const plan = planMigration(m, [{ concept: 'iron-ore' }]);
    const next = applyPlanToData(m, catalog, plan);

    const ironOre = next.catalog.find((r) => r.id === 'generated:iron-ore-var-0');
    expect(ironOre).toBeDefined();
    expect(ironOre).toMatchObject({
      kind: 'sprite',
      label: 'iron-ore-var-0',
      spriteId: 'iron-ore-var-0',
      description: 'Generated sprite from brief: iron-ore.',
      assetPath: 'generated/iron-ore-var-0.png',
    });
    // Old id is gone.
    expect(next.catalog.find((r) => r.id === 'generated:iron-ore-v1-var-0')).toBeUndefined();
    // CANONICAL sort order: sheets first, then sprites sorted by id.
    // sheet:generated-manifest < generated:iron-ore-var-0 < generated:zebra-var-0
    expect(next.catalog.map((r) => r.id)).toEqual([
      'sheet:generated-manifest',
      'generated:iron-ore-var-0',
      'generated:zebra-var-0',
    ]);
    // KEY order within the edited record is preserved (the migrated fields are
    // overwritten in place, not appended), so serialization stays churn-free.
    expect(Object.keys(ironOre!)).toEqual([
      'id',
      'kind',
      'label',
      'description',
      'tags',
      'spriteId',
      'sheetKey',
      'assetPath',
      'frame',
      'col',
      'row',
    ]);
  });

  it('removes a generated catalog entry for a retired key', () => {
    const m = manifest({
      'baseball-bat-v1-var-0': real('baseball-bat-v1-var-0', 'baseball-bat-v1'),
      'baseball-bat-v3-var-6': real('baseball-bat-v3-var-6', 'baseball-bat-v3'),
    });
    const catalog: CatalogRecordRaw[] = [
      catalogSprite('baseball-bat-v1-var-0', 'baseball-bat-v1'),
      catalogSprite('baseball-bat-v3-var-6', 'baseball-bat-v3'),
    ];
    const plan = planMigration(m, [{ concept: 'baseball-bat', keepVersion: 1 }]);
    const next = applyPlanToData(m, catalog, plan);

    expect(next.catalog.map((r) => r.id)).toEqual(['generated:baseball-bat-var-0']);
  });
});

// --- filesByteEqual (disk byte-safety) -------------------------------------

describe('filesByteEqual', () => {
  it('is true for byte-identical files and false for divergent ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'norm-item-art-'));
    try {
      const a = join(dir, 'a.png');
      const b = join(dir, 'b.png');
      const c = join(dir, 'c.png');
      writeFileSync(a, Buffer.from([1, 2, 3, 4]));
      writeFileSync(b, Buffer.from([1, 2, 3, 4]));
      writeFileSync(c, Buffer.from([1, 2, 3, 5]));
      expect(filesByteEqual(a, b)).toBe(true);
      expect(filesByteEqual(a, c)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
