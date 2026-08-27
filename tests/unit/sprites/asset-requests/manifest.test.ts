/**
 * Contract tests for the sealed asset-request manifest.
 *
 * These are the pure, fail-closed rules that make a request independently
 * verifiable: content-derived identity (so replay is deterministic and a sealed
 * request cannot be edited in place), atomic PNG+shard identity, per-key
 * annotation payloads, and duplicate-proof-bound removals.
 */

import { describe, expect, it } from 'vitest';
import {
  ANNOTATIONS_PATH,
  AssetRequestError,
  archiveBranchName,
  canonicalJson,
  computeRequestId,
  declaredRequestPaths,
  destinationUnits,
  parseAssetRequest,
  requestBranchName,
  requestIdFromRef,
  sealAssetRequest,
  serializeAssetRequest,
  type AssetRequestManifestBody,
} from '../../../../scripts/sprites/asset-requests/manifest.js';

const MAIN_SHA = 'a'.repeat(40);
const HASH = 'b'.repeat(64);

function upsertBody(overrides: Partial<AssetRequestManifestBody> = {}): AssetRequestManifestBody {
  return {
    version: 1,
    operation: 'upsert-asset',
    assets: [
      {
        assetPath: 'generated/skull-mace-var-2.png',
        manifestKey: 'skull-mace-var-2',
        contentHash: HASH,
        briefId: 'skull-mace',
        variantIndex: 2,
        sourceRun: 'generated/runs/skull-mace/2026-08-01',
      },
    ],
    annotations: [],
    removals: [],
    observedMainSha: MAIN_SHA,
    producer: 'approve-cli',
    provenance: { workflow: 'local' },
    supersedes: null,
    ...overrides,
  };
}

describe('canonicalJson', () => {
  it('is independent of key insertion order at every depth', () => {
    const a = { z: 1, a: { y: [1, { b: 2, a: 3 }], x: 'v' } };
    const b = { a: { x: 'v', y: [1, { a: 3, b: 2 }] }, z: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });
});

describe('request identity', () => {
  it('derives the same id for a structurally identical body (deterministic replay)', () => {
    const reordered: AssetRequestManifestBody = {
      ...upsertBody(),
      provenance: { workflow: 'local' },
    };
    expect(computeRequestId(upsertBody())).toBe(computeRequestId(reordered));
  });

  it('changes the id when ANY payload field changes', () => {
    const base = computeRequestId(upsertBody());
    expect(computeRequestId(upsertBody({ observedMainSha: 'c'.repeat(40) }))).not.toBe(base);
    expect(
      computeRequestId(
        upsertBody({
          assets: [{ ...upsertBody().assets[0]!, contentHash: 'd'.repeat(64) }],
        }),
      ),
    ).not.toBe(base);
  });

  it('round-trips through serialize/parse', () => {
    const manifest = sealAssetRequest(upsertBody());
    expect(parseAssetRequest(serializeAssetRequest(manifest))).toEqual(manifest);
  });

  it('rejects a hand-edited (tampered) manifest whose id no longer matches', () => {
    const manifest = sealAssetRequest(upsertBody());
    const tampered = serializeAssetRequest({
      ...manifest,
      assets: [{ ...manifest.assets[0]!, contentHash: 'e'.repeat(64) }],
    });
    expect(() => parseAssetRequest(tampered)).toThrowError(AssetRequestError);
    try {
      parseAssetRequest(tampered);
    } catch (error) {
      expect((error as AssetRequestError).kind).toBe('invalid-request-id');
    }
  });

  it('maps ids onto request and archive branches, and back', () => {
    const manifest = sealAssetRequest(upsertBody());
    const branch = requestBranchName(manifest.requestId);
    expect(branch).toBe(`assets/request/${manifest.requestId}`);
    expect(requestIdFromRef(`refs/heads/${branch}`)).toBe(manifest.requestId);
    expect(archiveBranchName(manifest.requestId)).toBe(
      `assets/archive/request/${manifest.requestId}`,
    );
    expect(requestIdFromRef('refs/heads/assets/queue')).toBeNull();
    expect(requestIdFromRef('refs/heads/assets/request/not-a-hash')).toBeNull();
  });
});

describe('manifest validation (fail closed)', () => {
  it('rejects a traversal-escaping assetPath', () => {
    expect(() =>
      sealAssetRequest(
        upsertBody({
          assets: [{ ...upsertBody().assets[0]!, assetPath: 'generated/../kenney/tiles.png' }],
        }),
      ),
    ).toThrowError(/traversal-free/);
  });

  it('rejects a manifest key that escapes the shards directory', () => {
    expect(() =>
      sealAssetRequest(
        upsertBody({ assets: [{ ...upsertBody().assets[0]!, manifestKey: '../../evil' }] }),
      ),
    ).toThrowError(/unsafe segment/);
  });

  it('rejects a non-sha256 contentHash', () => {
    expect(() =>
      sealAssetRequest(
        upsertBody({ assets: [{ ...upsertBody().assets[0]!, contentHash: 'deadbeef' }] }),
      ),
    ).toThrowError(/contentHash/);
  });

  it('rejects a request that populates more than one payload array', () => {
    expect(() =>
      sealAssetRequest(
        upsertBody({
          annotations: [{ key: 'skull-mace-var-2', favorite: true, disliked: false, comment: '' }],
        }),
      ),
    ).toThrowError(/exactly one payload array/);
  });

  it('rejects an observed main SHA that is not a full commit id', () => {
    expect(() => sealAssetRequest(upsertBody({ observedMainSha: 'abc' }))).toThrowError(
      /observedMainSha/,
    );
  });

  it('rejects a removal whose duplicate proof names the removed path itself', () => {
    expect(() =>
      sealAssetRequest({
        ...upsertBody(),
        operation: 'remove-asset',
        assets: [],
        removals: [
          {
            assetPath: 'generated/dup.png',
            manifestKey: 'dup',
            contentHash: HASH,
            duplicateOfAssetPath: 'generated/dup.png',
            duplicateOfManifestKey: 'dup',
          },
        ],
      }),
    ).toThrowError(/DIFFERENT surviving path/);
  });

  it('rejects duplicate annotation keys inside one request', () => {
    expect(() =>
      sealAssetRequest({
        ...upsertBody(),
        operation: 'update-annotations',
        assets: [],
        annotations: [
          { key: 'a-var-1', favorite: true, disliked: false, comment: '' },
          { key: 'a-var-1', favorite: false, disliked: true, comment: '' },
        ],
      }),
    ).toThrowError(/duplicate annotation key/);
  });
});

describe('payload projection', () => {
  it('declares exactly the manifest plus the PNG/shard pair', () => {
    const manifest = sealAssetRequest(upsertBody());
    expect(declaredRequestPaths(manifest)).toEqual([
      `assets/requests/${manifest.requestId}.json`,
      'public/assets/generated/entries/skull-mace-var-2.json',
      'public/assets/generated/skull-mace-var-2.png',
    ]);
  });

  it('carries no aggregate document for an annotation request', () => {
    const manifest = sealAssetRequest({
      ...upsertBody(),
      operation: 'update-annotations',
      assets: [],
      annotations: [{ key: 'a-var-1', favorite: true, disliked: false, comment: 'nice' }],
    });
    expect(declaredRequestPaths(manifest)).toEqual([`assets/requests/${manifest.requestId}.json`]);
    // The conflict unit is the sprite KEY, never the shared file, so two editors
    // annotating different sprites can never collide.
    expect(destinationUnits(manifest)).toEqual([`${ANNOTATIONS_PATH}#a-var-1`]);
  });
});
