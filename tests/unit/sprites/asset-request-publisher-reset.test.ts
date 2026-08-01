/**
 * Orchestration-level regression for the exhausted-stage reset wiring in
 * `publishSelectedAssetRequests`. Lives in a separate file from
 * `asset-request-publisher.test.ts` because vi.mock is file-scoped:
 * mocking approve.js and queue-commit.js here must not affect other tests.
 *
 * This test seeds a `selected-pending-publish` checkpoint whose `publish`
 * stage is exhausted with `push-retries-exhausted`, then calls
 * `publishSelectedAssetRequests` and asserts the item is published (not
 * skipped). The test FAILS if `resetExhaustedTransientStage` is removed from
 * the publisher, because `runCheckpointStage` would throw
 * "Stage publish is already exhausted" for a stage at max attempts.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Exec } from '../../../scripts/sprites/checkin.js';
import { issueCheckpointKey } from '../../../scripts/sprites/issue-pipeline-checkpoint.js';
import { publishSelectedAssetRequests } from '../../../scripts/sprites/asset-request-publisher.js';
import type { RunStore } from '../../../scripts/sprites/store/types.js';

// Mock approve.js so prepareCheckpoint does not need real sprite run files.
// The mock also creates the shard + PNG that validateExactAssetPayloads expects.
vi.mock('../../../scripts/sprites/approve.js', async () => {
  const { mkdirSync: mkdir, writeFileSync: write } = await import('node:fs');
  const pathLib = await import('node:path');
  const SHARDS_SUBDIR = 'entries';
  return {
    approveVariant: vi.fn((opts: { publicAssetsDir: string }) => {
      const key = 'test-brief-var-0';
      const generatedDir = pathLib.join(opts.publicAssetsDir, 'generated');
      // Shard file: validateExactAssetPayloads checks sourceShardPath exists
      const shardPath = pathLib.join(generatedDir, SHARDS_SUBDIR, `${key}.json`);
      mkdir(pathLib.dirname(shardPath), { recursive: true });
      write(shardPath, `${JSON.stringify({ briefId: 'test-brief', spriteName: key })}\n`);
      // PNG file: validateExactAssetPayloads checks sourcePng exists
      const pngPath = pathLib.join(generatedDir, `${key}.png`);
      mkdir(pathLib.dirname(pngPath), { recursive: true });
      write(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return {
        assetPath: `generated/${key}.png`,
        spriteName: key,
        briefId: 'test-brief',
        variantIndex: 0,
      };
    }),
  };
});

// Mock runQueueCommit to avoid real git push operations.
vi.mock('../../../scripts/sprites/queue-commit.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../scripts/sprites/queue-commit.js')>();
  return {
    ...mod,
    runQueueCommit: vi.fn(async () => ({ branch: 'assets/queue', status: 'committed' })),
  };
});

// Mock createDefaultQueueCommitDeps to avoid real filesystem/git deps setup.
vi.mock('../../../scripts/sprites/queue-commit-runtime.js', () => ({
  createDefaultQueueCommitDeps: vi.fn(() => ({})),
}));

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
      if (!value) throw new Error(`Missing store key: ${key}`);
      return value;
    },
    async has(key) {
      return mem.has(key);
    },
    async list(prefix) {
      return [...mem.keys()].filter((k) => k.startsWith(prefix));
    },
    async remove(key) {
      mem.delete(key);
    },
    resolve(key) {
      return key;
    },
  };
}

describe('publishSelectedAssetRequests — exhausted-stage reset wiring', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('resets an exhausted push-retries-exhausted publish stage and retries the item (published:1, not skipped)', async () => {
    // Minimal repoRoot: only the sprite catalog is required by prepareCheckpoint.
    const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'publisher-reset-test-'));
    roots.push(repoRoot);
    const catalogDir = path.join(repoRoot, 'src', 'shared', 'data');
    mkdirSync(catalogDir, { recursive: true });
    writeFileSync(path.join(catalogDir, 'sprite-catalog.json'), JSON.stringify({ sprites: [] }));

    const store = makeStore();
    const briefId = 'test-brief';
    const runId = 'run-001';

    // Seed a minimal run artifact so store.list(runPrefix) is non-empty.
    store.mem.set(`${briefId}/${runId}/variant-0.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    // Seed a selected-pending-publish checkpoint with an exhausted publish stage.
    // INFRA_RESETTABLE_KINDS contains 'push-retries-exhausted', so this stage
    // will be cleared by resetExhaustedTransientStage before runCheckpointStage runs.
    const checkpointData = {
      version: 1,
      issueNumber: 42,
      fingerprint: 'test-fingerprint',
      stage: 'completed',
      updatedAt: '2026-08-01T00:00:00.000Z',
      stages: {
        publish: {
          status: 'failed',
          attempts: 3,
          updatedAt: '2026-08-01T00:00:00.000Z',
          error: { kind: 'push-retries-exhausted', message: 'push loop exhausted' },
        },
      },
      details: {
        outcome: 'selected-pending-publish',
        briefId,
        runId,
        selectedIndexes: [0],
        selectedAt: '2026-08-01T00:00:00.000Z',
        promotedBriefPath: 'briefs/draft/items/test-brief.yaml',
        promotedBriefYaml: 'id: test-brief\n',
      },
    };
    store.mem.set(
      issueCheckpointKey(42, 'test-fingerprint'),
      Buffer.from(`${JSON.stringify(checkpointData)}\n`),
    );

    // Mock exec to succeed for all git/gh commands used by the publisher.
    const exec: Exec = vi.fn(async (_command, args) => {
      if (args[0] === 'label' && args[1] === 'list') {
        // art-only label already exists — no creation needed.
        return { stdout: '[{"name":"art-only"}]', stderr: '', code: 0 };
      }
      if (args[0] === 'pr' && args[1] === 'list') {
        return {
          stdout: '[{"number":77,"url":"https://example.test/pr/77"}]',
          stderr: '',
          code: 0,
        };
      }
      // git fetch, worktree add/remove, update-ref, gh pr edit, etc.
      return { stdout: '', stderr: '', code: 0 };
    });

    const result = await publishSelectedAssetRequests({ repoRoot, store, exec });

    // The publisher must reset the exhausted stage and successfully publish the item.
    // Removing the resetExhaustedTransientStage call from the publisher would cause
    // runCheckpointStage to throw "already exhausted" and this assertion to fail.
    expect(result).toEqual({ published: 1, skipped: 0 });
  });
});
