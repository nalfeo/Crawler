/**
 * Real-git tests for the request-ref reconciler (`materializeAssetRequests`).
 *
 * Each test asserts one acceptance criterion from issue #3205 against genuine
 * git history, because the whole point of the redesign is that these are
 * STRUCTURAL properties, not conventions:
 *   - promotion always starts at current `origin/main`, never an aggregate;
 *   - a stale request cannot silently overwrite newer `main` bytes;
 *   - conflicting requests both get an actionable refusal, never a silent winner;
 *   - a generated path cannot be deleted without a same-content duplicate proof;
 *   - annotation updates merge per sprite key;
 *   - a replay from the same refs yields the identical promotion tree.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  AssetRequestManifest,
  AssetRequestManifestBody,
} from '../../../../scripts/sprites/asset-requests/manifest.js';
import { publishAssetRequest } from '../../../../scripts/sprites/asset-requests/publish.js';
import {
  archiveConsumedRequests,
  materializeAssetRequests,
  parseConsumedRequests,
  parseRequestRefs,
  resolveSupersession,
  type ValidatedRequest,
} from '../../../../scripts/sprites/asset-requests/reconcile.js';
import {
  createDefaultMaterializeDeps,
  createDefaultPublishDeps,
} from '../../../../scripts/sprites/asset-requests/runtime.js';
import {
  advanceMain,
  fakePng,
  git,
  makeSandbox,
  originMain,
  pngHash,
  writeAsset,
  writeFileAt,
  type Sandbox,
} from './harness.js';

let sandbox: Sandbox | undefined;

afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

function upsert(
  observedMainSha: string,
  manifestKey: string,
  seed: string,
  overrides: Partial<AssetRequestManifestBody> = {},
): AssetRequestManifestBody {
  return {
    version: 1,
    operation: 'upsert-asset',
    assets: [
      {
        assetPath: `generated/${manifestKey}.png`,
        manifestKey,
        contentHash: pngHash(seed),
        briefId: manifestKey.replace(/-var-\d+$/, ''),
        variantIndex: 0,
        sourceRun: null,
      },
    ],
    annotations: [],
    removals: [],
    observedMainSha,
    producer: 'approve-cli',
    provenance: {},
    supersedes: null,
    ...overrides,
  };
}

async function publish(
  clone: string,
  body: AssetRequestManifestBody,
): Promise<{ requestId: string; commit: string }> {
  const result = await publishAssetRequest(clone, body, createDefaultPublishDeps());
  return { requestId: result.requestId, commit: result.commit };
}

function reconcile(clone: string) {
  return materializeAssetRequests(clone, createDefaultMaterializeDeps(), { push: true });
}

function promotedTree(clone: string): string {
  return git(clone, 'rev-parse', 'origin/assets/promote^{tree}');
}

/** Minimal `ValidatedRequest` for exercising `resolveSupersession` in isolation. */
function fakeValidated(requestId: string, supersedes: string | null): ValidatedRequest {
  const manifest: AssetRequestManifest = {
    requestId,
    version: 1,
    operation: 'upsert-asset',
    assets: [],
    annotations: [],
    removals: [],
    observedMainSha: '0'.repeat(40),
    producer: 'test',
    provenance: {},
    supersedes,
  };
  return {
    enumerated: { requestId, branch: `assets/request/${requestId}`, commit: requestId },
    manifest,
    payloadRoot: '',
  };
}

describe('parseRequestRefs', () => {
  it('keeps only well-formed request refs and orders them deterministically', () => {
    const id = 'f'.repeat(64);
    const other = '0'.repeat(64);
    const stdout = [
      `${'a'.repeat(40)}\trefs/heads/assets/request/${id}`,
      `${'b'.repeat(40)}\trefs/heads/assets/request/${other}`,
      `${'c'.repeat(40)}\trefs/heads/assets/queue`,
      `${'d'.repeat(40)}\trefs/heads/assets/request/not-a-hash`,
    ].join('\n');
    expect(parseRequestRefs(stdout).map((request) => request.requestId)).toEqual([other, id]);
  });
});

