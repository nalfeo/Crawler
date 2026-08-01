import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRecordedReferencePngs } from '../../../scripts/sprites/load-reference-pngs.js';
import type {
  ReferenceSpriteRef,
  ReferenceSpriteSelection,
  RunSummary,
  SeedFrameRef,
} from '../../../scripts/sprites/run-artifacts.js';

const REPO_ROOT = '/repo';

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A recorded reference whose on-disk bytes match its `contentHash`. */
function ref(over: Partial<ReferenceSpriteRef> & { spriteName: string }): ReferenceSpriteRef {
  const { spriteName, ...rest } = over;
  const bytes = Buffer.from(`png-bytes:${spriteName}`);
  return {
    briefId: `${spriteName}-brief`,
    spriteName,
    type: 'item',
    assetPath: `generated/${spriteName}.png`,
    sensorScore: '9/10',
    judgeScore: '4',
    contentHash: sha256(bytes),
    ...rest,
  };
}

function selection(
  selected: ReferenceSpriteRef[],
  over: Partial<ReferenceSpriteSelection> = {},
): ReferenceSpriteSelection {
  return {
    selectorVersion: 'v1',
    seed: 123,
    requestedCount: 3,
    eligibleCount: selected.length,
    sameTypeCount: selected.length,
    selected,
    ...over,
  };
}

function summary(
  referenceSprites: ReferenceSpriteSelection | undefined,
  seedFrames?: ReadonlyArray<SeedFrameRef>,
): Pick<RunSummary, 'brief' | 'referenceSprites' | 'seedFrames'> {
  return { brief: 'subject-lamp-v1', referenceSprites, ...(seedFrames ? { seedFrames } : {}) };
}

/** In-memory fake filesystem keyed by absolute path. */
function fakeFs(files: Record<string, Buffer>): {
  readReference: (p: string) => Buffer;
  assetExists: (p: string) => boolean;
} {
  return {
    readReference: (p) => {
      const bytes = files[p];
      if (!bytes) {
        throw new Error(`fakeFs: unexpected read of ${p}`);
      }
      return bytes;
    },
    assetExists: (p) => p in files,
  };
}

function absOf(spriteName: string): string {
  return path.resolve(REPO_ROOT, 'public', 'assets', `generated/${spriteName}.png`);
}

function absSeedOf(seedPath: string): string {
  return path.resolve(REPO_ROOT, seedPath);
}

describe('loadRecordedReferencePngs', () => {
  it('replays the recorded selection, resolving under public/assets, in order', () => {
    const a = ref({ spriteName: 'lamp-a' });
    const b = ref({ spriteName: 'chest-b' });
    const files = {
      [absOf('lamp-a')]: Buffer.from('png-bytes:lamp-a'),
      [absOf('chest-b')]: Buffer.from('png-bytes:chest-b'),
    };
    const fs = fakeFs(files);

    const buffers = loadRecordedReferencePngs({
      summary: summary(selection([a, b])),
      repoRoot: REPO_ROOT,
      readReference: fs.readReference,
      assetExists: fs.assetExists,
    });

    expect(buffers).toHaveLength(2);
    expect(buffers[0]!.toString()).toBe('png-bytes:lamp-a');
    expect(buffers[1]!.toString()).toBe('png-bytes:chest-b');
  });

  it('never resolves a path outside generated/ (all recorded refs are our own art)', () => {
    const a = ref({ spriteName: 'lamp-a' });
    const seenPaths: string[] = [];
    const buffers = loadRecordedReferencePngs({
      summary: summary(selection([a])),
      repoRoot: REPO_ROOT,
      assetExists: (p) => {
        seenPaths.push(p);
        return true;
      },
      readReference: () => Buffer.from('png-bytes:lamp-a'),
      hashBytes: () => a.contentHash as string,
    });

    expect(buffers).toHaveLength(1);
    expect(seenPaths).toHaveLength(1);
    expect(seenPaths[0]).toContain(path.join('public', 'assets', 'generated'));
    expect(seenPaths[0]).not.toContain('kenney');
  });

  it('skips hash verification for legacy refs with a null contentHash', () => {
    const legacy = ref({ spriteName: 'legacy-a', contentHash: null });
    let hashed = false;
    const buffers = loadRecordedReferencePngs({
      summary: summary(selection([legacy])),
      repoRoot: REPO_ROOT,
      assetExists: () => true,
      readReference: () => Buffer.from('whatever-bytes'),
      hashBytes: () => {
        hashed = true;
        return 'unused';
      },
    });

    expect(buffers).toHaveLength(1);
    expect(buffers[0]!.toString()).toBe('whatever-bytes');
    expect(hashed).toBe(false);
  });

  it('verifies contentHash with the default SHA-256 hasher on the happy path', () => {
    const a = ref({ spriteName: 'lamp-a' });
    const buffers = loadRecordedReferencePngs({
      summary: summary(selection([a])),
      repoRoot: REPO_ROOT,
      assetExists: () => true,
      readReference: () => Buffer.from('png-bytes:lamp-a'),
    });
    expect(buffers[0]!.toString()).toBe('png-bytes:lamp-a');
  });

  it('throws when the run has no recorded referenceSprites (legacy pre-retirement run)', () => {
    expect(() =>
      loadRecordedReferencePngs({
        summary: summary(undefined),
        repoRoot: REPO_ROOT,
        assetExists: () => true,
        readReference: () => Buffer.alloc(0),
      }),
    ).toThrow(/no recorded referenceSprites/);
  });

  it('throws when the recorded selection is empty', () => {
    expect(() =>
      loadRecordedReferencePngs({
        summary: summary(selection([])),
        repoRoot: REPO_ROOT,
        assetExists: () => true,
        readReference: () => Buffer.alloc(0),
      }),
    ).toThrow(/no recorded referenceSprites/);
  });

  it('throws when a recorded reference asset is missing on disk', () => {
    const a = ref({ spriteName: 'lamp-a' });
    expect(() =>
      loadRecordedReferencePngs({
        summary: summary(selection([a])),
        repoRoot: REPO_ROOT,
        assetExists: () => false,
        readReference: () => Buffer.from('png-bytes:lamp-a'),
      }),
    ).toThrow(/is missing on disk/);
  });

  it('throws on content-hash drift (asset changed since the run was generated)', () => {
    const a = ref({ spriteName: 'lamp-a' });
    expect(() =>
      loadRecordedReferencePngs({
        summary: summary(selection([a])),
        repoRoot: REPO_ROOT,
        assetExists: () => true,
        readReference: () => Buffer.from('different-bytes-now'),
      }),
    ).toThrow(/content hash drifted/);
  });

  it('throws on an unsafe/escaping recorded assetPath before touching the filesystem', () => {
    // A tampered or corrupt summary must not read outside the generated tree.
    const escaping = ref({
      spriteName: 'evil',
      contentHash: null,
      assetPath: 'generated/../kenney/roguelike/spritesheet.png',
    });
    expect(() =>
      loadRecordedReferencePngs({
        summary: summary(selection([escaping])),
        repoRoot: REPO_ROOT,
        assetExists: () => {
          throw new Error('assetExists must not be called for an unsafe path');
        },
        readReference: () => {
          throw new Error('readReference must not be called for an unsafe path');
        },
      }),
    ).toThrow(/unsafe/);
  });
});

