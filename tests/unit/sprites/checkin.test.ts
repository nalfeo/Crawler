/**
 * Unit tests for checkin.ts.
 *
 * The pure planner (`planAssetCheckin`) is asserted directly. The executor
 * (`runAssetCheckin`) is exercised with a fully faked `exec` + fs hooks so we
 * can assert the exact git/gh command sequence without a real repo or network.
 */

import { describe, expect, it } from 'vitest';
import {
  ASSET_CHECKIN_LABEL,
  ASSET_CHECKIN_MARKER,
  ART_SURFACE_ALLOWLIST,
  ASSET_SURFACE_PATHS,
  CheckinError,
  detectApprovedAssets,
  planAssetCheckin,
  prepareAssetCheckin,
  runAssetCheckin,
  type CheckinAsset,
  type Exec,
  type ExecResult,
} from '../../../scripts/sprites/checkin.js';
import { parseAssetIssueBody } from '../../../scripts/sprites/asset-issues.js';

const FIXED_NOW = new Date('2026-06-08T19:08:15.000Z');

function asset(overrides: Partial<CheckinAsset> = {}): CheckinAsset {
  return {
    assetPath: 'generated/skull-mace-var-2.png',
    manifestKey: 'skull-mace-var-2',
    briefId: 'skull-mace',
    variantIndex: 2,
    ...overrides,
  };
}

describe('art surface constants', () => {
  it('never writes the sprite catalog, so parallel art check-ins cannot conflict on it', () => {
    // Every art check-in used to append to BOTH the generated manifest and
    // `src/shared/data/sprite-catalog.json`, whose `generated:` rows merely
    // restate manifest data. Two files meant every pair of concurrent art PRs
    // conflicted by construction. Writing only the manifest halves that surface.
    expect([...ASSET_SURFACE_PATHS]).toEqual(['public/assets/generated']);
    expect(ASSET_SURFACE_PATHS).not.toContain('src/shared/data/sprite-catalog.json');
  });

  it('still TOLERATES catalog edits, so in-flight branches keep reconciling', () => {
    // The guard list must stay a superset of what we write and must match
    // `detect-art-only.sh`, or a branch created before this change would be
    // rejected as a non-art diff.
    expect([...ART_SURFACE_ALLOWLIST]).toContain('src/shared/data/sprite-catalog.json');
    for (const written of ASSET_SURFACE_PATHS) {
      expect([...ART_SURFACE_ALLOWLIST]).toContain(written);
    }
  });
});

describe('planAssetCheckin', () => {
  it('derives a deterministic branch, commit, and issue title from the assets', () => {
    const plan = planAssetCheckin({ assets: [asset()], now: FIXED_NOW });
    expect(plan.branch).toMatch(/^assets\/checkin-20260608-190815-[0-9a-f]{6}$/);
    expect(plan.baseBranch).toBe('main');
    expect(plan.commitMessage).toBe('feat(sprites): check in 1 approved asset');
    expect(plan.issueTitle).toContain('1 approved asset');
    expect(plan.labels).toEqual([ASSET_CHECKIN_LABEL]);
    expect(plan.paths).toEqual([...ASSET_SURFACE_PATHS]);
  });

  it('pluralizes the noun for multiple assets', () => {
    const plan = planAssetCheckin({
      assets: [asset(), asset({ assetPath: 'generated/iron-sword-var-1.png' })],
      now: FIXED_NOW,
    });
    expect(plan.commitMessage).toBe('feat(sprites): check in 2 approved assets');
    expect(plan.issueTitle).toContain('2 approved assets');
  });

  it('is stable for the same asset set and varies across different sets', () => {
    const a = planAssetCheckin({ assets: [asset()], now: FIXED_NOW });
    const b = planAssetCheckin({ assets: [asset()], now: FIXED_NOW });
    const c = planAssetCheckin({
      assets: [asset({ assetPath: 'generated/other-var-1.png', manifestKey: 'other-var-1' })],
      now: FIXED_NOW,
    });
    expect(a.branch).toBe(b.branch);
    expect(a.branch).not.toBe(c.branch);
  });

  it('honors an explicit slug and base branch', () => {
    const plan = planAssetCheckin({
      assets: [asset()],
      now: FIXED_NOW,
      slug: 'my-slug',
      baseBranch: 'develop',
    });
    expect(plan.branch).toBe('assets/my-slug');
    expect(plan.baseBranch).toBe('develop');
  });

  it('embeds a machine-readable payload that round-trips through parseAssetIssueBody', () => {
    const plan = planAssetCheckin({
      assets: [asset()],
      now: FIXED_NOW,
      slug: 'roundtrip',
      assetRequestIssueNumbers: [1307, 1313, 1307],
    });
    expect(plan.issueBody).toContain(`<!-- ${ASSET_CHECKIN_MARKER}`);
    const payload = parseAssetIssueBody(plan.issueBody);
    expect(payload).not.toBeNull();
    expect(payload!.branch).toBe('assets/roundtrip');
    expect(payload!.assets).toEqual([asset()]);
    expect(payload!.assetRequestIssueNumbers).toEqual([1307, 1313]);
  });
});