describe('materializeAssetRequests', () => {
  it('applies a new asset onto current main and records consumed request trailers', async () => {
    sandbox = makeSandbox([{ manifestKey: 'existing-var-1', seed: 'existing' }]);
    const main = originMain(sandbox.clone);
    writeAsset(sandbox.clone, { manifestKey: 'lantern-var-0', seed: 'lantern' });
    const published = await publish(sandbox.clone, upsert(main, 'lantern-var-0', 'lantern'));

    const result = await reconcile(sandbox.clone);

    expect(result.status).toBe('materialized');
    expect(result.baseSha).toBe(main);
    expect(result.outcomes).toEqual([
      expect.objectContaining({ requestId: published.requestId, disposition: 'applied' }),
    ]);

    git(sandbox.clone, 'fetch', 'origin', 'assets/promote');
    const message = git(sandbox.clone, 'log', '-1', '--format=%B', 'FETCH_HEAD');
    expect(parseConsumedRequests(message)).toEqual([
      { requestId: published.requestId, commit: published.commit },
    ]);
    // The promotion carries the new asset AND preserves everything already on main.
    const files = git(sandbox.clone, 'ls-tree', '-r', '--name-only', 'FETCH_HEAD').split('\n');
    expect(files).toContain('public/assets/generated/lantern-var-0.png');
    expect(files).toContain('public/assets/generated/existing-var-1.png');
    // ...and it does NOT leak the request manifest into the game tree.
    expect(files.some((file) => file.startsWith('assets/requests/'))).toBe(false);
  });

  it('replays deterministically: the same refs against the same base yield the same tree', async () => {
    sandbox = makeSandbox();
    const main = originMain(sandbox.clone);
    writeAsset(sandbox.clone, { manifestKey: 'lantern-var-0', seed: 'lantern' });
    await publish(sandbox.clone, upsert(main, 'lantern-var-0', 'lantern'));

    await reconcile(sandbox.clone);
    git(sandbox.clone, 'fetch', 'origin', 'assets/promote');
    const firstTree = promotedTree(sandbox.clone);

    await reconcile(sandbox.clone);
    git(
      sandbox.clone,
      'fetch',
      '--force',
      'origin',
      'assets/promote:refs/remotes/origin/assets/promote',
    );
    expect(promotedTree(sandbox.clone)).toBe(firstTree);
  });

  it('refuses a STALE request instead of overwriting newer main bytes', async () => {
    sandbox = makeSandbox([{ manifestKey: 'lantern-var-0', seed: 'v1' }]);
    const staleMain = originMain(sandbox.clone);
    writeAsset(sandbox.clone, { manifestKey: 'lantern-var-0', seed: 'v3-from-stale-worktree' });
    const published = await publish(
      sandbox.clone,
      upsert(staleMain, 'lantern-var-0', 'v3-from-stale-worktree'),
    );
    // Someone else lands v2 on main AFTER the request observed v1.
    advanceMain(sandbox, { manifestKey: 'lantern-var-0', seed: 'v2-landed-on-main' });

    const result = await reconcile(sandbox.clone);

    expect(result.status).toBe('noop');
    expect(result.outcomes[0]).toMatchObject({
      requestId: published.requestId,
      disposition: 'refused',
      reason: 'stale-destination',
    });
    expect(git(sandbox.clone, 'ls-remote', 'origin', 'refs/heads/assets/promote')).toBe('');
  });

  it('refuses BOTH requests that claim the same destination with different content', async () => {
    sandbox = makeSandbox();
    const main = originMain(sandbox.clone);

    writeAsset(sandbox.clone, { manifestKey: 'lantern-var-0', seed: 'candidate-a' });
    const first = await publish(sandbox.clone, upsert(main, 'lantern-var-0', 'candidate-a'));
    writeAsset(sandbox.clone, { manifestKey: 'lantern-var-0', seed: 'candidate-b' });
    const second = await publish(sandbox.clone, upsert(main, 'lantern-var-0', 'candidate-b'));

    const result = await reconcile(sandbox.clone);

    expect(result.status).toBe('noop');
    for (const requestId of [first.requestId, second.requestId]) {
      expect(result.outcomes).toContainEqual(
        expect.objectContaining({ requestId, disposition: 'refused', reason: 'request-conflict' }),
      );
    }
    expect(result.outcomes.every((outcome) => outcome.detail !== undefined)).toBe(true);
  });

  it('refuses a request whose tree carries an undeclared file', async () => {
    sandbox = makeSandbox();
    const main = originMain(sandbox.clone);
    writeAsset(sandbox.clone, { manifestKey: 'lantern-var-0', seed: 'lantern' });
    const published = await publish(sandbox.clone, upsert(main, 'lantern-var-0', 'lantern'));

    // Forge a ref that adds an undeclared payload path on top of a valid request.
    const worktree = path.join(sandbox.root, 'forge');
    git(sandbox.clone, 'worktree', 'add', '--detach', worktree, published.commit);
    writeFileAt(worktree, 'public/assets/generated/smuggled-var-0.png', fakePng('smuggled'));
    git(worktree, 'add', '--all');
    git(worktree, 'commit', '--amend', '--no-edit');
    const forged = git(worktree, 'rev-parse', 'HEAD');
    git(
      sandbox.clone,
      'push',
      '--force',
      'origin',
      `${forged}:refs/heads/assets/request/${published.requestId}`,
    );

    const result = await reconcile(sandbox.clone);

    expect(result.outcomes[0]).toMatchObject({
      disposition: 'refused',
      reason: 'undeclared-payload',
    });
    expect(result.status).toBe('noop');
  });

  it('archives a request after its promotion SQUASH-merges (content proof, not ancestry)', async () => {
    sandbox = makeSandbox();
    const main = originMain(sandbox.clone);
    writeAsset(sandbox.clone, { manifestKey: 'lantern-var-0', seed: 'lantern' });
    const published = await publish(sandbox.clone, upsert(main, 'lantern-var-0', 'lantern'));

    await reconcile(sandbox.clone);
    git(sandbox.clone, 'fetch', 'origin', 'assets/promote');
    const promotion = git(sandbox.clone, 'rev-parse', 'FETCH_HEAD');

    // Simulate the REAL merge flow: `assets/promote` PRs are squash-merged
    // (`.github/workflows/sprite-queue-reconciler.yml`), so `main` gains a NEW
    // commit with the promotion's tree but a different SHA/parent — the
    // pre-merge promotion commit is never an ancestor of the squashed `main`.
    git(sandbox.clone, 'checkout', '-B', 'main-work', main);
    git(sandbox.clone, 'clean', '-fd', 'public');
    git(
      sandbox.clone,
      '-c',
      'user.email=test@crawler.invalid',
      '-c',
      'user.name=Crawler Test',
      'merge',
      '--squash',
      'FETCH_HEAD',
    );
    git(sandbox.clone, 'commit', '-m', 'squash-merge assets/promote');
    const squashed = git(sandbox.clone, 'rev-parse', 'HEAD');
    expect(squashed).not.toBe(promotion);
    git(sandbox.clone, 'push', 'origin', 'HEAD:refs/heads/main');
    // The pre-merge promotion commit is genuinely not main's ancestor now.
    expect(
      (() => {
        try {
          git(sandbox.clone, 'merge-base', '--is-ancestor', promotion, squashed);
          return true;
        } catch {
          return false;
        }
      })(),
    ).toBe(false);

    const archive = await archiveConsumedRequests(
      sandbox.clone,
      promotion,
      createDefaultMaterializeDeps(),
    );
    expect(archive.archived).toEqual([published.requestId]);
    expect(
      git(sandbox.clone, 'ls-remote', 'origin', `refs/heads/assets/request/${published.requestId}`),
    ).toBe('');
    expect(
      git(
        sandbox.clone,
        'ls-remote',
        'origin',
        `refs/heads/assets/archive/request/${published.requestId}`,
      ),
    ).toContain(published.commit);
  });

  it('reports an already-landed request as a consumed no-op rather than re-applying it', async () => {
    sandbox = makeSandbox();
    const main = originMain(sandbox.clone);
    writeAsset(sandbox.clone, { manifestKey: 'lantern-var-0', seed: 'lantern' });
    const published = await publish(sandbox.clone, upsert(main, 'lantern-var-0', 'lantern'));

    await reconcile(sandbox.clone);
    // Land the promotion on main, exactly as the merge flow would.
    git(sandbox.clone, 'fetch', 'origin', 'assets/promote');
    const promotion = git(sandbox.clone, 'rev-parse', 'FETCH_HEAD');
    git(sandbox.clone, 'push', 'origin', `${promotion}:refs/heads/main`);

    const second = await materializeAssetRequests(sandbox.clone, createDefaultMaterializeDeps(), {
      push: true,
    });

    expect(second.status).toBe('noop');
    expect(second.outcomes[0]).toMatchObject({
      requestId: published.requestId,
      disposition: 'already-on-main',
    });

    // Archiving now preserves the request commit and retires the live ref, so a
    // consumed request can be neither lost nor double-consumed.
    const archive = await archiveConsumedRequests(
      sandbox.clone,
      promotion,
      createDefaultMaterializeDeps(),
    );
    expect(archive.archived).toEqual([published.requestId]);
    expect(
      git(sandbox.clone, 'ls-remote', 'origin', `refs/heads/assets/request/${published.requestId}`),
    ).toBe('');
    expect(
      git(
        sandbox.clone,
        'ls-remote',
        'origin',
        `refs/heads/assets/archive/request/${published.requestId}`,
      ),
    ).toContain(published.commit);
    // Re-archiving is a safe no-op.
    const again = await archiveConsumedRequests(
      sandbox.clone,
      promotion,
      createDefaultMaterializeDeps(),
    );
    expect(again).toEqual({ archived: [], skipped: [published.requestId] });
  });

  it('resumes an archive interrupted between the archive push and the live-ref delete', async () => {
    sandbox = makeSandbox();
    const main = originMain(sandbox.clone);
    writeAsset(sandbox.clone, { manifestKey: 'lantern-var-0', seed: 'lantern' });
    const published = await publish(sandbox.clone, upsert(main, 'lantern-var-0', 'lantern'));

    await reconcile(sandbox.clone);
    git(sandbox.clone, 'fetch', 'origin', 'assets/promote');
    const promotion = git(sandbox.clone, 'rev-parse', 'FETCH_HEAD');
    git(sandbox.clone, 'push', 'origin', `${promotion}:refs/heads/main`);

    // Simulate a crash after the archive push landed but before the live ref
    // was deleted: the archive ref already exists at the request commit.
    const archiveRef = `refs/heads/assets/archive/request/${published.requestId}`;
    git(sandbox.clone, 'push', 'origin', `${published.commit}:${archiveRef}`);

    const archive = await archiveConsumedRequests(
      sandbox.clone,
      promotion,
      createDefaultMaterializeDeps(),
    );

    expect(archive.archived).toEqual([published.requestId]);
    expect(
      git(sandbox.clone, 'ls-remote', 'origin', `refs/heads/assets/request/${published.requestId}`),
    ).toBe('');
    expect(git(sandbox.clone, 'ls-remote', 'origin', archiveRef)).toContain(published.commit);
  });

  it('refuses to overwrite an archive ref that diverged from the consumed request', async () => {
    sandbox = makeSandbox();
    const main = originMain(sandbox.clone);
    writeAsset(sandbox.clone, { manifestKey: 'lantern-var-0', seed: 'lantern' });
    const published = await publish(sandbox.clone, upsert(main, 'lantern-var-0', 'lantern'));

    await reconcile(sandbox.clone);
    git(sandbox.clone, 'fetch', 'origin', 'assets/promote');
    const promotion = git(sandbox.clone, 'rev-parse', 'FETCH_HEAD');
    git(sandbox.clone, 'push', 'origin', `${promotion}:refs/heads/main`);

    const archiveRef = `refs/heads/assets/archive/request/${published.requestId}`;
    git(sandbox.clone, 'push', 'origin', `${main}:${archiveRef}`);

    await expect(
      archiveConsumedRequests(sandbox.clone, promotion, createDefaultMaterializeDeps()),
    ).rejects.toThrow(/archive ref .* points at /);
    // The live request ref survives, so nothing is lost by the refusal.
    expect(
      git(sandbox.clone, 'ls-remote', 'origin', `refs/heads/assets/request/${published.requestId}`),
    ).toContain(published.commit);
  });

  it('never archives requests for a promotion that is not proven merged', async () => {
    sandbox = makeSandbox();
    const main = originMain(sandbox.clone);
    writeAsset(sandbox.clone, { manifestKey: 'lantern-var-0', seed: 'lantern' });
    const published = await publish(sandbox.clone, upsert(main, 'lantern-var-0', 'lantern'));
    const result = await reconcile(sandbox.clone);

    const archive = await archiveConsumedRequests(
      sandbox.clone,
      result.promotionCommit ?? '',
      createDefaultMaterializeDeps(),
    );

    expect(archive).toEqual({ archived: [], skipped: [] });
    expect(
      git(sandbox.clone, 'ls-remote', 'origin', `refs/heads/assets/request/${published.requestId}`),
    ).toContain(published.commit);
  });
});

