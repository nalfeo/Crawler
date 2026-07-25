import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeCanonicalPrOnConflict,
  discoverReadyCheckpoints,
  reconcileCanonicalPr,
  validateExactAssetPayloads,
} from '../../../scripts/sprites/asset-request-publisher.js';
import type { CheckinAsset, Exec } from '../../../scripts/sprites/checkin.js';
import { issueCheckpointKey } from '../../../scripts/sprites/issue-pipeline-checkpoint.js';
import type { RunStore } from '../../../scripts/sprites/store/types.js';

function makeStore(): RunStore & { mem: Map<string, Buffer> } {
  const mem = new Map<string, Buffer>();
  return {
    mem,
    backend: 'local',
    async put(key, data) {
      mem.set(key, data);
    },
    async get(key) {
      const value = mem.get(key);
      if (!value) throw new Error(`Missing ${key}`);
      return value;
    },
    async has(key) {
      return mem.has(key);
    },
    async list(prefix) {
      return [...mem.keys()].filter((key) => key.startsWith(prefix));
    },
    async remove(key) {
      mem.delete(key);
    },
    resolve(key) {
      return key;
    },
  };
}

function checkpoint(
  issueNumber: number,
  outcome: 'selected-pending-publish' | 'quality-stopped',
  publishCompleted = false,
): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      issueNumber,
      fingerprint: `fingerprint-${issueNumber}`,
      stage: 'completed',
      stages: {
        ...(publishCompleted
          ? {
              publish: {
                status: 'completed',
                attempts: 1,
                updatedAt: '2026-07-24T00:00:00.000Z',
                output: { commit: 'abc123', publishedAt: '2026-07-24T00:00:00.000Z' },
              },
            }
          : {}),
      },
      details: {
        outcome,
        briefId: `brief-${issueNumber}`,
        runId: `run-${issueNumber}`,
        selectedIndexes: [0, 2],
        selectedAt: '2026-07-24T00:00:00.000Z',
        promotedBriefPath: `briefs/draft/items/brief-${issueNumber}.yaml`,
        promotedBriefYaml: `id: brief-${issueNumber}\n`,
      },
      updatedAt: '2026-07-24T00:00:00.000Z',
    }),
  );
}

describe('asset-request publication discovery', () => {
  it('authoritatively returns only selected terminal checkpoints still awaiting publication', async () => {
    const store = makeStore();
    await store.put(issueCheckpointKey(10, 'fingerprint-10'), checkpoint(10, 'quality-stopped'));
    await store.put(
      issueCheckpointKey(11, 'fingerprint-11'),
      checkpoint(11, 'selected-pending-publish'),
    );
    await store.put(
      issueCheckpointKey(12, 'fingerprint-12'),
      checkpoint(12, 'selected-pending-publish', true),
    );
    await store.put(issueCheckpointKey(13, 'fingerprint-13'), Buffer.from('{truncated'));

    await expect(discoverReadyCheckpoints(store)).resolves.toEqual([
      expect.objectContaining({
        issueNumber: 11,
        details: expect.objectContaining({
          briefId: 'brief-11',
          runId: 'run-11',
          selectedIndexes: [0, 2],
        }),
      }),
    ]);
  });
});

describe('exact generated-asset collision validation', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function writeSurface(root: string, catalogLabel: string, png: Buffer): CheckinAsset {
    const key = 'bone-dagger-var-0';
    const assetPath = `generated/${key}.png`;
    const pngPath = path.join(root, 'public', 'assets', 'generated', `${key}.png`);
    mkdirSync(path.dirname(pngPath), { recursive: true });
    mkdirSync(path.join(root, 'src', 'shared', 'data'), { recursive: true });
    writeFileSync(pngPath, png);
    writeFileSync(
      path.join(root, 'public', 'assets', 'generated', 'manifest.json'),
      JSON.stringify({
        version: 1,
        entries: {
          [key]: {
            briefId: 'bone-dagger',
            spriteName: key,
            assetPath,
            sourceRun: 'bone-dagger/run-1',
            variantIndex: 0,
          },
        },
      }),
    );
    writeFileSync(
      path.join(root, 'src', 'shared', 'data', 'sprite-catalog.json'),
      JSON.stringify([
        { id: `generated:${key}`, label: catalogLabel, path: `/assets/${assetPath}` },
      ]),
    );
    return {
      assetPath,
      manifestKey: key,
      briefId: 'bone-dagger',
      variantIndex: 0,
    };
  }

  it('accepts an exact idempotent payload and rejects any catalog or PNG difference', async () => {
    const source = mkdtempSync(path.join(os.tmpdir(), 'publisher-source-'));
    const exact = mkdtempSync(path.join(os.tmpdir(), 'publisher-exact-'));
    const conflict = mkdtempSync(path.join(os.tmpdir(), 'publisher-conflict-'));
    roots.push(source, exact, conflict);
    const asset = writeSurface(source, 'Bone dagger', Buffer.from([1, 2, 3]));
    writeSurface(exact, 'Bone dagger', Buffer.from([1, 2, 3]));
    writeSurface(conflict, 'Different label', Buffer.from([1, 2, 4]));

    await expect(validateExactAssetPayloads(source, exact, [asset])).resolves.toBeUndefined();
    await expect(validateExactAssetPayloads(source, conflict, [asset])).rejects.toThrow(
      'conflicting payload',
    );
  });
});

describe('canonical generated-art PR reconciliation', () => {
  it('updates the single existing PR instead of creating a duplicate', async () => {
    const calls: string[][] = [];
    const exec: Exec = vi.fn(async (_command, args) => {
      calls.push([...args]);
      if (args[0] === 'pr' && args[1] === 'list') {
        return {
          stdout: '[{"number":77,"url":"https://example.test/pr/77"}]',
          stderr: '',
          code: 0,
        };
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    await expect(reconcileCanonicalPr(exec, '/repo', {})).resolves.toMatchObject({ number: 77 });
    expect(calls.some((args) => args[0] === 'pr' && args[1] === 'edit')).toBe(true);
    expect(calls.some((args) => args[0] === 'pr' && args[1] === 'create')).toBe(false);
  });

  it('fails closed when more than one canonical PR is open', async () => {
    const exec: Exec = vi.fn(async () => ({
      stdout: JSON.stringify([
        { number: 77, url: 'https://example.test/pr/77' },
        { number: 78, url: 'https://example.test/pr/78' },
      ]),
      stderr: '',
      code: 0,
    }));

    await expect(reconcileCanonicalPr(exec, '/repo', {})).rejects.toThrow(
      'Expected at most one open assets/queue PR',
    );
  });

  it('comments on and closes a stale canonical PR after a destination conflict', async () => {
    const calls: string[][] = [];
    const exec: Exec = vi.fn(async (_command, args) => {
      calls.push([...args]);
      if (args[0] === 'pr' && args[1] === 'list') {
        return {
          stdout: '[{"number":77,"url":"https://example.test/pr/77"}]',
          stderr: '',
          code: 0,
        };
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    await closeCanonicalPrOnConflict(exec, '/repo', new Error('payload differs'));
    expect(calls.some((args) => args[0] === 'pr' && args[1] === 'comment')).toBe(true);
    expect(calls.some((args) => args[0] === 'pr' && args[1] === 'close')).toBe(true);
  });
});
