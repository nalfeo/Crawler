/**
 * Real-git tests for the cutover classifier over the final `assets/queue` tip.
 *
 * The migration is only safe if EVERY path and annotation delta on the retired
 * aggregate branch is accounted for, so these tests pin the classification of
 * each class the 2026-08 corruption produced: clean adds, entries already on
 * main, post-rename duplicates, broken PNG/shard pairs, and deletions (which
 * must never migrate automatically).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import path from 'node:path';
import {
  classifyQueueTip,
  groupChangedPaths,
  renderMigrationReport,
} from '../../../../scripts/sprites/asset-requests/migrate-queue.js';
import { createDefaultMaterializeDeps } from '../../../../scripts/sprites/asset-requests/runtime.js';
import {
  git,
  makeSandbox,
  writeAsset,
  writeFileAt,
  type Sandbox,
  type SeedAsset,
} from './harness.js';

let sandbox: Sandbox | undefined;

afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

/** Build an `assets/queue` branch from main with the given mutations applied. */
function buildQueueBranch(current: Sandbox, mutate: (worktree: string) => void): void {
  const worktree = path.join(current.root, 'queue-build');
  git(current.clone, 'worktree', 'add', '--detach', worktree, 'origin/main');
  mutate(worktree);
  git(worktree, 'add', '--all');
  git(worktree, 'config', 'user.email', 'queue@crawler.invalid');
  git(worktree, 'config', 'user.name', 'Queue');
  git(worktree, 'commit', '-m', 'queue tip');
  git(worktree, 'push', 'origin', 'HEAD:refs/heads/assets/queue');
  git(current.clone, 'worktree', 'remove', '--force', worktree);
  git(current.clone, 'fetch', 'origin');
}

function classify(current: Sandbox) {
  return classifyQueueTip(current.clone, createDefaultMaterializeDeps(), {
    baseRef: 'origin/main',
    queueRef: 'origin/assets/queue',
  });
}

describe('groupChangedPaths', () => {
  it('groups a PNG and its shard under one manifest key and flags the rest', () => {
    const { groups, annotationsChanged, unclassified } = groupChangedPaths([
      'public/assets/generated/lantern-var-0.png',
      'public/assets/generated/entries/lantern-var-0.json',
      'public/assets/generated/sprite-editor-annotations.json',
      'public/assets/generated/README.md',
    ]);
    expect([...groups.keys()]).toEqual(['lantern-var-0']);
    expect(groups.get('lantern-var-0')).toEqual([
      'public/assets/generated/entries/lantern-var-0.json',
      'public/assets/generated/lantern-var-0.png',
    ]);
    expect(annotationsChanged).toBe(true);
    expect(unclassified).toEqual(['public/assets/generated/README.md']);
  });

  it('keeps nested equipment keys intact', () => {
    const { groups } = groupChangedPaths([
      'public/assets/generated/entries/equipment/weapon/bone-saw.json',
      'public/assets/generated/equipment/weapon/bone-saw.png',
    ]);
    expect([...groups.keys()]).toEqual(['equipment/weapon/bone-saw']);
  });
});