describe('removal requests', () => {
  function removal(
    observedMainSha: string,
    seed: string,
    overrides: Partial<{ duplicateOfAssetPath: string; duplicateOfManifestKey: string }> = {},
  ): AssetRequestManifestBody {
    return {
      version: 1,
      operation: 'remove-asset',
      assets: [],
      annotations: [],
      removals: [
        {
          assetPath: 'generated/dup-var-1.png',
          manifestKey: 'dup-var-1',
          contentHash: pngHash(seed),
          duplicateOfAssetPath: overrides.duplicateOfAssetPath ?? 'generated/dup-var-0.png',
          duplicateOfManifestKey: overrides.duplicateOfManifestKey ?? 'dup-var-0',
        },
      ],
      observedMainSha,
      producer: 'duplicate-prune',
      provenance: {},
      supersedes: null,
    };
  }

  it('applies a removal backed by a same-content duplicate that survives on main', async () => {
    sandbox = makeSandbox([
      { manifestKey: 'dup-var-0', seed: 'same-bytes' },
      { manifestKey: 'dup-var-1', seed: 'same-bytes' },
    ]);
    const main = originMain(sandbox.clone);
    await publish(sandbox.clone, removal(main, 'same-bytes'));

    const result = await reconcile(sandbox.clone);

    expect(result.status).toBe('materialized');
    git(sandbox.clone, 'fetch', 'origin', 'assets/promote');
    const files = git(sandbox.clone, 'ls-tree', '-r', '--name-only', 'FETCH_HEAD').split('\n');
    expect(files).not.toContain('public/assets/generated/dup-var-1.png');
    expect(files).not.toContain('public/assets/generated/entries/dup-var-1.json');
    // The surviving copy is untouched — a removal can never take the last copy.
    expect(files).toContain('public/assets/generated/dup-var-0.png');
  });

  it('refuses a removal whose duplicate proof does not hold (different bytes)', async () => {
    sandbox = makeSandbox([
      { manifestKey: 'dup-var-0', seed: 'other-bytes' },
      { manifestKey: 'dup-var-1', seed: 'same-bytes' },
    ]);
    const main = originMain(sandbox.clone);
    await publish(sandbox.clone, removal(main, 'same-bytes'));

    const result = await reconcile(sandbox.clone);

    expect(result.status).toBe('noop');
    expect(result.outcomes[0]).toMatchObject({
      disposition: 'refused',
      reason: 'missing-duplicate-proof',
    });
  });

  it('refuses a removal whose target bytes on main are not the proven bytes', async () => {
    sandbox = makeSandbox([
      { manifestKey: 'dup-var-0', seed: 'same-bytes' },
      { manifestKey: 'dup-var-1', seed: 'same-bytes' },
    ]);
    const main = originMain(sandbox.clone);
    await publish(sandbox.clone, removal(main, 'not-the-bytes-on-main'));

    const result = await reconcile(sandbox.clone);

    expect(result.outcomes[0]).toMatchObject({
      disposition: 'refused',
      reason: 'missing-removal-target',
    });
  });

  it('refuses BOTH removals when they name each other as the surviving proof in one promotion', async () => {
    sandbox = makeSandbox([
      { manifestKey: 'dup-var-0', seed: 'same-bytes' },
      { manifestKey: 'dup-var-1', seed: 'same-bytes' },
    ]);
    const main = originMain(sandbox.clone);
    // Removes dup-var-1, proving dup-var-0 survives.
    await publish(sandbox.clone, removal(main, 'same-bytes'));
    // Removes dup-var-0, proving dup-var-1 survives — the mirror image. Each
    // request's proof is valid against the BASE tree in isolation, but the
    // promotion cannot apply both: whichever applies first consumes the last
    // byte-identical copy the other one names as its proof.
    await publish(sandbox.clone, {
      version: 1,
      operation: 'remove-asset',
      assets: [],
      annotations: [],
      removals: [
        {
          assetPath: 'generated/dup-var-0.png',
          manifestKey: 'dup-var-0',
          contentHash: pngHash('same-bytes'),
          duplicateOfAssetPath: 'generated/dup-var-1.png',
          duplicateOfManifestKey: 'dup-var-1',
        },
      ],
      observedMainSha: main,
      producer: 'duplicate-prune',
      provenance: {},
      supersedes: null,
    });

    const result = await reconcile(sandbox.clone);

    expect(result.status).toBe('noop');
    expect(result.outcomes).toHaveLength(2);
    for (const outcome of result.outcomes) {
      expect(outcome).toMatchObject({ disposition: 'refused', reason: 'missing-duplicate-proof' });
    }
  });

  it('archives a removal after its DELETION squash-merges (deleted path proof, not ancestry)', async () => {
    sandbox = makeSandbox([
      { manifestKey: 'dup-var-0', seed: 'same-bytes' },
      { manifestKey: 'dup-var-1', seed: 'same-bytes' },
    ]);
    const main = originMain(sandbox.clone);
    const published = await publish(sandbox.clone, removal(main, 'same-bytes'));

    await reconcile(sandbox.clone);
    git(sandbox.clone, 'fetch', 'origin', 'assets/promote');
    const promotion = git(sandbox.clone, 'rev-parse', 'FETCH_HEAD');

    // Simulate the real squash-merge flow, same as the upsert case above —
    // except this promotion's diff against its parent is a DELETION of
    // dup-var-1's PNG+shard, so `blobAt(promotionCommit, path)` is null for
    // those paths and the "landed" proof must check absence-on-main, not a
    // blob match.
    git(sandbox.clone, 'checkout', '-B', 'main-work', main);
    git(sandbox.clone, 'clean', '-fd', 'public');
    git(
      sandbox.clone,
      '-c',
      'user.email=test@crawler.invalid',
      '-c',
      'user.name=Crawler Test',
      'merge',
      '--squash',
      'FETCH_HEAD',
    );
    git(sandbox.clone, 'commit', '-m', 'squash-merge assets/promote');
    git(sandbox.clone, 'push', 'origin', 'HEAD:refs/heads/main');

    const archive = await archiveConsumedRequests(
      sandbox.clone,
      promotion,
      createDefaultMaterializeDeps(),
    );
    expect(archive.archived).toEqual([published.requestId]);
    expect(
      git(sandbox.clone, 'ls-remote', 'origin', `refs/heads/assets/request/${published.requestId}`),
    ).toBe('');
  });
});