/** Records every exec call and returns canned results keyed by a matcher. */
function makeFakeExec(
  responder: (command: string, args: readonly string[]) => Partial<ExecResult>,
): { exec: Exec; calls: Array<{ command: string; args: string[]; cwd?: string }> } {
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const exec: Exec = (command, args, options) => {
    calls.push({ command, args: [...args], cwd: options?.cwd });
    const result = responder(command, args);
    return Promise.resolve({ stdout: '', stderr: '', code: 0, ...result });
  };
  return { exec, calls };
}

describe('runAssetCheckin', () => {
  const baseDeps = () => ({
    copyArtSurface: () => Promise.resolve(),
    makeTempDir: () => Promise.resolve('/tmp/checkin-xyz'),
    removeDir: () => Promise.resolve(),
    now: () => FIXED_NOW,
    env: {} as NodeJS.ProcessEnv,
  });

  it('refuses to run under CI', async () => {
    const { exec } = makeFakeExec(() => ({}));
    await expect(
      runAssetCheckin('/repo', { ...baseDeps(), exec, env: { CI: 'true' } }),
    ).rejects.toMatchObject({ kind: 'ci-refused' });
  });

  it('throws nothing-to-checkin when no art differs from the base', async () => {
    const { exec } = makeFakeExec((command, args) => {
      if (command === 'git' && args[0] === 'diff') return { stdout: '\n' };
      return {};
    });
    await expect(runAssetCheckin('/repo', { ...baseDeps(), exec })).rejects.toMatchObject({
      kind: 'nothing-to-checkin',
    });
  });

  it('excludes (dedupes) an asset already queued with the SAME content hash (match)', async () => {
    const { exec } = makeFakeExec((command, args) => {
      if (command === 'git' && args[0] === 'diff') {
        return {
          stdout:
            'public/assets/generated/skull-mace-var-2.png\n' +
            'public/assets/generated/iron-sword-var-1.png\n',
        };
      }
      return {};
    });
    const queued = new Map([
      [
        'generated/skull-mace-var-2.png',
        {
          issueUrl: 'https://github.com/nalfeo/Crawler/issues/41',
          branch: 'assets/queued',
          contentHash: 'hash-a',
        },
      ],
    ]);

    const prepared = await prepareAssetCheckin('/repo', {
      ...baseDeps(),
      exec,
      listQueuedAssets: () => Promise.resolve(queued),
      readManifest: () =>
        Promise.resolve({
          entries: {
            'skull-mace-var-2': {
              assetPath: 'generated/skull-mace-var-2.png',
              contentHash: 'hash-a',
            },
          },
        }),
    });

    expect(prepared.changedAssetCount).toBe(2);
    expect(prepared.plan.assets.map((entry) => entry.assetPath)).toEqual([
      'generated/iron-sword-var-1.png',
    ]);
  });

  it('throws a typed content-conflict when the queued hash differs from the current content (mismatch)', async () => {
    const { exec } = makeFakeExec((command, args) => {
      if (command === 'git' && args[0] === 'diff') {
        return {
          stdout:
            'public/assets/generated/skull-mace-var-2.png\n' +
            'public/assets/generated/iron-sword-var-1.png\n',
        };
      }
      return {};
    });
    const queued = new Map([
      [
        'generated/skull-mace-var-2.png',
        {
          issueUrl: 'https://github.com/nalfeo/Crawler/issues/41',
          branch: 'assets/queued',
          contentHash: 'old-hash',
        },
      ],
    ]);

    await expect(
      prepareAssetCheckin('/repo', {
        ...baseDeps(),
        exec,
        listQueuedAssets: () => Promise.resolve(queued),
        readManifest: () =>
          Promise.resolve({
            entries: {
              'skull-mace-var-2': {
                assetPath: 'generated/skull-mace-var-2.png',
                contentHash: 'new-hash',
              },
            },
          }),
      }),
    ).rejects.toMatchObject({ kind: 'content-conflict' });
  });

  it('fails closed with an ambiguous conflict when the queued issue predates content hashes (legacy queued entry)', async () => {
    const { exec } = makeFakeExec((command, args) => {
      if (command === 'git' && args[0] === 'diff') {
        return { stdout: 'public/assets/generated/skull-mace-var-2.png\n' };
      }
      return {};
    });
    const queued = new Map([
      [
        'generated/skull-mace-var-2.png',
        // No contentHash: a legacy issue filed before the field existed.
        { issueUrl: 'https://github.com/nalfeo/Crawler/issues/41', branch: 'assets/queued' },
      ],
    ]);

    await expect(
      prepareAssetCheckin('/repo', {
        ...baseDeps(),
        exec,
        listQueuedAssets: () => Promise.resolve(queued),
        readManifest: () =>
          Promise.resolve({
            entries: {
              'skull-mace-var-2': {
                assetPath: 'generated/skull-mace-var-2.png',
                contentHash: 'new-hash',
              },
            },
          }),
      }),
    ).rejects.toMatchObject({ kind: 'ambiguous-queued-content' });
  });

  it('fails closed with an ambiguous conflict when the CURRENT asset has no recorded hash, even if the queue has one (legacy manifest entry)', async () => {
    const { exec } = makeFakeExec((command, args) => {
      if (command === 'git' && args[0] === 'diff') {
        return { stdout: 'public/assets/generated/skull-mace-var-2.png\n' };
      }
      return {};
    });
    const queued = new Map([
      [
        'generated/skull-mace-var-2.png',
        {
          issueUrl: 'https://github.com/nalfeo/Crawler/issues/41',
          branch: 'assets/queued',
          contentHash: 'queued-hash',
        },
      ],
    ]);

    // No readManifest override -> the changed asset has no contentHash.
    await expect(
      prepareAssetCheckin('/repo', {
        ...baseDeps(),
        exec,
        listQueuedAssets: () => Promise.resolve(queued),
      }),
    ).rejects.toMatchObject({ kind: 'ambiguous-queued-content' });
  });

  it('does not create another issue when every changed asset is already queued with matching content', async () => {
    const { exec, calls } = makeFakeExec((command, args) => {
      if (command === 'git' && args[0] === 'diff') {
        return { stdout: 'public/assets/generated/skull-mace-var-2.png\n' };
      }
      return {};
    });

    await expect(
      runAssetCheckin('/repo', {
        ...baseDeps(),
        exec,
        readManifest: () =>
          Promise.resolve({
            entries: {
              'skull-mace-var-2': {
                assetPath: 'generated/skull-mace-var-2.png',
                contentHash: 'hash-a',
              },
            },
          }),
        listQueuedAssets: () =>
          Promise.resolve(
            new Map([
              [
                'generated/skull-mace-var-2.png',
                {
                  issueUrl: 'https://github.com/nalfeo/Crawler/issues/41',
                  branch: 'assets/queued',
                  contentHash: 'hash-a',
                },
              ],
            ]),
          ),
      }),
    ).rejects.toMatchObject({
      kind: 'nothing-to-checkin',
      message: 'All approved art is already represented by an open asset-checkin issue.',
    });
    expect(calls.some((call) => call.command === 'gh' && call.args[0] === 'issue')).toBe(false);
  });

  it('passes ONLY the unqueued assets to copyArtSurface, excluding the already-queued PNG + its metadata', async () => {
    const { exec } = makeFakeExec((command, args) => {
      if (command === 'git' && args[0] === 'diff') {
        return {
          stdout:
            'public/assets/generated/skull-mace-var-2.png\n' +
            'public/assets/generated/iron-sword-var-1.png\n',
        };
      }
      if (command === 'gh') {
        return { stdout: 'https://github.com/nalfeo/Crawler/issues/42\n' };
      }
      return {};
    });
    const queued = new Map([
      [
        'generated/skull-mace-var-2.png',
        {
          issueUrl: 'https://github.com/nalfeo/Crawler/issues/41',
          branch: 'assets/queued',
          contentHash: 'hash-a',
        },
      ],
    ]);
    const copyArtSurfaceCalls: Array<{
      src: string;
      dest: string;
      assets: readonly CheckinAsset[];
    }> = [];

    const result = await runAssetCheckin('/repo', {
      ...baseDeps(),
      exec,
      readManifest: () =>
        Promise.resolve({
          entries: {
            'skull-mace-var-2': {
              assetPath: 'generated/skull-mace-var-2.png',
              contentHash: 'hash-a',
            },
          },
        }),
      listQueuedAssets: () => Promise.resolve(queued),
      copyArtSurface: (src, dest, assets) => {
        copyArtSurfaceCalls.push({ src, dest, assets });
        return Promise.resolve();
      },
    });

    // The branch's copy MUST NOT include the already-queued asset — the
    // branch diff and the filed issue payload must stay aligned (concern #2).
    expect(copyArtSurfaceCalls).toHaveLength(1);
    expect(copyArtSurfaceCalls[0]!.assets.map((a) => a.assetPath)).toEqual([
      'generated/iron-sword-var-1.png',
    ]);
    expect(
      copyArtSurfaceCalls[0]!.assets.some((a) => a.assetPath === 'generated/skull-mace-var-2.png'),
    ).toBe(false);
    // The filed issue's OWN payload agrees: only the unqueued asset is claimed.
    expect(result.plan.assets.map((a) => a.assetPath)).toEqual(['generated/iron-sword-var-1.png']);
  });

  it('links open floor2 asset-request issues into the filed check-in payload', async () => {
    const { exec } = makeFakeExec((command, args) => {
      if (command === 'git' && args[0] === 'diff') {
        return { stdout: 'public/assets/generated/butcher-hook-var-2.png\n' };
      }
      if (
        command === 'gh' &&
        args[0] === 'issue' &&
        args[1] === 'list' &&
        args.includes('asset-request')
      ) {
        return {
          stdout: JSON.stringify([
            {
              number: 2428,
              body: '### Name\n\nbutcher-hook\n\n### Brief\n\nA brutal cleaver hook for Floor 2.',
            },
            {
              number: 2429,
              body: '### Name\n\nnot-in-this-checkin\n\n### Brief\n\nAnother valid request body.',
            },
          ]),
        };
      }
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'create') {
        return { stdout: 'https://github.com/nalfeo/Crawler/issues/42\n' };
      }
      return {};
    });

    const result = await runAssetCheckin('/repo', {
      ...baseDeps(),
      exec,
      readManifest: () =>
        Promise.resolve({
          entries: {
            'butcher-hook-var-2': {
              assetPath: 'generated/butcher-hook-var-2.png',
              briefId: 'butcher-hook',
              variantIndex: 2,
            },
          },
        }),
    });

    expect(result.plan.assetRequestIssueNumbers).toEqual([2428]);
    const payload = parseAssetIssueBody(result.plan.issueBody);
    expect(payload?.assetRequestIssueNumbers).toEqual([2428]);
  });

  it('fails closed before push when listing open asset-request issues fails', async () => {
    const { exec, calls } = makeFakeExec((command, args) => {
      if (command === 'git' && args[0] === 'diff') {
        return { stdout: 'public/assets/generated/butcher-hook-var-2.png\n' };
      }
      if (
        command === 'gh' &&
        args[0] === 'issue' &&
        args[1] === 'list' &&
        args.includes('asset-request')
      ) {
        return { code: 1, stderr: 'rate limit exceeded' };
      }
      return {};
    });

    await expect(
      runAssetCheckin('/repo', {
        ...baseDeps(),
        exec,
        readManifest: () =>
          Promise.resolve({
            entries: {
              'butcher-hook-var-2': {
                assetPath: 'generated/butcher-hook-var-2.png',
                briefId: 'butcher-hook',
                variantIndex: 2,
              },
            },
          }),
      }),
    ).rejects.toMatchObject({
      kind: 'gh-failed',
      message: expect.stringContaining('Failed to list open asset-request issues'),
    });

    const commandLine = calls.map((c) => `${c.command} ${c.args.join(' ')}`);
    expect(
      commandLine.some((line) => line.startsWith('git push --no-verify -u origin assets/')),
    ).toBe(false);
    expect(commandLine.some((line) => line.startsWith('gh issue create'))).toBe(false);
  });

  it('fails closed before push when gh issue list returns malformed JSON', async () => {
    const { exec, calls } = makeFakeExec((command, args) => {
      if (command === 'git' && args[0] === 'diff') {
        return { stdout: 'public/assets/generated/butcher-hook-var-2.png\n' };
      }
      if (
        command === 'gh' &&
        args[0] === 'issue' &&
        args[1] === 'list' &&
        args.includes('asset-request')
      ) {
        return { stdout: '{not-json' };
      }
      return {};
    });

    await expect(
      runAssetCheckin('/repo', {
        ...baseDeps(),
        exec,
        readManifest: () =>
          Promise.resolve({
            entries: {
              'butcher-hook-var-2': {
                assetPath: 'generated/butcher-hook-var-2.png',
                briefId: 'butcher-hook',
                variantIndex: 2,
              },
            },
          }),
      }),
    ).rejects.toMatchObject({
      kind: 'gh-failed',
      message: expect.stringContaining('Failed to parse open asset-request issues from gh output'),
    });

    const commandLine = calls.map((c) => `${c.command} ${c.args.join(' ')}`);
    expect(
      commandLine.some((line) => line.startsWith('git push --no-verify -u origin assets/')),
    ).toBe(false);
    expect(commandLine.some((line) => line.startsWith('gh issue create'))).toBe(false);
  });

  it('cuts a branch, pushes (no PR), and files the issue', async () => {
    const { exec, calls } = makeFakeExec((command, args) => {
      if (command === 'git' && args[0] === 'diff') {
        return { stdout: 'public/assets/generated/skull-mace-var-2.png\n' };
      }
      if (command === 'gh') {
        return { stdout: 'https://github.com/nalfeo/Crawler/issues/42\n' };
      }
      return {};
    });

    const result = await runAssetCheckin('/repo', {
      ...baseDeps(),
      exec,
      readManifest: () =>
        Promise.resolve({
          entries: {
            'skull-mace-var-2': {
              assetPath: 'generated/skull-mace-var-2.png',
              briefId: 'skull-mace',
              variantIndex: 2,
            },
          },
        }),
    });

    expect(result.issueUrl).toBe('https://github.com/nalfeo/Crawler/issues/42');
    expect(result.branch).toBe(result.plan.branch);

    const commandLine = calls.map((c) => `${c.command} ${c.args.join(' ')}`);
    // fetch base, diff, worktree add, add, commit, push, gh issue create, worktree remove.
    expect(commandLine.some((l) => l.startsWith('git fetch origin main'))).toBe(true);
    expect(commandLine.some((l) => l.includes('worktree add'))).toBe(true);
    expect(commandLine.some((l) => l.startsWith('git commit --no-verify -m'))).toBe(true);
    expect(commandLine.some((l) => l.startsWith('git push --no-verify -u origin assets/'))).toBe(
      true,
    );
    expect(commandLine.some((l) => l.startsWith('gh issue create'))).toBe(true);
    // The check-in label is ensured before filing so a fresh repo doesn't fail.
    expect(commandLine.some((l) => l.startsWith('gh label create asset-checkin'))).toBe(true);
    // No PR is ever opened.
    expect(commandLine.some((l) => l.includes('pr create'))).toBe(false);
    // The pushed asset is enriched from the manifest.
    expect(result.plan.assets[0]).toMatchObject({ briefId: 'skull-mace', variantIndex: 2 });
  });

  it('removes the throwaway worktree even when push fails', async () => {
    const { exec, calls } = makeFakeExec((command, args) => {
      if (command === 'git' && args[0] === 'diff') {
        return { stdout: 'public/assets/generated/skull-mace-var-2.png\n' };
      }
      if (command === 'git' && args[0] === 'push') {
        return { code: 1, stderr: 'remote rejected' };
      }
      return {};
    });

    await expect(runAssetCheckin('/repo', { ...baseDeps(), exec })).rejects.toBeInstanceOf(
      CheckinError,
    );
    const commandLine = calls.map((c) => `${c.command} ${c.args.join(' ')}`);
    expect(commandLine.some((l) => l.includes('worktree remove'))).toBe(true);
  });

  it('deletes the pushed branch when issue creation fails (no orphaned branch)', async () => {
    const { exec, calls } = makeFakeExec((command, args) => {
      if (command === 'git' && args[0] === 'diff') {
        return { stdout: 'public/assets/generated/skull-mace-var-2.png\n' };
      }
      // Label ensure succeeds; the issue create fails (e.g. transient gh error).
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'create') {
        return { code: 1, stderr: 'could not create issue' };
      }
      return {};
    });

    await expect(runAssetCheckin('/repo', { ...baseDeps(), exec })).rejects.toBeInstanceOf(
      CheckinError,
    );
    const commandLine = calls.map((c) => `${c.command} ${c.args.join(' ')}`);
    // The orphaned remote branch is cleaned up so it isn't left untracked.
    expect(commandLine.some((l) => l.startsWith('git push origin --delete assets/'))).toBe(true);
  });
});