describe('classifyQueueTip', () => {
  const seed: SeedAsset[] = [
    { manifestKey: 'kept-var-0', seed: 'kept' },
    { manifestKey: 'renamed-new-var-0', seed: 'renamed-bytes' },
  ];

  it('classifies every queue path and accounts for all of them', async () => {
    sandbox = makeSandbox(seed);
    const current = sandbox;
    buildQueueBranch(current, (worktree) => {
      // 1. a clean new asset -> safe-request
      writeAsset(worktree, { manifestKey: 'fresh-var-0', seed: 'fresh' });
      // 2. the same bytes under the PRE-rename name -> naming-migration-conflict
      writeAsset(worktree, { manifestKey: 'renamed-old-var-0', seed: 'renamed-bytes' });
      // 3. a PNG with no shard -> invalid-pair
      writeFileAt(worktree, 'public/assets/generated/orphan-var-0.png', 'not-a-pair');
      // 4. a deletion of a path that exists on main -> requires-human
      rmSync(path.join(worktree, 'public', 'assets', 'generated', 'kept-var-0.png'));
      rmSync(path.join(worktree, 'public', 'assets', 'generated', 'entries', 'kept-var-0.json'));
    });

    const report = await classify(current);

    const byKey = new Map(report.groups.map((group) => [group.manifestKey, group]));
    expect(byKey.get('fresh-var-0')?.classification).toBe('safe-request');
    expect(byKey.get('renamed-old-var-0')?.classification).toBe('naming-migration-conflict');
    expect(byKey.get('renamed-old-var-0')?.detail).toContain('renamed-new-var-0');
    expect(byKey.get('orphan-var-0')?.classification).toBe('invalid-pair');
    expect(byKey.get('kept-var-0')?.classification).toBe('requires-human');

    // Acceptance: every changed path is accounted for by exactly one group.
    const accounted = report.groups.flatMap((group) => group.paths).sort();
    const changed = git(
      current.clone,
      'diff',
      '--name-only',
      report.baseSha,
      report.queueTipSha,
      '--',
      'public/assets/generated',
    )
      .split('\n')
      .filter((line) => line !== '')
      .sort();
    expect(accounted).toEqual(changed);
    expect(report.unclassifiedPaths).toEqual([]);
    expect(report.summary['safe-request']).toBe(1);
    expect(report.summary['requires-human']).toBe(1);
  });

  it('flags a shard whose declared contentHash disagrees with its PNG', async () => {
    sandbox = makeSandbox(seed);
    const current = sandbox;
    buildQueueBranch(current, (worktree) => {
      writeAsset(worktree, { manifestKey: 'fresh-var-0', seed: 'fresh' });
      writeFileAt(
        worktree,
        'public/assets/generated/entries/fresh-var-0.json',
        `${JSON.stringify(
          {
            briefId: 'fresh',
            assetPath: 'generated/fresh-var-0.png',
            variantIndex: 0,
            contentHash: 'f'.repeat(64),
          },
          null,
          2,
        )}\n`,
      );
    });

    const report = await classify(current);

    expect(report.groups[0]).toMatchObject({
      manifestKey: 'fresh-var-0',
      classification: 'invalid-pair',
    });
    expect(report.groups[0]?.detail).toContain('contentHash');
  });

  it('classifies annotation deltas per key and never auto-migrates a deleted key', async () => {
    sandbox = makeSandbox(seed);
    const current = sandbox;
    writeFileAt(
      current.clone,
      'public/assets/generated/sprite-editor-annotations.json',
      `${JSON.stringify(
        {
          version: 1,
          sprites: {
            'gone-var-0': { favorite: true, disliked: false, comment: 'on main only' },
            'same-var-0': { favorite: false, disliked: false, comment: 'unchanged' },
          },
        },
        null,
        2,
      )}\n`,
    );
    git(current.clone, 'add', '--all');
    git(current.clone, 'commit', '-m', 'seed annotations');
    git(current.clone, 'push', 'origin', 'HEAD:refs/heads/main');
    git(current.clone, 'fetch', 'origin');

    buildQueueBranch(current, (worktree) => {
      writeFileAt(
        worktree,
        'public/assets/generated/sprite-editor-annotations.json',
        `${JSON.stringify(
          {
            version: 1,
            sprites: {
              'same-var-0': { favorite: false, disliked: false, comment: 'unchanged' },
              'new-var-0': { favorite: true, disliked: false, comment: 'queued edit' },
            },
          },
          null,
          2,
        )}\n`,
      );
    });

    const report = await classify(current);

    const byKey = new Map(report.annotations.map((delta) => [delta.key, delta]));
    expect(byKey.get('new-var-0')?.classification).toBe('safe-request');
    expect(byKey.get('same-var-0')?.classification).toBe('already-on-main');
    expect(byKey.get('gone-var-0')?.classification).toBe('requires-human');
    expect(renderMigrationReport(report)).toContain('"unclassifiedPaths": []');
  });
});