describe('annotation requests', () => {
  function annotate(
    observedMainSha: string,
    key: string,
    comment: string,
  ): AssetRequestManifestBody {
    return {
      version: 1,
      operation: 'update-annotations',
      assets: [],
      annotations: [{ key, favorite: true, disliked: false, comment }],
      removals: [],
      observedMainSha,
      producer: 'sprite-editor',
      provenance: {},
      supersedes: null,
    };
  }

  it('merges per sprite key without clobbering other keys', async () => {
    sandbox = makeSandbox([
      { manifestKey: 'lantern-var-0', seed: 'a' },
      { manifestKey: 'mace-var-0', seed: 'b' },
    ]);
    writeFileAt(
      sandbox.clone,
      'public/assets/generated/sprite-editor-annotations.json',
      `${JSON.stringify(
        {
          version: 1,
          sprites: { 'keep-var-0': { favorite: false, disliked: true, comment: 'keep me' } },
        },
        null,
        2,
      )}\n`,
    );
    git(sandbox.clone, 'add', '--all');
    git(sandbox.clone, 'commit', '-m', 'seed annotations');
    git(sandbox.clone, 'push', 'origin', 'HEAD:refs/heads/main');
    const main = originMain(sandbox.clone);

    await publish(sandbox.clone, annotate(main, 'lantern-var-0', 'nice glow'));
    await publish(sandbox.clone, annotate(main, 'mace-var-0', 'too spiky'));

    const result = await reconcile(sandbox.clone);
    expect(result.status).toBe('materialized');
    expect(result.outcomes.every((outcome) => outcome.disposition === 'applied')).toBe(true);

    git(sandbox.clone, 'fetch', 'origin', 'assets/promote');
    const worktree = path.join(sandbox.root, 'inspect');
    git(sandbox.clone, 'worktree', 'add', '--detach', worktree, 'FETCH_HEAD');
    const document = JSON.parse(
      readFileSync(
        path.join(worktree, 'public', 'assets', 'generated', 'sprite-editor-annotations.json'),
        'utf8',
      ),
    ) as { sprites: Record<string, { comment: string }> };
    expect(Object.keys(document.sprites).sort()).toEqual([
      'keep-var-0',
      'lantern-var-0',
      'mace-var-0',
    ]);
    expect(document.sprites['keep-var-0']?.comment).toBe('keep me');
    expect(document.sprites['lantern-var-0']?.comment).toBe('nice glow');
  });
  it('refuses a STALE annotation instead of overwriting a newer value for that key', async () => {
    sandbox = makeSandbox([{ manifestKey: 'lantern-var-0', seed: 'a' }]);
    const main = originMain(sandbox.clone);
    await publish(sandbox.clone, annotate(main, 'lantern-var-0', 'nice glow'));

    // Someone else annotates the SAME key on main after the request was sealed.
    writeFileAt(
      sandbox.clone,
      'public/assets/generated/sprite-editor-annotations.json',
      `${JSON.stringify(
        {
          version: 1,
          sprites: { 'lantern-var-0': { favorite: false, disliked: true, comment: 'newer' } },
        },
        null,
        2,
      )}\n`,
    );
    git(sandbox.clone, 'add', '--all');
    git(sandbox.clone, 'commit', '-m', 'newer annotation');
    git(sandbox.clone, 'push', 'origin', 'HEAD:refs/heads/main');

    const result = await reconcile(sandbox.clone);

    expect(result.status).toBe('noop');
    expect(result.outcomes[0]).toMatchObject({
      disposition: 'refused',
      reason: 'stale-destination',
    });
  });

  it('applies an annotation when a DIFFERENT key changed on main (per-key staleness)', async () => {
    sandbox = makeSandbox([{ manifestKey: 'lantern-var-0', seed: 'a' }]);
    const main = originMain(sandbox.clone);
    await publish(sandbox.clone, annotate(main, 'lantern-var-0', 'nice glow'));

    writeFileAt(
      sandbox.clone,
      'public/assets/generated/sprite-editor-annotations.json',
      `${JSON.stringify(
        {
          version: 1,
          sprites: { 'other-var-0': { favorite: false, disliked: true, comment: 'unrelated' } },
        },
        null,
        2,
      )}\n`,
    );
    git(sandbox.clone, 'add', '--all');
    git(sandbox.clone, 'commit', '-m', 'unrelated annotation');
    git(sandbox.clone, 'push', 'origin', 'HEAD:refs/heads/main');

    const result = await reconcile(sandbox.clone);

    expect(result.status).toBe('materialized');
    expect(result.outcomes[0]).toMatchObject({ disposition: 'applied' });
  });
});

