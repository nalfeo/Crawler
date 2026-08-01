import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeCanonicalPrOnConflict,
  discoverReadyCheckpoints,
  publishSelectedAssetRequests,
  reconcileCanonicalPr,
  validateExactAssetPayloads,
} from '../../../scripts/sprites/asset-request-publisher.js';
import type { CheckinAsset, Exec } from '../../../scripts/sprites/checkin.js';
import { shardPathForKey } from '../../../scripts/sprites/generated-shards.js';
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
  outcome: 'selected-pending-publish' | 'quality-stopped' | 'published',
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
    await store.put(issueCheckpointKey(12, 'fingerprint-12'), checkpoint(12, 'published', true));
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

  it('re-discovers an item whose publish stage completed but terminal mark was not written', async () => {
    // Simulates item A from a failed batch: runCheckpointStage wrote
    // stages.publish.status='completed' but markIssuePipelineTerminal
    // was never called because item B later threw a destination-conflict.
    const store = makeStore();
    await store.put(
      issueCheckpointKey(20, 'fingerprint-20'),
      checkpoint(20, 'selected-pending-publish', /* publishCompleted= */ true),
    );

    const ready = await discoverReadyCheckpoints(store);
    expect(ready).toHaveLength(1);
    expect(ready[0]?.issueNumber).toBe(20);
  });

  it('remains fail-closed and skips a legacy pre-checkpoint status doc (no version/stages), even with stage:"completed"', async () => {
    // The pre-migration pipeline (before commit 49d133cea) wrote a flat
    // status doc with no `version`/`stages` fields. The publisher must never
    // treat this as a publishable v1 result — it fails the strict schema
    // parse and is skipped, exactly like any other malformed checkpoint. The
    // worker-side fix reinitializes such docs to a fresh v1 checkpoint on
    // next reclaim; the publisher itself must not be weakened to accept them.
    const store = makeStore();
    await store.put(
      issueCheckpointKey(30, 'fingerprint-30'),
      Buffer.from(
        JSON.stringify({
          issueNumber: 30,
          fingerprint: 'fingerprint-30',
          stage: 'completed',
          updatedAt: '2026-06-01T00:00:00.000Z',
        }),
      ),
    );

    await expect(discoverReadyCheckpoints(store)).resolves.toEqual([]);
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
    writeFileSync(pngPath, png);
    const shardPath = shardPathForKey(path.join(root, 'public', 'assets', 'generated'), key);
    mkdirSync(path.dirname(shardPath), { recursive: true });
    writeFileSync(
      shardPath,
      JSON.stringify({
        briefId: 'bone-dagger',
        spriteName: key,
        assetPath,
        sourceRun: 'bone-dagger/run-1',
        variantIndex: 0,
        catalog: { description: catalogLabel },
      }),
    );
    return {
      assetPath,
      manifestKey: key,
      briefId: 'bone-dagger',
      variantIndex: 0,
    };
  }

  it('accepts an exact idempotent payload and rejects any shard or PNG difference', async () => {
    const source = mkdtempSync(path.join(os.tmpdir(), 'publisher-source-'));
    const exact = mkdtempSync(path.join(os.tmpdir(), 'publisher-exact-'));
    const conflict = mkdtempSync(path.join(os.tmpdir(), 'publisher-conflict-'));
    const shardOnly = mkdtempSync(path.join(os.tmpdir(), 'publisher-shard-'));
    roots.push(source, exact, conflict, shardOnly);
    const asset = writeSurface(source, 'Bone dagger', Buffer.from([1, 2, 3]));
    writeSurface(exact, 'Bone dagger', Buffer.from([1, 2, 3]));
    writeSurface(conflict, 'Different label', Buffer.from([1, 2, 4]));
    // Identical PNG, differing shard payload — must still be rejected.
    writeSurface(shardOnly, 'Different label', Buffer.from([1, 2, 3]));

    await expect(validateExactAssetPayloads(source, exact, [asset])).resolves.toBeUndefined();
    await expect(validateExactAssetPayloads(source, conflict, [asset])).rejects.toThrow(
      'conflicting payload',
    );
    await expect(validateExactAssetPayloads(source, shardOnly, [asset])).rejects.toThrow(
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

  it('provisions required labels before creating the canonical PR when art-only is missing', async () => {
    const calls: string[][] = [];
    let listCalls = 0;
    let labelEnsured = false;
    const exec: Exec = vi.fn(async (_command, args) => {
      calls.push([...args]);
      if (args[0] === 'pr' && args[1] === 'list') {
        listCalls++;
        return {
          stdout: listCalls === 1 ? '[]' : '[{"number":91,"url":"https://example.test/pr/91"}]',
          stderr: '',
          code: 0,
        };
      }
      if (args[0] === 'label' && args[1] === 'list') {
        return { stdout: '[]', stderr: '', code: 0 };
      }
      if (args[0] === 'label' && args[1] === 'create' && args[2] === 'art-only') {
        labelEnsured = true;
        return { stdout: '', stderr: '', code: 0 };
      }
      if (args[0] === 'pr' && args[1] === 'create') {
        return labelEnsured
          ? { stdout: 'https://example.test/pr/91', stderr: '', code: 0 }
          : {
              stdout: '',
              stderr: "could not add label: 'art-only' not found",
              code: 1,
            };
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    await expect(reconcileCanonicalPr(exec, '/repo', {})).resolves.toMatchObject({ number: 91 });

    const labelCreate = calls.findIndex(
      (args) => args[0] === 'label' && args[1] === 'create' && args[2] === 'art-only',
    );
    const prCreate = calls.findIndex((args) => args[0] === 'pr' && args[1] === 'create');
    expect(labelCreate).toBeGreaterThan(-1);
    expect(prCreate).toBeGreaterThan(-1);
    expect(labelCreate).toBeLessThan(prCreate);
    expect(calls[labelCreate]).toContain('7057ff');
    expect(calls[labelCreate]).toContain(
      'Generated art-only changes eligible for guarded promotion',
    );
    expect(calls[labelCreate]).not.toContain('--force');
  });

  it('does not recreate an existing required label before creating the canonical PR', async () => {
    const calls: string[][] = [];
    let listCalls = 0;
    const exec: Exec = vi.fn(async (_command, args) => {
      calls.push([...args]);
      if (args[0] === 'pr' && args[1] === 'list') {
        listCalls++;
        return {
          stdout: listCalls === 1 ? '[]' : '[{"number":91,"url":"https://example.test/pr/91"}]',
          stderr: '',
          code: 0,
        };
      }
      if (args[0] === 'label' && args[1] === 'list') {
        return {
          stdout: '[{"name":"art-only"}]',
          stderr: '',
          code: 0,
        };
      }
      if (args[0] === 'pr' && args[1] === 'create') {
        return { stdout: 'https://example.test/pr/91', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    await expect(reconcileCanonicalPr(exec, '/repo', {})).resolves.toMatchObject({ number: 91 });
    expect(calls.some((args) => args[0] === 'label' && args[1] === 'create')).toBe(false);
    expect(calls.some((args) => args[0] === 'label' && args[1] === 'list')).toBe(true);
  });

  it('fails before canonical PR creation when required label provisioning fails', async () => {
    const calls: string[][] = [];
    const exec: Exec = vi.fn(async (_command, args) => {
      calls.push([...args]);
      if (args[0] === 'pr' && args[1] === 'list') {
        return { stdout: '[]', stderr: '', code: 0 };
      }
      if (args[0] === 'label' && args[1] === 'list') {
        return { stdout: '[]', stderr: '', code: 0 };
      }
      if (args[0] === 'label' && args[1] === 'create' && args[2] === 'art-only') {
        return { stdout: '', stderr: 'permission denied', code: 1 };
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    await expect(reconcileCanonicalPr(exec, '/repo', {})).rejects.toThrow(
      'gh label create art-only --color 7057ff --description ' +
        '"Generated art-only changes eligible for guarded promotion"',
    );
    expect(calls.some((args) => args[0] === 'pr' && args[1] === 'create')).toBe(false);
  });
});

describe('asset-request publication path safety', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('rejects traversal in promotedBriefPath before writing to disk', async () => {
    const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'publisher-repo-'));
    roots.push(repoRoot);
    mkdirSync(path.join(repoRoot, 'src', 'shared', 'data'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'src', 'shared', 'data', 'sprite-catalog.json'), '[]\n');

    const store = makeStore();
    const issueNumber = 77;
    const fingerprint = `fingerprint-${issueNumber}`;
    await store.put(
      issueCheckpointKey(issueNumber, fingerprint),
      Buffer.from(
        JSON.stringify({
          version: 1,
          issueNumber,
          fingerprint,
          stage: 'completed',
          stages: {},
          details: {
            outcome: 'selected-pending-publish',
            briefId: `brief-${issueNumber}`,
            runId: `run-${issueNumber}`,
            selectedIndexes: [0],
            selectedAt: '2026-07-24T00:00:00.000Z',
            promotedBriefPath: 'briefs/draft/items/../../../../escape.yaml',
            promotedBriefYaml: 'id: exploit\n',
          },
          updatedAt: '2026-07-24T00:00:00.000Z',
        }),
      ),
    );

    await expect(publishSelectedAssetRequests({ repoRoot, store })).rejects.toMatchObject({
      kind: 'invalid-brief-path',
    });
  });
});