describe('loadRecordedReferencePngs — seed frame replay', () => {
  const SEED_PATH = 'briefs/seeds/frame0.png';
  const SEED_BYTES = Buffer.from('seed-frame-bytes');
  const SEED_HASH = sha256(SEED_BYTES);

  function seedRef(over: Partial<SeedFrameRef> = {}): SeedFrameRef {
    return { path: SEED_PATH, contentHash: SEED_HASH, ...over };
  }

  it('prepends seed frames before style references in the returned list', () => {
    const a = ref({ spriteName: 'lamp-a' });
    const files = {
      [absSeedOf(SEED_PATH)]: SEED_BYTES,
      [absOf('lamp-a')]: Buffer.from('png-bytes:lamp-a'),
    };
    const fs = fakeFs(files);

    const buffers = loadRecordedReferencePngs({
      summary: summary(selection([a]), [seedRef()]),
      repoRoot: REPO_ROOT,
      readReference: fs.readReference,
      assetExists: fs.assetExists,
    });

    expect(buffers).toHaveLength(2);
    expect(buffers[0]).toBe(SEED_BYTES);
    expect(buffers[1]!.toString()).toBe('png-bytes:lamp-a');
  });

  it('verifies seed frame content hash and throws on drift', () => {
    const a = ref({ spriteName: 'lamp-a' });
    expect(() =>
      loadRecordedReferencePngs({
        summary: summary(selection([a]), [seedRef({ contentHash: 'wrong-hash' })]),
        repoRoot: REPO_ROOT,
        assetExists: () => true,
        readReference: () => SEED_BYTES,
        hashBytes: () => SEED_HASH,
      }),
    ).toThrow(/content hash drifted/);
  });

  it('throws when a seed frame is missing on disk', () => {
    const a = ref({ spriteName: 'lamp-a' });
    expect(() =>
      loadRecordedReferencePngs({
        summary: summary(selection([a]), [seedRef()]),
        repoRoot: REPO_ROOT,
        assetExists: (p) => !p.includes('frame0'),
        readReference: () => Buffer.alloc(0),
      }),
    ).toThrow(/is missing on disk/);
  });

  it('throws when a recorded seed frame path escapes the briefs/ directory', () => {
    const a = ref({ spriteName: 'lamp-a' });
    const tampered = seedRef({ path: '../outside/secret.txt' });
    expect(() =>
      loadRecordedReferencePngs({
        summary: summary(selection([a]), [tampered]),
        repoRoot: REPO_ROOT,
        assetExists: () => {
          throw new Error('assetExists must not be called for an unsafe seed path');
        },
        readReference: () => {
          throw new Error('readReference must not be called for an unsafe seed path');
        },
      }),
    ).toThrow(/resolves outside the approved seed directory/);
  });

  it('returns only style references when no seed frames are recorded', () => {
    const a = ref({ spriteName: 'lamp-a' });
    const buffers = loadRecordedReferencePngs({
      summary: summary(selection([a])),
      repoRoot: REPO_ROOT,
      assetExists: () => true,
      readReference: () => Buffer.from('png-bytes:lamp-a'),
      hashBytes: () => a.contentHash as string,
    });
    expect(buffers).toHaveLength(1);
    expect(buffers[0]!.toString()).toBe('png-bytes:lamp-a');
  });
});