describe('source-bound removal proofs', () => {
  it('refuses a removal whose surviving key does not own the proven duplicate bytes', async () => {
    sandbox = makeSandbox([
      { manifestKey: 'dup-var-0', seed: 'same-bytes' },
      { manifestKey: 'dup-var-1', seed: 'same-bytes' },
      { manifestKey: 'unrelated-var-0', seed: 'unrelated' },
    ]);
    const main = originMain(sandbox.clone);

    await publish(sandbox.clone, {
      version: 1,
      operation: 'remove-asset',
      assets: [],
      annotations: [],
      removals: [
        {
          assetPath: 'generated/dup-var-1.png',
          manifestKey: 'dup-var-1',
          contentHash: pngHash('same-bytes'),
          // Real duplicate bytes, but attributed to a key that owns other art.
          duplicateOfAssetPath: 'generated/dup-var-0.png',
          duplicateOfManifestKey: 'unrelated-var-0',
        },
      ],
      observedMainSha: main,
      producer: 'duplicate-prune',
      provenance: {},
      supersedes: null,
    });

    const result = await reconcile(sandbox.clone);

    expect(result.status).toBe('noop');
    expect(result.outcomes[0]).toMatchObject({
      disposition: 'refused',
      reason: 'missing-duplicate-proof',
    });
  });
});

