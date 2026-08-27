/**
 * Shared temp-git harness for the immutable asset-request tests.
 *
 * These primitives are load-bearing for asset durability, so the tests drive
 * REAL git (a bare "origin" plus a live clone) through the production runtime
 * deps rather than a mocked exec: ref immutability, compare-and-swap pushes,
 * worktree isolation, and byte-identical PNG round-trips are exactly the
 * properties a mock cannot prove.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sha256Bytes } from '../../../../scripts/sprites/asset-requests/manifest.js';

export interface Sandbox {
  readonly root: string;
  readonly origin: string;
  readonly clone: string;
  cleanup: () => void;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    // Keep git's progress/porcelain chatter out of the test reporter output.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
}

/** Deterministic pseudo-PNG bytes — path validation only requires the extension. */
export function fakePng(seed: string): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([header, Buffer.from(seed, 'utf8')]);
}

export function pngHash(seed: string): string {
  return sha256Bytes(fakePng(seed));
}

export function writeFileAt(root: string, repoPath: string, contents: Buffer | string): void {
  const absolute = path.join(root, ...repoPath.split('/'));
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

export interface SeedAsset {
  readonly manifestKey: string;
  readonly seed: string;
  readonly briefId?: string;
  readonly variantIndex?: number;
}

/** Write a PNG + its manifest shard, exactly as the request contract requires. */
export function writeAsset(root: string, asset: SeedAsset): void {
  const assetPath = `generated/${asset.manifestKey}.png`;
  writeFileAt(root, `public/assets/${assetPath}`, fakePng(asset.seed));
  writeFileAt(
    root,
    `public/assets/generated/entries/${asset.manifestKey}.json`,
    `${JSON.stringify(
      {
        briefId: asset.briefId ?? asset.manifestKey.replace(/-var-\d+$/, ''),
        assetPath,
        variantIndex: asset.variantIndex ?? 0,
        contentHash: pngHash(asset.seed),
      },
      null,
      2,
    )}\n`,
  );
}

export function makeSandbox(seedAssets: readonly SeedAsset[] = []): Sandbox {
  const root = mkdtempSync(path.join(tmpdir(), 'asset-request-test-'));
  const origin = path.join(root, 'origin.git');
  const clone = path.join(root, 'clone');
  mkdirSync(origin, { recursive: true });
  git(root, 'init', '--bare', '--initial-branch=main', origin);
  git(root, 'clone', origin, clone);
  git(clone, 'config', 'user.email', 'test@crawler.invalid');
  git(clone, 'config', 'user.name', 'Crawler Test');
  git(clone, 'config', 'commit.gpgsign', 'false');
  writeFileAt(clone, 'README.md', '# sandbox\n');
  for (const asset of seedAssets) writeAsset(clone, asset);
  git(clone, 'add', '--all');
  git(clone, 'commit', '-m', 'seed');
  git(clone, 'push', 'origin', 'HEAD:refs/heads/main');
  git(clone, 'fetch', 'origin');
  return {
    root,
    origin,
    clone,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Current `origin/main` SHA in the clone. */
export function originMain(clone: string): string {
  git(clone, 'fetch', 'origin', 'main');
  return git(clone, 'rev-parse', 'FETCH_HEAD');
}

/** Advance `main` on the origin with a new/changed asset (simulates a landed PR). */
export function advanceMain(sandbox: Sandbox, asset: SeedAsset): string {
  writeAsset(sandbox.clone, asset);
  git(sandbox.clone, 'add', '--all');
  git(sandbox.clone, 'commit', '-m', `advance ${asset.manifestKey}`);
  git(sandbox.clone, 'push', 'origin', 'HEAD:refs/heads/main');
  return originMain(sandbox.clone);
}
