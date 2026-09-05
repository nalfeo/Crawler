import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { ManifestEntry } from '../../../src/shared/generated-assets.js';
import {
  applyDislikedLifecyclePlan,
  buildDislikedLifecyclePlan,
  resolveDislikedManifestKeys,
  runAcceptedDislikedLifecycleTransaction,
  validateDislikedLifecycleClosure,
  type SpriteAnnotationsDocument,
} from '../../../scripts/sprites/disliked-lifecycle.js';
import { writeShard } from '../../../scripts/sprites/generated-shards.js';

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'disliked-lifecycle-'));
  roots.push(root);
  mkdirSync(path.join(root, 'public', 'assets', 'generated', 'entries'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  mkdirSync(path.join(root, '.github'), { recursive: true });
  mkdirSync(path.join(root, 'tests'), { recursive: true });
  mkdirSync(path.join(root, 'data'), { recursive: true });
  mkdirSync(path.join(root, 'tools'), { recursive: true });
  mkdirSync(path.join(root, 'docs', 'knowledge', 'handoffs'), { recursive: true });
  writeFileSync(
    path.join(root, 'public', 'assets', 'generated', 'sprite-editor-annotations.json'),
    '{"version":1,"sprites":{}}\n',
  );
  return root;
}

function entry(
  briefId: string,
  variantIndex: number,
  overrides: Partial<ManifestEntry> = {},
): ManifestEntry {
  const spriteName = `${briefId}-var-${variantIndex}`;
  return {
    briefId,
    spriteName,
    assetPath: `generated/${spriteName}.png`,
    approvedAt: '2026-01-01T00:00:00.000Z',
    sourceRun: `generated/runs/${briefId}/run-${variantIndex}`,
    variantIndex,
    anchor: null,
    sensorScore: '7/7',
    judgeScore: '5',
    ...overrides,
  };
}

function annotations(sprites: SpriteAnnotationsDocument['sprites']): SpriteAnnotationsDocument {
  return { version: 1, sprites };
}

describe('disliked sprite lifecycle planning', () => {
  it('removes disliked variants from mixed normalized groups and retains all-disliked groups', () => {
    const root = makeRoot();
    const entries = {
      'npc-demo-goon-var-0': entry('npc-demo-goon', 0),
      'demo-goon-var-1': entry('demo-goon', 1),
      'demo-goon-v2-var-2': entry('demo-goon-v2', 2),
      'bent-pipe-var-1': entry('bent-pipe', 1),
      'bent-pipe-var-5': entry('bent-pipe', 5),
    };
    const plan = buildDislikedLifecyclePlan({
      repoRoot: root,
      manifestEntries: entries,
      trackedAnnotations: annotations({
        'npc-demo-goon-var-0': { disliked: true },
        'demo-goon-v2-var-2': { disliked: true },
        'bent-pipe-var-1': { disliked: true },
        'bent-pipe-var-5': { disliked: true },
      }),
    });

    expect(plan.removed.map((item) => item.manifestKey)).toEqual([
      'demo-goon-v2-var-2',
      'npc-demo-goon-var-0',
    ]);
    expect(plan.removed.every((item) => item.replacementKey === 'demo-goon-var-1')).toBe(true);
    expect(plan.retainedGroups).toEqual([
      {
        conceptId: 'bent-pipe',
        manifestKeys: ['bent-pipe-var-1', 'bent-pipe-var-5'],
      },
    ]);
  });

  it('promotes the tracked and pending dislike union before authorizing deletion', () => {
    const root = makeRoot();
    const plan = buildDislikedLifecyclePlan({
      repoRoot: root,
      manifestEntries: {
        'rat-var-0': entry('rat', 0),
        'rat-var-1': entry('rat', 1),
      },
      trackedAnnotations: annotations({ 'rat-var-0': { disliked: true } }),
      pendingAnnotations: {
        'rat-var-1': {
          base: null,
          annotation: { favorite: false, disliked: true, comment: 'pending' },
        },
      },
      pendingDislikedKeys: new Set(['rat-var-1']),
      replacement: {
        manifestKey: 'rat-var-2',
        conceptId: 'rat',
        assetPath: 'generated/rat-var-2.png',
      },
    });

    expect(plan.promotedPendingCount).toBe(1);
    expect(plan.removed.map((item) => item.manifestKey)).toEqual(['rat-var-0', 'rat-var-1']);
    expect(plan.annotations.sprites['rat-var-1']?.tombstone?.annotationKeys).toEqual(['rat-var-1']);
  });

  it('reconciles a stale lineage annotation only by source lineage and variant index', () => {
    const root = makeRoot();
    const plan = buildDislikedLifecyclePlan({
      repoRoot: root,
      manifestEntries: {
        'demo-goon-var-3': entry('demo-goon', 3, {
          sourceRun: 'generated/runs/demo-goon-v2/run-a',
        }),
        'demo-goon-var-4': entry('demo-goon', 4),
      },
      trackedAnnotations: annotations({
        'demo-goon-v2-var-3': {
          disliked: true,
          comment: 'legacy key',
          sourceRun: 'archived/runs/run-a',
          variantIndex: 3,
        },
      }),
    });

    expect(plan.unresolvedAnnotationKeys).toEqual([]);
    expect(plan.removed[0]?.manifestKey).toBe('demo-goon-var-3');
    expect(plan.annotations.sprites['demo-goon-v2-var-3']).toBeUndefined();
    expect(plan.annotations.sprites['demo-goon-var-3']?.tombstone?.annotationKeys).toEqual([
      'demo-goon-v2-var-3',
    ]);
  });

  it('resolves only exact accepted keys when provenance is unavailable to reference exclusion', () => {
    const entries = {
      'demo-goon-var-3': entry('demo-goon', 3, {
        sourceRun: 'generated/runs/demo-goon-v2/run-a',
      }),
      'demo-goon-var-4': entry('demo-goon', 4),
    };
    expect([
      ...resolveDislikedManifestKeys(entries, new Set(['demo-goon-v2-var-3', 'demo-goon-var-4'])),
    ]).toEqual(['demo-goon-var-4']);
  });

  it('does not infer deletion authority from a stale key name or parsed variant index', () => {
    const root = makeRoot();
    const plan = buildDislikedLifecyclePlan({
      repoRoot: root,
      manifestEntries: {
        'demo-goon-var-3': entry('demo-goon', 3, {
          sourceRun: 'generated/runs/demo-goon-v2/run-a',
        }),
        'demo-goon-var-4': entry('demo-goon', 4),
      },
      trackedAnnotations: annotations({
        'demo-goon-v2-var-3': { disliked: true, comment: 'no provenance' },
      }),
    });

    expect(plan.removed).toEqual([]);
    expect(plan.unresolvedAnnotationKeys).toEqual(['demo-goon-v2-var-3']);
  });

  it('reports zero-match stale annotations without guessing a concept-wide deletion', () => {
    const root = makeRoot();
    const plan = buildDislikedLifecyclePlan({
      repoRoot: root,
      manifestEntries: { 'faerie-boss-var-0': entry('faerie-boss', 0) },
      trackedAnnotations: annotations({ 'faerie-boss-var-9': { disliked: true } }),
    });

    expect(plan.removed).toEqual([]);
    expect(plan.unresolvedAnnotationKeys).toEqual(['faerie-boss-var-9']);
    expect(plan.annotations.sprites['faerie-boss-var-9']?.reconciliation).toEqual({
      outcome: 'unmatched',
      annotationKey: 'faerie-boss-var-9',
    });
  });

  it('fails closed when stale provenance matches multiple accepted entries', () => {
    const root = makeRoot();
    expect(() =>
      buildDislikedLifecyclePlan({
        repoRoot: root,
        manifestEntries: {
          a: entry('demo-goon', 3, {
            sourceRun: 'generated/runs/demo-goon-v2/run-a',
          }),
          b: entry('demo-goon', 3, {
            sourceRun: 'generated/runs/legacy-demo-goon/run-a',
          }),
        },
        trackedAnnotations: annotations({
          'demo-goon-v2-var-3': {
            disliked: true,
            sourceRun: 'archived/run-a',
            variantIndex: 3,
          },
        }),
      }),
    ).toThrow(/ambiguous.*a, b/i);
  });
});

describe('disliked sprite lifecycle transaction', () => {
  it('deletes nested manifest assets, writes tombstones, repoints exact references, and validates closure', () => {
    const root = makeRoot();
    const generatedDir = path.join(root, 'public', 'assets', 'generated');
    const disliked = entry('npc-demo-goon', 0, {
      assetPath: 'generated/npc/demo-goon.png',
    });
    const survivor = entry('demo-goon', 1);
    writeShard(generatedDir, disliked.spriteName, disliked);
    writeShard(generatedDir, survivor.spriteName, survivor);
    mkdirSync(path.join(generatedDir, 'npc'), { recursive: true });
    writeFileSync(path.join(generatedDir, 'npc', 'demo-goon.png'), 'bad');
    writeFileSync(path.join(generatedDir, 'demo-goon-var-1.png'), 'good');
    writeFileSync(
      path.join(generatedDir, 'sprite-editor-annotations.json'),
      JSON.stringify({
        version: 1,
        sprites: { 'npc-demo-goon-var-0': { disliked: true } },
      }),
    );
    const pinPath = path.join(root, 'src', 'pins.json');
    writeFileSync(pinPath, '{"pin":"npc-demo-goon-var-0"}\n');

    const plan = buildDislikedLifecyclePlan({
      repoRoot: root,
      manifestEntries: {
        [disliked.spriteName]: disliked,
        [survivor.spriteName]: survivor,
      },
      trackedAnnotations: annotations({
        'npc-demo-goon-var-0': { disliked: true },
      }),
    });
    const result = applyDislikedLifecyclePlan(root, plan);

    expect(result.removedCount).toBe(1);
    expect(existsSync(path.join(generatedDir, 'entries', 'npc-demo-goon-var-0.json'))).toBe(false);
    expect(existsSync(path.join(generatedDir, 'npc', 'demo-goon.png'))).toBe(false);
    expect(readFileSync(pinPath, 'utf8')).toContain('demo-goon-var-1');
    expect(() => validateDislikedLifecycleClosure(root, plan)).not.toThrow();
  });

  it('repoints only exact pins without corrupting longer variant identifiers', () => {
    const root = makeRoot();
    const generatedDir = path.join(root, 'public', 'assets', 'generated');
    const disliked = entry('rat', 1);
    const survivor = entry('rat', 2);
    writeShard(generatedDir, disliked.spriteName, disliked);
    writeShard(generatedDir, survivor.spriteName, survivor);
    writeFileSync(path.join(generatedDir, 'rat-var-1.png'), 'bad');
    writeFileSync(path.join(generatedDir, 'rat-var-2.png'), 'good');
    const pinPath = path.join(root, 'src', 'pins.json');
    writeFileSync(pinPath, '{"pin":"rat-var-1","unrelated":"rat-var-10"}\n');

    const plan = buildDislikedLifecyclePlan({
      repoRoot: root,
      manifestEntries: {
        [disliked.spriteName]: disliked,
        [survivor.spriteName]: survivor,
      },
      trackedAnnotations: annotations({ 'rat-var-1': { disliked: true } }),
    });
    applyDislikedLifecyclePlan(root, plan);

    expect(readFileSync(pinPath, 'utf8')).toBe('{"pin":"rat-var-2","unrelated":"rat-var-10"}\n');
    expect(() => validateDislikedLifecycleClosure(root, plan)).not.toThrow();
  });

  it('repoints exact references in checked-in test, data, and tool roots but preserves audit docs', () => {
    const root = makeRoot();
    const generatedDir = path.join(root, 'public', 'assets', 'generated');
    const disliked = entry('rat', 1);
    const survivor = entry('rat', 2);
    writeShard(generatedDir, disliked.spriteName, disliked);
    writeShard(generatedDir, survivor.spriteName, survivor);
    writeFileSync(path.join(generatedDir, 'rat-var-1.png'), 'bad');
    writeFileSync(path.join(generatedDir, 'rat-var-2.png'), 'good');

    const liveReferences = [
      path.join(root, 'tests', 'fixture.ts'),
      path.join(root, 'data', 'fixture.json'),
      path.join(root, 'tools', 'fixture.mjs'),
    ];
    for (const file of liveReferences) {
      writeFileSync(file, '{"pin":"rat-var-1","longer":"rat-var-10"}\n');
    }
    const auditHistory = path.join(root, 'docs', 'knowledge', 'handoffs', 'historical.json');
    writeFileSync(auditHistory, '{"removed":"rat-var-1"}\n');

    const plan = buildDislikedLifecyclePlan({
      repoRoot: root,
      manifestEntries: {
        [disliked.spriteName]: disliked,
        [survivor.spriteName]: survivor,
      },
      trackedAnnotations: annotations({ 'rat-var-1': { disliked: true } }),
    });
    applyDislikedLifecyclePlan(root, plan);

    expect(plan.referenceUpdates.map((update) => path.relative(root, update.path)).sort()).toEqual([
      path.join('data', 'fixture.json'),
      path.join('tests', 'fixture.ts'),
      path.join('tools', 'fixture.mjs'),
    ]);
    for (const file of liveReferences) {
      expect(readFileSync(file, 'utf8')).toBe('{"pin":"rat-var-2","longer":"rat-var-10"}\n');
    }
    expect(readFileSync(auditHistory, 'utf8')).toBe('{"removed":"rat-var-1"}\n');
    expect(() => validateDislikedLifecycleClosure(root, plan)).not.toThrow();
  });

  it('rolls back approval and cleanup when durable publication fails', async () => {
    const root = makeRoot();
    const generatedDir = path.join(root, 'public', 'assets', 'generated');
    const disliked = entry('rat', 0);
    writeShard(generatedDir, disliked.spriteName, disliked);
    writeFileSync(path.join(generatedDir, 'rat-var-0.png'), 'bad');
    const annotationsPath = path.join(generatedDir, 'sprite-editor-annotations.json');
    const originalAnnotations = JSON.stringify({
      version: 1,
      sprites: { 'rat-var-0': { disliked: true, comment: 'replace me' } },
    });
    writeFileSync(annotationsPath, originalAnnotations);
    const pinPath = path.join(root, 'src', 'pins.json');
    writeFileSync(pinPath, '{"pin":"rat-var-1"}\n');

    await expect(
      runAcceptedDislikedLifecycleTransaction({
        repoRoot: root,
        replacement: {
          manifestKey: 'rat-var-1',
          conceptId: 'rat',
          assetPath: 'generated/rat-var-1.png',
        },
        approve: () => {
          const replacement = entry('rat', 1);
          writeShard(generatedDir, replacement.spriteName, replacement);
          writeFileSync(path.join(generatedDir, 'rat-var-1.png'), 'new');
          return replacement;
        },
        publish: () => Promise.reject(new Error('queue unavailable')),
      }),
    ).rejects.toThrow('queue unavailable');

    expect(existsSync(path.join(generatedDir, 'entries', 'rat-var-0.json'))).toBe(true);
    expect(existsSync(path.join(generatedDir, 'rat-var-0.png'))).toBe(true);
    expect(existsSync(path.join(generatedDir, 'entries', 'rat-var-1.json'))).toBe(false);
    expect(existsSync(path.join(generatedDir, 'rat-var-1.png'))).toBe(false);
    expect(readFileSync(annotationsPath, 'utf8')).toBe(originalAnnotations);
    expect(readFileSync(pinPath, 'utf8')).toBe('{"pin":"rat-var-1"}\n');
  });

  it('deletes a retained all-disliked group when a replacement is explicitly accepted', async () => {
    const root = makeRoot();
    const generatedDir = path.join(root, 'public', 'assets', 'generated');
    for (const variantIndex of [0, 1]) {
      const disliked = entry('rat', variantIndex);
      writeShard(generatedDir, disliked.spriteName, disliked);
      writeFileSync(path.join(generatedDir, `rat-var-${variantIndex}.png`), 'bad');
    }
    writeFileSync(
      path.join(generatedDir, 'sprite-editor-annotations.json'),
      JSON.stringify({
        version: 1,
        sprites: {
          'rat-var-0': { disliked: true },
          'rat-var-1': { disliked: true },
        },
      }),
    );
    const replacement = entry('rat', 2);
    let publishedRemovalKeys: readonly string[] = [];

    const result = await runAcceptedDislikedLifecycleTransaction({
      repoRoot: root,
      replacement: {
        manifestKey: replacement.spriteName,
        conceptId: 'rat',
        assetPath: replacement.assetPath,
      },
      approve: () => {
        writeShard(generatedDir, replacement.spriteName, replacement);
        writeFileSync(path.join(generatedDir, 'rat-var-2.png'), 'new');
        return replacement;
      },
      publish: (_approved, plan) => {
        publishedRemovalKeys = plan.removed.map((removal) => removal.manifestKey);
        return Promise.resolve();
      },
    });

    expect(result.plan.removed.map((removal) => removal.manifestKey)).toEqual([
      'rat-var-0',
      'rat-var-1',
    ]);
    expect(publishedRemovalKeys).toEqual(['rat-var-0', 'rat-var-1']);
    expect(existsSync(path.join(generatedDir, 'entries', 'rat-var-0.json'))).toBe(false);
    expect(existsSync(path.join(generatedDir, 'entries', 'rat-var-1.json'))).toBe(false);
    expect(existsSync(path.join(generatedDir, 'rat-var-0.png'))).toBe(false);
    expect(existsSync(path.join(generatedDir, 'rat-var-1.png'))).toBe(false);
    expect(existsSync(path.join(generatedDir, 'entries', 'rat-var-2.json'))).toBe(true);
    expect(() => validateDislikedLifecycleClosure(root, result.plan)).not.toThrow();
  });

  it('validates historical tombstones when a post-apply plan has no new removals', () => {
    const root = makeRoot();
    const generatedDir = path.join(root, 'public', 'assets', 'generated');
    writeFileSync(
      path.join(generatedDir, 'sprite-editor-annotations.json'),
      JSON.stringify({
        version: 1,
        sprites: {
          'rat-var-0': {
            disliked: true,
            tombstone: {
              manifestKey: 'rat-var-0',
              conceptId: 'rat',
              assetPath: 'generated/rat-var-0.png',
              sourceRun: 'generated/runs/rat/run-0',
              variantIndex: 0,
              annotationKeys: ['rat-var-0'],
            },
          },
        },
      }),
    );
    const pinPath = path.join(root, 'src', 'pins.json');
    writeFileSync(pinPath, '{"pin":"rat-var-0"}\n');
    const cleanPlan = buildDislikedLifecyclePlan({
      repoRoot: root,
      manifestEntries: {},
      trackedAnnotations: annotations({
        'rat-var-0': {
          disliked: true,
          tombstone: {
            manifestKey: 'rat-var-0',
            conceptId: 'rat',
            assetPath: 'generated/rat-var-0.png',
            sourceRun: 'generated/runs/rat/run-0',
            variantIndex: 0,
            annotationKeys: ['rat-var-0'],
          },
        },
      }),
    });

    expect(cleanPlan.removed).toEqual([]);
    expect(() => validateDislikedLifecycleClosure(root, cleanPlan)).toThrow(
      /exact reference to rat-var-0 remains/,
    );

    writeFileSync(pinPath, '{"pin":"rat-var-1"}\n');
    expect(() => validateDislikedLifecycleClosure(root, cleanPlan)).not.toThrow();
  });

  it('aborts acceptance before mutation when removal requires a source pin repoint', async () => {
    const root = makeRoot();
    const generatedDir = path.join(root, 'public', 'assets', 'generated');
    const disliked = entry('rat', 0);
    writeShard(generatedDir, disliked.spriteName, disliked);
    writeFileSync(path.join(generatedDir, 'rat-var-0.png'), 'bad');
    writeFileSync(
      path.join(generatedDir, 'sprite-editor-annotations.json'),
      JSON.stringify({ version: 1, sprites: { 'rat-var-0': { disliked: true } } }),
    );
    writeFileSync(path.join(root, 'src', 'pins.json'), '{"pin":"rat-var-0"}\n');
    let approved = false;

    await expect(
      runAcceptedDislikedLifecycleTransaction({
        repoRoot: root,
        replacement: {
          manifestKey: 'rat-var-1',
          conceptId: 'rat',
          assetPath: 'generated/rat-var-1.png',
        },
        approve: () => {
          approved = true;
          return entry('rat', 1);
        },
        publish: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/Repoint and commit those pins before retrying approval/);

    expect(approved).toBe(false);
    expect(existsSync(path.join(generatedDir, 'entries', 'rat-var-0.json'))).toBe(true);
  });
});