describe('conflict fingerprints', () => {
  it('refuses same-bytes requests that disagree on sourceRun instead of deduping them', async () => {
    sandbox = makeSandbox();
    const main = originMain(sandbox.clone);
    writeAsset(sandbox.clone, { manifestKey: 'lantern-var-0', seed: 'lantern' });

    const first = await publish(
      sandbox.clone,
      upsert(main, 'lantern-var-0', 'lantern', {
        assets: [
          {
            assetPath: 'generated/lantern-var-0.png',
            manifestKey: 'lantern-var-0',
            contentHash: pngHash('lantern'),
            briefId: 'lantern',
            variantIndex: 0,
            sourceRun: 'run-a',
          },
        ],
      }),
    );
    const second = await publish(
      sandbox.clone,
      upsert(main, 'lantern-var-0', 'lantern', {
        assets: [
          {
            assetPath: 'generated/lantern-var-0.png',
            manifestKey: 'lantern-var-0',
            contentHash: pngHash('lantern'),
            briefId: 'lantern',
            variantIndex: 0,
            sourceRun: 'run-b',
          },
        ],
      }),
    );
    expect(first.requestId).not.toBe(second.requestId);

    const result = await reconcile(sandbox.clone);

    expect(result.status).toBe('noop');
    expect(result.outcomes.map((outcome) => outcome.disposition)).toEqual(['refused', 'refused']);
    expect(result.outcomes.every((outcome) => outcome.reason === 'request-conflict')).toBe(true);
  });
});

