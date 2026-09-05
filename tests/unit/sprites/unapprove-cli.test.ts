import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeShard } from '../../../scripts/sprites/generated-shards.js';
import { main } from '../../../scripts/sprites/unapprove-cli.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setupVariant() {
  const root = mkdtempSync(path.join(tmpdir(), 'unapprove-cli-'));
  roots.push(root);
  const generatedDir = path.join(root, 'public', 'assets', 'generated');
  const variantId = 'iron-sword-var-1';
  const assetPath = `generated/${variantId}.png`;
  const png = Buffer.from('PNG');
  mkdirSync(generatedDir, { recursive: true });
  writeFileSync(path.join(root, 'public', 'assets', assetPath), png);
  writeShard(generatedDir, variantId, {
    briefId: 'iron-sword',
    spriteName: variantId,
    assetPath,
    approvedAt: '2026-09-05T00:00:00.000Z',
    sourceRun: 'generated/runs/iron-sword/run-1',
    variantIndex: 1,
    contentHash: createHash('sha256').update(png).digest('hex'),
    anchor: null,
    anchors: { hold: null, centerOfGravity: null },
    sensorScore: '7/7',
    judgeScore: '4',
    type: 'weapon',
  });
  return { root, generatedDir, variantId, assetPath };
}

describe('sprites:unapprove durable queue guard', () => {
  it('fails closed when legacy queue inspection is unavailable', async () => {
    const { root, generatedDir, variantId, assetPath } = setupVariant();
    const deps = {
      inspectDurableQueueAsset: async () => ({
        reconciliation: 'new' as const,
        branch: 'assets/queue',
      }),
      withCrossProcessLock: <T>(run: () => Promise<T>) => run(),
    };
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(await main([variantId], root, deps)).toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('Legacy asset-checkin inspection is unavailable'),
    );
    expect(existsSync(path.join(generatedDir, 'entries', `${variantId}.json`))).toBe(true);
    expect(existsSync(path.join(root, 'public', 'assets', assetPath))).toBe(true);
  });

  it('refuses an asset already present on canonical assets/queue', async () => {
    const { root, generatedDir, variantId, assetPath } = setupVariant();
    const inspectDurableQueueAsset = vi.fn(async () => ({
      reconciliation: 'duplicate' as const,
      branch: 'assets/queue',
    }));
    const deps = {
      listQueuedAssets: async () => new Map(),
      inspectDurableQueueAsset,
      withCrossProcessLock: <T>(run: () => Promise<T>) => run(),
    };
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(await main([variantId], root, deps)).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('canonical assets/queue'));
    expect(inspectDurableQueueAsset).toHaveBeenCalledWith(
      expect.objectContaining({ manifestKey: variantId, assetPath }),
    );
    expect(existsSync(path.join(generatedDir, 'entries', `${variantId}.json`))).toBe(true);
    expect(existsSync(path.join(root, 'public', 'assets', assetPath))).toBe(true);
  });
});
