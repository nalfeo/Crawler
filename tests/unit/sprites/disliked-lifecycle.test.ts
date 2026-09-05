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
      'npc-welcome-goon-var-0': entry('npc-welcome-goon', 0),
      'welcome-goon-var-1': entry('welcome-goon', 1),
      'bent-pipe-var-1': entry('bent-pipe', 1),
      'bent-pipe-var-5': entry('bent-pipe', 5),
    };
    const plan = buildDislikedLifecyclePlan({
      repoRoot: root,
      manifestEntries: entries,
      trackedAnnotations: annotations({
        'npc-welcome-goon-var-0': { disliked: true },
        'bent-pipe-var-1': { disliked: true },
        'bent-pipe-var-5': { disliked: true },
      }),
    });

    expect(plan.removed.map((item) => item.manifestKey)).toEqual(['npc-welcome-goon-var-0']);
    expect(plan.removed[0]?.replacementKey).toBe('welcome-goon-var-1');
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
        'welcome-goon-var-3': entry('welcome-goon', 3, {
          sourceRun: 'generated/runs/welcome-goon-v2/run-a',
        }),
        'welcome-goon-var-4': entry('welcome-goon', 4),
      },
      trackedAnnotations: annotations({
        'welcome-goon-v2-var-3': { disliked: true, comment: 'legacy key' },
      }),
    });

    expect(plan.unresolvedAnnotationKeys).toEqual([]);
    expect(plan.removed[0]?.manifestKey).toBe('welcome-goon-var-3');
    expect(plan.annotations.sprites['welcome-goon-v2-var-3']).toBeUndefined();
    expect(plan.annotations.sprites['welcome-goon-var-3']?.tombstone?.annotationKeys).toEqual([
      'welcome-goon-v2-var-3',
    ]);
  });

  it('resolves tracked and pending stale keys to exact accepted variants for reference exclusion', () => {
    const entries = {
      'welcome-goon-var-3': entry('welcome-goon', 3, {
        sourceRun: 'generated/runs/welcome-goon-v2/run-a',
      }),
      'welcome-goon-var-4': entry('welcome-goon', 4),
    };
    expect([...resolveDislikedManifestKeys(entries, new Set(['welcome-goon-v2-var-3']))]).toEqual([
      'welcome-goon-var-3',
    ]);
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
          a: entry('welcome-goon', 3, {
            sourceRun: 'generated/runs/welcome-goon-v2/run-a',
          }),
          b: entry('welcome-goon', 3, {
            sourceRun: 'generated/runs/welcome-goon-v2/run-b',
          }),
        },
        trackedAnnotations: annotations({
          'welcome-goon-v2-var-3': { disliked: true },
        }),
      }),
    ).toThrow(/ambiguous.*a, b/i);
  });
});

describe('disliked sprite lifecycle transaction', () => {
  it('deletes nested manifest assets, writes tombstones, repoints exact references, and validates closure', () => {
    const root = makeRoot();
    const generatedDir = path.join(root, 'public', 'assets', 'generated');
    const disliked = entry('npc-welcome-goon', 0, {
      assetPath: 'generated/npc/welcome-goon.png',
    });
    const survivor = entry('welcome-goon', 1);
    writeShard(generatedDir, disliked.spriteName, disliked);
    writeShard(generatedDir, survivor.spriteName, survivor);
    mkdirSync(path.join(generatedDir, 'npc'), { recursive: true });
    writeFileSync(path.join(generatedDir, 'npc', 'welcome-goon.png'), 'bad');
    writeFileSync(path.join(generatedDir, 'welcome-goon-var-1.png'), 'good');
    writeFileSync(
      path.join(generatedDir, 'sprite-editor-annotations.json'),
      JSON.stringify({
        version: 1,
        sprites: { 'npc-welcome-goon-var-0': { disliked: true } },
      }),
    );
    const pinPath = path.join(root, 'src', 'pins.json');
    writeFileSync(pinPath, '{"pin":"npc-welcome-goon-var-0"}\n');

    const plan = buildDislikedLifecyclePlan({
      repoRoot: root,
      manifestEntries: {
        [disliked.spriteName]: disliked,
        [survivor.spriteName]: survivor,
      },
      trackedAnnotations: annotations({
        'npc-welcome-goon-var-0': { disliked: true },
      }),
    });
    const result = applyDislikedLifecyclePlan(root, plan);

    expect(result.removedCount).toBe(1);
    expect(existsSync(path.join(generatedDir, 'entries', 'npc-welcome-goon-var-0.json'))).toBe(
      false,
    );
    expect(existsSync(path.join(generatedDir, 'npc', 'welcome-goon.png'))).toBe(false);
    expect(readFileSync(pinPath, 'utf8')).toContain('welcome-goon-var-1');
    expect(() => validateDislikedLifecycleClosure(root, plan)).not.toThrow();
  });

  it('rolls back approval and cleanup when durable publication fails', async () => {
    const root = makeRoot();
    const generatedDir = path.join(root, 'public', 'assets', 'generated');
    const disliked = entry('rat', 0);
    writeShard(generatedDir, disliked.spriteName, disliked);
    writeFileSync(path.join(generatedDir, 'rat-var-0.png'), 'bad');
    writeFileSync(
      path.join(generatedDir, 'sprite-editor-annotations.json'),
      JSON.stringify({ version: 1, sprites: { 'rat-var-0': { disliked: true } } }),
    );

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
    expect(existsSync(path.join(generatedDir, 'entries', 'rat-var-2.json'))).toBe(true);
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