describe('supersession', () => {
  it('retires the superseded request instead of refusing it as a conflict', async () => {
    sandbox = makeSandbox();
    const main = originMain(sandbox.clone);
    writeAsset(sandbox.clone, { manifestKey: 'lantern-var-0', seed: 'lantern-v1' });
    const original = await publish(sandbox.clone, upsert(main, 'lantern-var-0', 'lantern-v1'));

    writeAsset(sandbox.clone, { manifestKey: 'lantern-var-0', seed: 'lantern-v2' });
    const correction = await publish(
      sandbox.clone,
      upsert(main, 'lantern-var-0', 'lantern-v2', { supersedes: original.requestId }),
    );

    const result = await reconcile(sandbox.clone);

    expect(result.status).toBe('materialized');
    expect(result.outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requestId: original.requestId, disposition: 'superseded' }),
        expect.objectContaining({ requestId: correction.requestId, disposition: 'applied' }),
      ]),
    );
    // The correction's bytes land, not the superseded original's.
    git(sandbox.clone, 'fetch', 'origin', 'assets/promote');
    const worktree = path.join(sandbox.root, 'inspect-supersession');
    git(sandbox.clone, 'worktree', 'add', '--detach', worktree, 'FETCH_HEAD');
    const landed = readFileSync(path.join(worktree, 'public/assets/generated/lantern-var-0.png'));
    expect(landed.equals(fakePng('lantern-v2'))).toBe(true);

    // The superseded request is retired immediately — never consumed by a
    // promotion, so it has no promotion-merge proof to wait on.
    expect(
      git(sandbox.clone, 'ls-remote', 'origin', `refs/heads/assets/request/${original.requestId}`),
    ).toBe('');
    expect(
      git(
        sandbox.clone,
        'ls-remote',
        'origin',
        `refs/heads/assets/archive/request/${original.requestId}`,
      ),
    ).toContain(original.commit);
  });

  it('refuses BOTH sides of an unresolvable supersession cycle', () => {
    // A genuine two-request cycle cannot be produced by the normal publish
    // path (each request's id is a hash of its own body, so `A.supersedes ===
    // B.requestId && B.supersedes === A.requestId` would require each side to
    // know the other's hash before it exists — a preimage problem). Exercise
    // the pure resolver directly against a defensively-constructed cycle, the
    // way a corrupted/forged ref pair would present it.
    const requestA = fakeValidated('a'.repeat(64), 'b'.repeat(64));
    const requestB = fakeValidated('b'.repeat(64), 'a'.repeat(64));

    const { active, superseded, invalid } = resolveSupersession([requestA, requestB]);

    expect(active).toEqual([]);
    expect(superseded).toEqual([]);
    expect(invalid.map((entry) => entry.request.manifest.requestId).sort()).toEqual(
      ['a'.repeat(64), 'b'.repeat(64)].sort(),
    );
  });

  it('refuses a request that names itself in `supersedes`', () => {
    const selfReferencing = fakeValidated('c'.repeat(64), 'c'.repeat(64));

    const { active, superseded, invalid } = resolveSupersession([selfReferencing]);

    expect(active).toEqual([]);
    expect(superseded).toEqual([]);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.request.manifest.requestId).toBe('c'.repeat(64));
  });

  it('resolves a chain of corrections to only the tip', () => {
    // C supersedes B, B supersedes A: A and B are retired, only C is active.
    const requestA = fakeValidated('a'.repeat(64), null);
    const requestB = fakeValidated('b'.repeat(64), 'a'.repeat(64));
    const requestC = fakeValidated('c'.repeat(64), 'b'.repeat(64));

    const { active, superseded, invalid } = resolveSupersession([requestA, requestB, requestC]);

    expect(invalid).toEqual([]);
    expect(active.map((request) => request.manifest.requestId)).toEqual(['c'.repeat(64)]);
    expect(superseded.map((entry) => entry.request.manifest.requestId).sort()).toEqual(
      ['a'.repeat(64), 'b'.repeat(64)].sort(),
    );
  });
});
