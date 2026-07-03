/**
 * Direct unit tests for the brief-durability helpers (mirror / re-materialise).
 *
 * These exercise the fs + store I/O in isolation from the sidecar server so the
 * PATH-LEVEL durability contract — mirror a brief into the store keyed by its
 * repo-relative path, restore it on demand, and stay repo-confined — is pinned
 * without booting Fastify.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  isRepoConfined,
  materializeBriefFromStore,
  mirrorBriefToStore,
  toRepoRelativePath,
} from '../../../scripts/sprites/brief-durability.js';
import { LocalRunStore } from '../../../scripts/sprites/store/local-store.js';
import type { RunStore } from '../../../scripts/sprites/store/types.js';
import { workflowBriefKey } from '../../../scripts/sprites/sidecar/workflow-state.js';

describe('toRepoRelativePath', () => {
  it('returns a POSIX (forward-slash) path relative to the repo root', () => {
    const root = path.resolve('/repo/root');
    const abs = path.join(root, 'briefs', 'draft', 'tiles', 'tile-corridor.yaml');
    expect(toRepoRelativePath(root, abs)).toBe('briefs/draft/tiles/tile-corridor.yaml');
  });

  it('yields a `..`-prefixed path for a location outside the repo root', () => {
    const root = path.resolve('/repo/root');
    const outside = path.resolve('/repo/other/x.yaml');
    expect(toRepoRelativePath(root, outside).startsWith('..')).toBe(true);
  });
});

describe('isRepoConfined', () => {
  it('accepts ordinary repo-relative child paths', () => {
    expect(isRepoConfined('briefs/draft/tiles/tile-corridor.yaml')).toBe(true);
    expect(isRepoConfined('data/palettes/x.json')).toBe(true);
  });

  it('accepts a name that merely STARTS with `..` (no separator) — the old bug', () => {
    // `startsWith('..')` wrongly rejected these legitimate child names.
    expect(isRepoConfined('..foo/x.yaml')).toBe(true);
    expect(isRepoConfined('briefs/..bar.yaml')).toBe(true);
  });

  it('rejects parent-directory escapes', () => {
    expect(isRepoConfined('..')).toBe(false);
    expect(isRepoConfined('../x.yaml')).toBe(false);
    expect(isRepoConfined('../../etc/passwd')).toBe(false);
  });

  it('rejects absolute paths of BOTH flavours regardless of host OS', () => {
    // Deterministic on POSIX CI: a Windows drive / UNC path must still be
    // rejected via the win32 check, and a POSIX-absolute path via the posix one.
    expect(isRepoConfined('/etc/passwd')).toBe(false);
    expect(isRepoConfined('D:/secrets.yaml')).toBe(false);
    expect(isRepoConfined('//server/share/x.yaml')).toBe(false);
  });
});

describe('mirrorBriefToStore / materializeBriefFromStore', () => {
  let root: string;
  let store: LocalRunStore;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'crawler-briefdur-unit-'));
    mkdirSync(path.join(root, 'runs'), { recursive: true });
    store = new LocalRunStore(path.join(root, 'runs'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('mirrors a brief on disk into the store under its path-derived key', async () => {
    const rel = 'briefs/draft/tiles/tile-corridor.yaml';
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    const yaml = 'name: tile-corridor\ntype: tile\n';
    writeFileSync(abs, yaml);

    await mirrorBriefToStore(store, root, abs);

    expect(await store.has(workflowBriefKey(rel))).toBe(true);
    expect((await store.get(workflowBriefKey(rel))).toString('utf8')).toBe(yaml);
  });

  it('is idempotent: re-mirroring writes identical bytes under the same key', async () => {
    const rel = 'briefs/draft/tiles/tile-corridor.yaml';
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    const yaml = 'name: tile-corridor\ntype: tile\n';
    writeFileSync(abs, yaml);

    await mirrorBriefToStore(store, root, abs);
    await mirrorBriefToStore(store, root, abs);

    expect((await store.get(workflowBriefKey(rel))).toString('utf8')).toBe(yaml);
  });

  it('is best-effort: a missing source file neither throws nor writes to the store', async () => {
    const rel = 'briefs/draft/tiles/ghost.yaml';
    const abs = path.join(root, rel);
    await expect(mirrorBriefToStore(store, root, abs)).resolves.toBeUndefined();
    expect(await store.has(workflowBriefKey(rel))).toBe(false);
  });

  it('refuses to mirror a path outside the repo root', async () => {
    const outside = path.join(tmpdir(), `crawler-outside-brief-${process.pid}.yaml`);
    writeFileSync(outside, 'name: nope\n');
    try {
      await mirrorBriefToStore(store, root, outside);
      const key = workflowBriefKey(toRepoRelativePath(root, outside));
      expect(await store.has(key)).toBe(false);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it('materialize returns true without touching the store when the file is already on disk', async () => {
    const rel = 'briefs/draft/tiles/present.yaml';
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, 'name: present\n');
    // The store is empty; success must come purely from the on-disk copy.
    expect(await materializeBriefFromStore(store, root, abs)).toBe(true);
  });

  it('materialize recovers a wiped brief from the store back onto disk', async () => {
    const rel = 'briefs/draft/tiles/tile-corridor.yaml';
    const abs = path.join(root, rel);
    const yaml = 'name: tile-corridor\ntype: tile\n';
    await store.put(workflowBriefKey(rel), Buffer.from(yaml, 'utf8'));
    expect(existsSync(abs)).toBe(false);

    expect(await materializeBriefFromStore(store, root, abs)).toBe(true);
    expect(readFileSync(abs, 'utf8')).toBe(yaml);
  });

  it('materialize returns false when the brief is absent from both disk and store', async () => {
    const abs = path.join(root, 'briefs/draft/tiles/missing.yaml');
    expect(await materializeBriefFromStore(store, root, abs)).toBe(false);
    expect(existsSync(abs)).toBe(false);
  });

  it('materialize returns false for a path outside the repo root', async () => {
    const outside = path.join(tmpdir(), `crawler-outside-materialize-${process.pid}.yaml`);
    expect(await materializeBriefFromStore(store, root, outside)).toBe(false);
  });

  it('mirror then materialize round-trips a brief after a wipe', async () => {
    const rel = 'briefs/draft/tiles/roundtrip.yaml';
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    const yaml = 'name: roundtrip\ntype: tile\n';
    writeFileSync(abs, yaml);
    await mirrorBriefToStore(store, root, abs);

    rmSync(abs, { force: true });
    expect(existsSync(abs)).toBe(false);

    expect(await materializeBriefFromStore(store, root, abs)).toBe(true);
    expect(readFileSync(abs, 'utf8')).toBe(yaml);
  });

  it('materialize THROWS (not false) on a transient store outage so the worker retries', async () => {
    // A brief that IS in the store but whose download errors (network blip) must
    // NOT be reported as a definite miss (`false`) — that would let the worker
    // permanently drop a recoverable job. The error must propagate.
    const transientStore: RunStore = {
      backend: 'local',
      put: async () => {},
      get: async () => {
        throw new Error('network down');
      },
      has: async () => true,
      list: async () => [],
      remove: async () => {},
      resolve: (key) => key,
    };
    const abs = path.join(root, 'briefs/draft/tiles/transient.yaml');
    await expect(materializeBriefFromStore(transientStore, root, abs)).rejects.toThrow(
      'network down',
    );
    expect(existsSync(abs)).toBe(false);
  });

  it('mirror still swallows a transient store.put error (durability lag is recoverable)', async () => {
    const rel = 'briefs/draft/tiles/mirror-fail.yaml';
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, 'name: x\ntype: tile\n');
    const putThrows: RunStore = {
      backend: 'local',
      put: async () => {
        throw new Error('put failed');
      },
      get: async () => Buffer.alloc(0),
      has: async () => false,
      list: async () => [],
      remove: async () => {},
      resolve: (key) => key,
    };
    await expect(mirrorBriefToStore(putThrows, root, abs)).resolves.toBeUndefined();
  });
});