describe('detectApprovedAssets', () => {
  it('maps changed PNGs to repo-relative-under-public/assets paths and enriches them', async () => {
    const { exec } = makeFakeExec((command, args) => {
      if (command === 'git' && args[0] === 'diff') {
        return {
          stdout:
            'public/assets/generated/foo-var-1.png\n' +
            'public/assets/generated/manifest.json\n' + // non-png ignored
            'public/assets/generated/bar-var-3.png\n',
        };
      }
      return {};
    });
    const assets = await detectApprovedAssets(exec, '/repo', 'origin', 'main', {
      entries: {
        'foo-var-1': { assetPath: 'generated/foo-var-1.png', briefId: 'foo', variantIndex: 1 },
      },
    });
    expect(assets).toEqual([
      {
        assetPath: 'generated/foo-var-1.png',
        manifestKey: 'foo-var-1',
        briefId: 'foo',
        variantIndex: 1,
      },
      {
        assetPath: 'generated/bar-var-3.png',
        manifestKey: null,
        briefId: null,
        variantIndex: null,
      },
    ]);
  });

  it('includes freshly approved UNTRACKED PNGs via git ls-files --others', async () => {
    const { exec } = makeFakeExec((command, args) => {
      // Only the tracked manifest changed in the diff; the new variant PNG is
      // untracked (written by copyFileSync, never git-added).
      if (command === 'git' && args[0] === 'diff') {
        return { stdout: 'public/assets/generated/manifest.json\n' };
      }
      if (command === 'git' && args[0] === 'ls-files') {
        return { stdout: 'public/assets/generated/new-mace-var-1.png\n' };
      }
      return {};
    });
    const assets = await detectApprovedAssets(exec, '/repo', 'origin', 'main', {});
    expect(assets.map((a) => a.assetPath)).toEqual(['generated/new-mace-var-1.png']);
  });

  it('de-duplicates a PNG that appears in both diff and ls-files', async () => {
    const { exec } = makeFakeExec((command, args) => {
      if (command === 'git' && args[0] === 'diff') {
        return { stdout: 'public/assets/generated/dup-var-1.png\n' };
      }
      if (command === 'git' && args[0] === 'ls-files') {
        return { stdout: 'public/assets/generated/dup-var-1.png\n' };
      }
      return {};
    });
    const assets = await detectApprovedAssets(exec, '/repo', 'origin', 'main', {});
    expect(assets.map((a) => a.assetPath)).toEqual(['generated/dup-var-1.png']);
  });
});
