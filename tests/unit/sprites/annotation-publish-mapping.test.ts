/**
 * The annotation-publish contract between a disliked-asset lifecycle plan and
 * the durable `assets/queue` tip.
 *
 * `mergeSpriteAnnotationUpdates` distinguishes an ABSENT field from an explicit
 * `undefined`: absent PRESERVES whatever the queue tip already holds, explicit
 * `undefined` DELETES it. Every publication mapper therefore has to preserve
 * own-property-ness exactly. A mapper that unconditionally wrote
 * `tombstone: undefined` erased tombstones another worktree had already
 * published — silently un-recording a deletion, which breaks tombstone closure
 * on the tip while every local check still passes.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { toQueueCommitAnnotationUpdates } from '../../../scripts/sprites/disliked-lifecycle.js';
import { mergeSpriteAnnotationUpdates } from '../../../scripts/sprites/queue-commit-runtime.js';

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const ANNOTATIONS_RELATIVE_PATH = 'public/assets/generated/sprite-editor-annotations.json';

const QUEUE_TIP_TOMBSTONE = {
  manifestKey: 'rat-var-0',
  conceptId: 'rat',
  assetPath: 'generated/rat-var-0.png',
  sourceRun: 'generated/runs/rat/run-0',
  variantIndex: 0,
  annotationKeys: ['rat-var-0'],
};

/** A worktree whose queue tip already records one published deletion. */
function makeQueueTip(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'annotation-publish-'));
  roots.push(root);
  const target = path.join(root, ...ANNOTATIONS_RELATIVE_PATH.split('/'));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(
    target,
    `${JSON.stringify(
      {
        version: 1,
        sprites: {
          'rat-var-0': {
            favorite: false,
            disliked: true,
            comment: '',
            tombstone: QUEUE_TIP_TOMBSTONE,
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

function readTip(root: string): Record<string, Record<string, unknown>> {
  return (
    JSON.parse(readFileSync(path.join(root, ...ANNOTATIONS_RELATIVE_PATH.split('/')), 'utf8')) as {
      sprites: Record<string, Record<string, unknown>>;
    }
  ).sprites;
}

describe('lifecycle annotation → queue-commit publication mapping', () => {
  it('omits tombstone entirely for an update that never owned the field', () => {
    const [mapped] = toQueueCommitAnnotationUpdates([{ key: 'rat-var-0', disliked: true }]);

    expect(mapped).toBeDefined();
    expect(Object.hasOwn(mapped!, 'tombstone')).toBe(false);
    // The other publication fields still get their explicit defaults.
    expect(mapped).toMatchObject({
      key: 'rat-var-0',
      favorite: false,
      disliked: true,
      comment: '',
    });
  });

  it('forwards an explicit tombstone CLEAR as an owned undefined', () => {
    const [mapped] = toQueueCommitAnnotationUpdates([
      { key: 'rat-var-0', disliked: false, tombstone: undefined },
    ]);

    expect(Object.hasOwn(mapped!, 'tombstone')).toBe(true);
    expect(mapped!.tombstone).toBeUndefined();
  });

  it('clones a written tombstone instead of aliasing the plan object', () => {
    const [mapped] = toQueueCommitAnnotationUpdates([
      { key: 'rat-var-0', disliked: true, tombstone: QUEUE_TIP_TOMBSTONE },
    ]);

    expect(mapped!.tombstone).toEqual(QUEUE_TIP_TOMBSTONE);
    expect(mapped!.tombstone).not.toBe(QUEUE_TIP_TOMBSTONE);
  });

  it('preserves a queue-tip tombstone when the published update does not own one', async () => {
    const root = makeQueueTip();

    await mergeSpriteAnnotationUpdates(
      root,
      toQueueCommitAnnotationUpdates([
        // A comment-only edit from a worktree whose local annotations predate
        // the deletion another worktree already published.
        { key: 'rat-var-0', disliked: true, comment: 'still bad' },
      ]),
    );

    expect(readTip(root)['rat-var-0']?.tombstone).toEqual(QUEUE_TIP_TOMBSTONE);
    expect(readTip(root)['rat-var-0']?.comment).toBe('still bad');
  });

  it('clears a queue-tip tombstone when the accepted replacement explicitly clears it', async () => {
    const root = makeQueueTip();

    await mergeSpriteAnnotationUpdates(
      root,
      toQueueCommitAnnotationUpdates([
        { key: 'rat-var-0', favorite: false, disliked: false, comment: '', tombstone: undefined },
      ]),
    );

    expect(Object.hasOwn(readTip(root)['rat-var-0']!, 'tombstone')).toBe(false);
    expect(readTip(root)['rat-var-0']?.disliked).toBe(false);
  });

  it('applies the same preserve-vs-clear rule to reconciliation markers', async () => {
    const root = makeQueueTip();
    await mergeSpriteAnnotationUpdates(root, [
      {
        key: 'rat-var-0',
        favorite: false,
        disliked: true,
        comment: '',
        reconciliation: { outcome: 'unmatched', annotationKey: 'rat-var-0' },
      },
    ]);

    await mergeSpriteAnnotationUpdates(
      root,
      toQueueCommitAnnotationUpdates([{ key: 'rat-var-0', disliked: true, comment: 'touch' }]),
    );

    expect(readTip(root)['rat-var-0']?.reconciliation).toEqual({
      outcome: 'unmatched',
      annotationKey: 'rat-var-0',
    });
  });
});
