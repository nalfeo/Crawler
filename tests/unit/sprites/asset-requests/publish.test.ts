/**
 * Real-git tests for publishing immutable asset request refs.
 *
 * Proves the properties a mocked exec cannot: the request ref carries ONLY its
 * declared payload, republishing is byte-identical (deterministic replay), the
 * caller's branch/index/HEAD are untouched, and a PNG whose bytes disagree with
 * its declared `contentHash` never reaches the object database.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  requestBranchName,
  sealAssetRequest,
  type AssetRequestManifestBody,
} from '../../../../scripts/sprites/asset-requests/manifest.js';
import {
  publishAssetRequest,
  PublishRequestError,
} from '../../../../scripts/sprites/asset-requests/publish.js';
import { createDefaultPublishDeps } from '../../../../scripts/sprites/asset-requests/runtime.js';
import { git, makeSandbox, originMain, pngHash, writeAsset, type Sandbox } from './harness.js';

let sandbox: Sandbox | undefined;

afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

function upsertBody(observedMainSha: string, seed = 'new-asset'): AssetRequestManifestBody {
  return {
    version: 1,
    operation: 'upsert-asset',
    assets: [
      {
        assetPath: 'generated/brass-lantern-var-1.png',
        manifestKey: 'brass-lantern-var-1',
        contentHash: pngHash(seed),
        briefId: 'brass-lantern',
        variantIndex: 1,
        sourceRun: null,
      },
    ],
    annotations: [],
    removals: [],
    observedMainSha,
    producer: 'approve-cli',
    provenance: { origin: 'unit-test' },
    supersedes: null,
  };
}

describe('publishAssetRequest', () => {
  it('publishes an orphan ref carrying only the manifest and its declared payload', async () => {
    sandbox = makeSandbox([{ manifestKey: 'existing-var-1', seed: 'existing' }]);
    const main = originMain(sandbox.clone);
    writeAsset(sandbox.clone, {
      manifestKey: 'brass-lantern-var-1',
      seed: 'new-asset',
      briefId: 'brass-lantern',
      variantIndex: 1,
    });

    const branchBefore = git(sandbox.clone, 'rev-parse', 'HEAD');
    const result = await publishAssetRequest(
      sandbox.clone,
      upsertBody(main),
      createDefaultPublishDeps(),
    );

    expect(result.status).toBe('created');
    expect(result.branch).toBe(requestBranchName(result.requestId));

    // The request commit is an ORPHAN: nothing from main is inherited, so a
    // request structurally cannot carry bytes it did not declare.
    expect(git(sandbox.clone, 'rev-list', '--count', result.commit)).toBe('1');
    const tree = git(sandbox.clone, 'ls-tree', '-r', '--name-only', result.commit).split('\n');
    expect(tree.sort()).toEqual([
      `assets/requests/${result.requestId}.json`,
      'public/assets/generated/brass-lantern-var-1.png',
      'public/assets/generated/entries/brass-lantern-var-1.json',
    ]);

    // The ref really landed on the remote, and the caller's HEAD never moved.
    expect(git(sandbox.clone, 'ls-remote', 'origin', `refs/heads/${result.branch}`)).toContain(
      result.commit,
    );
    expect(git(sandbox.clone, 'rev-parse', 'HEAD')).toBe(branchBefore);
  });

  it('is idempotent: republishing the same payload yields the identical commit', async () => {
    sandbox = makeSandbox();
    const main = originMain(sandbox.clone);
    writeAsset(sandbox.clone, {
      manifestKey: 'brass-lantern-var-1',
      seed: 'new-asset',
      briefId: 'brass-lantern',
      variantIndex: 1,
    });

    const first = await publishAssetRequest(
      sandbox.clone,
      upsertBody(main),
      createDefaultPublishDeps(),
    );
    const second = await publishAssetRequest(
      sandbox.clone,
      upsertBody(main),
      createDefaultPublishDeps(),
    );

    expect(second.status).toBe('already-published');
    expect(second.commit).toBe(first.commit);
    expect(second.requestId).toBe(first.requestId);
  });

  it('refuses a PNG whose bytes do not hash to the declared contentHash', async () => {
    sandbox = makeSandbox();
    const main = originMain(sandbox.clone);
    writeAsset(sandbox.clone, {
      manifestKey: 'brass-lantern-var-1',
      seed: 'DIFFERENT-BYTES',
      briefId: 'brass-lantern',
      variantIndex: 1,
    });

    await expect(
      publishAssetRequest(sandbox.clone, upsertBody(main), createDefaultPublishDeps()),
    ).rejects.toMatchObject({ kind: 'payload-hash-mismatch' });

    const branch = requestBranchName(sealAssetRequest(upsertBody(main)).requestId);
    expect(git(sandbox.clone, 'ls-remote', 'origin', `refs/heads/${branch}`)).toBe('');
  });

  it('refuses when a declared payload file is missing', async () => {
    sandbox = makeSandbox();
    const main = originMain(sandbox.clone);
    await expect(
      publishAssetRequest(sandbox.clone, upsertBody(main), createDefaultPublishDeps()),
    ).rejects.toBeInstanceOf(PublishRequestError);
  });
});
