/** Real-git tests for the one-time, source-bound ACC queue recovery policy. */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SELECTIVE_RECOVERY_POLICY,
  runQueueRepair,
} from '../../../scripts/sprites/queue-repair.js';
import { createDefaultQueueRepairDeps } from '../../../scripts/sprites/queue-repair-runtime.js';
import { main as pruneStaleQueueDuplicates } from '../../../scripts/sprites/prune-stale-queue-duplicates.js';

const GIT_TIMEOUT_MS = 60_000;
const PNG_A = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]);
const RECOVERY_GROUP_KEYS = [
  'llama-curb-stomper-var-0',
  'welcome-room-bookcase-var-0',
  'welcome-room-bunk-bed-var-6',
  'welcome-room-camera-rig-var-4',
  'welcome-room-crate-stack-var-3',
  'welcome-room-desk-var-0',
  'welcome-room-exit-sign-var-0',
  'welcome-room-floor-plate-cable-run-var-4',
  'welcome-room-kitchenette-var-0',
  'welcome-room-lounge-stool-var-1',
  'welcome-room-show-poster-var-0',
  'welcome-room-side-table-var-12',
  'welcome-room-wall-banner-var-6',
  'welcome-room-wall-shelf-var-0',
] as const;
const RECOVERY_ANNOTATION_KEYS = Array.from(
  { length: 52 },
  (_, index) => `recovery-annotation-${index}`,
);

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function asset(repo: string, key: string): void {
  const generated = path.join(repo, 'public', 'assets', 'generated');
  const bytes = PNG_A;
  mkdirSync(generated, { recursive: true });
  writeFileSync(path.join(generated, `${key}.png`), bytes);
  writeJson(path.join(generated, 'entries', `${key}.json`), {
    assetPath: `generated/${key}.png`,
    spriteName: key,
    contentHash: createHash('sha256').update(bytes).digest('hex'),
  });
}

interface Repo {
  readonly root: string;
  readonly origin: string;
  readonly source: string;
  readonly sourceSha: string;
  readonly live: string;
}

function annotations(value: 'parent' | 'source'): { version: 1; sprites: Record<string, unknown> } {
  return {
    version: 1,
    sprites: Object.fromEntries(
      RECOVERY_ANNOTATION_KEYS.map((key) => [
        key,
        {
          favorite: value === 'source',
          disliked: false,
          comment: `${value} ${key}`,
        },
      ]),
    ),
  };
}

function setup(): Repo {
  const root = mkdtempSync(path.join(tmpdir(), 'queue-recovery-'));
  const origin = path.join(root, 'origin.git');
  const source = path.join(root, 'source');
  const live = path.join(root, 'live');
  mkdirSync(origin);
  mkdirSync(source);
  mkdirSync(live);
  git(origin, 'init', '--bare', '-b', 'main');
  git(source, 'init', '-b', 'main');
  git(source, 'config', 'user.email', 'test@example.com');
  git(source, 'config', 'user.name', 'Queue Recovery Test');
  git(source, 'config', 'commit.gpgsign', 'false');
  writeJson(
    path.join(source, 'public/assets/generated/sprite-editor-annotations.json'),
    annotations('parent'),
  );
  git(source, 'add', '-A');
  git(source, 'commit', '-m', 'source parent');
  for (const key of RECOVERY_GROUP_KEYS) asset(source, key);
  asset(source, 'batfolk-boss-var-0'); // An ACC revision deliberately excluded by policy.
  writeJson(
    path.join(source, 'public/assets/generated/sprite-editor-annotations.json'),
    annotations('source'),
  );
  git(source, 'add', '-A');
  git(source, 'commit', '-m', 'selective recovery source');
  const sourceSha = git(source, 'rev-parse', 'HEAD').trim();

  git(live, 'init', '-b', 'main');
  git(live, 'config', 'user.email', 'test@example.com');
  git(live, 'config', 'user.name', 'Queue Recovery Test');
  git(live, 'config', 'commit.gpgsign', 'false');
  git(live, 'remote', 'add', 'origin', origin.split(path.sep).join('/'));
  asset(live, 'alpha');
  asset(live, 'batfolk-boss-var-0'); // An ACC revision deliberately excluded by policy.
  writeJson(path.join(live, 'public/assets/generated/sprite-editor-annotations.json'), {
    version: 1,
    sprites: {
      'main-only': { favorite: true, disliked: false, comment: 'preserve me' },
      'welcome-room-desk-var-0': { favorite: false, disliked: false, comment: 'main value' },
    },
  });
  git(live, 'add', '-A');
  git(live, 'commit', '-m', 'current main');
  git(live, 'push', 'origin', 'main');
  git(live, 'push', 'origin', 'main:refs/heads/assets/queue');
  return { root, origin, source, sourceSha, live };
}

function corruptQueue(live: string): void {
  const queue = mkdtempSync(path.join(tmpdir(), 'queue-recovery-queue-'));
  try {
    git(live, 'fetch', '--no-tags', 'origin', 'assets/queue');
    git(live, 'worktree', 'add', queue, '--detach', 'FETCH_HEAD');
    // This models the 1c failure mode: generated pair deletion on a broad queue
    // surface. The source-bound recovery must not retain any unrelated queue data.
    rmSync(path.join(queue, 'public/assets/generated/alpha.png'));
    rmSync(path.join(queue, 'public/assets/generated/entries/alpha.json'));
    writeFileSync(path.join(queue, 'public/assets/generated/unrelated.png'), PNG_A);
    git(queue, 'add', '-A');
    git(queue, 'commit', '-m', 'corrupt whole-surface prune');
    const sha = git(queue, 'rev-parse', 'HEAD').trim();
    git(live, 'push', 'origin', `${sha}:refs/heads/assets/queue`);
  } finally {
    try {
      git(live, 'worktree', 'remove', '--force', queue);
    } catch {
      // Test cleanup.
    }
    rmSync(queue, { recursive: true, force: true });
  }
}

function jsonAt(cwd: string, ref: string, file: string): unknown {
  return JSON.parse(
    execFileSync('git', ['show', `${ref}:${file}`], {
      cwd,
      encoding: 'utf8',
    }),
  );
}

function freshDeps(repo: string, immutableSourceSha: string) {
  const env = { ...process.env };
  delete env.CI;
  return { ...createDefaultQueueRepairDeps(repo, env), immutableSourceSha };
}

describe('runQueueRepair (real git)', () => {
  const cleanups: string[] = [];
  afterEach(() => {
    for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  describe('prune-stale-queue-duplicates CLI', () => {
    function writeDuplicatePair(
      generated: string,
      key: string,
      briefId: string,
      bytes: Buffer,
      contentHash: string,
    ): void {
      mkdirSync(path.join(generated, 'entries'), { recursive: true });
      writeFileSync(path.join(generated, `${key}.png`), bytes);
      writeJson(path.join(generated, 'entries', `${key}.json`), {
        assetPath: `generated/${key}.png`,
        briefId,
        contentHash,
        variantIndex: 0,
      });
    }

    it('fails closed before deleting a same-content pair without a source-bound removal manifest', async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'queue-prune-'));
      const queue = path.join(root, 'queue', 'public/assets/generated');
      const main = path.join(root, 'main', 'public/assets/generated');
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x99]);
      const hash = createHash('sha256').update(bytes).digest('hex');
      for (const [generated, key, briefId] of [
        [queue, 'golem-v1-var-0', 'golem-v1'],
        [main, 'golem-var-0', 'golem'],
      ] as const) {
        mkdirSync(path.join(generated, 'entries'), { recursive: true });
        writeFileSync(path.join(generated, `${key}.png`), bytes);
        writeJson(path.join(generated, 'entries', `${key}.json`), {
          assetPath: `generated/${key}.png`,
          briefId,
          contentHash: hash,
          variantIndex: 0,
        });
      }
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const code = await pruneStaleQueueDuplicates([
          '--apply',
          '--queue-generated-dir',
          queue,
          '--main-generated-dir',
          main,
        ]);
        expect(code).toBe(1);
        expect(stderr).toHaveBeenCalledWith(expect.stringContaining('--removal-manifest'));
        expect(existsSync(path.join(queue, 'golem-v1-var-0.png'))).toBe(true);
        expect(existsSync(path.join(queue, 'entries', 'golem-v1-var-0.json'))).toBe(true);
      } finally {
        stderr.mockRestore();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('refuses apply when queue/main PNG bytes do not match manifest contentHash', async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'queue-prune-hash-'));
      const queueRepo = path.join(root, 'queue');
      const mainRepo = path.join(root, 'main');
      const queue = path.join(queueRepo, 'public/assets/generated');
      const main = path.join(mainRepo, 'public/assets/generated');
      mkdirSync(queueRepo, { recursive: true });
      mkdirSync(mainRepo, { recursive: true });
      git(queueRepo, 'init', '-b', 'main');
      git(queueRepo, 'config', 'user.email', 'test@example.com');
      git(queueRepo, 'config', 'user.name', 'Queue Recovery Test');
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xaa]);
      const queueBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xbb]);
      const hash = createHash('sha256').update(bytes).digest('hex');
      writeDuplicatePair(main, 'golem-var-0', 'golem', bytes, hash);
      writeDuplicatePair(queue, 'golem-v1-var-0', 'golem-v1', queueBytes, hash);
      writeJson(path.join(queue, 'sprite-editor-annotations.json'), { version: 1, sprites: {} });
      git(queueRepo, 'add', '-A');
      git(queueRepo, 'commit', '-m', 'queue setup');
      const sourceSha = git(queueRepo, 'rev-parse', 'HEAD').trim();
      const manifestPath = path.join(root, 'manifest.json');
      writeJson(manifestPath, {
        version: 1,
        sourceSha,
        normalization: 'bare-concept-v1',
        removals: [
          {
            key: 'golem-v1-var-0',
            duplicateOf: 'golem-var-0',
            contentHash: hash,
          },
        ],
      });
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const code = await pruneStaleQueueDuplicates([
          '--apply',
          '--queue-generated-dir',
          queue,
          '--main-generated-dir',
          main,
          '--source-sha',
          sourceSha,
          '--removal-manifest',
          manifestPath,
        ]);
        expect(code).toBe(1);
        expect(stderr).toHaveBeenCalledWith(
          expect.stringContaining('same-content duplicate under bare-concept-v1'),
        );
        expect(existsSync(path.join(queue, 'golem-v1-var-0.png'))).toBe(true);
        expect(existsSync(path.join(queue, 'entries', 'golem-v1-var-0.json'))).toBe(true);
      } finally {
        stderr.mockRestore();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('refuses apply when queue checkout HEAD does not match --source-sha', async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'queue-prune-head-'));
      const queueRepo = path.join(root, 'queue');
      const mainRepo = path.join(root, 'main');
      const queue = path.join(queueRepo, 'public/assets/generated');
      const main = path.join(mainRepo, 'public/assets/generated');
      mkdirSync(queueRepo, { recursive: true });
      mkdirSync(mainRepo, { recursive: true });
      git(queueRepo, 'init', '-b', 'main');
      git(queueRepo, 'config', 'user.email', 'test@example.com');
      git(queueRepo, 'config', 'user.name', 'Queue Recovery Test');
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xcc]);
      const hash = createHash('sha256').update(bytes).digest('hex');
      writeDuplicatePair(main, 'golem-var-0', 'golem', bytes, hash);
      writeDuplicatePair(queue, 'golem-v1-var-0', 'golem-v1', bytes, hash);
      writeJson(path.join(queue, 'sprite-editor-annotations.json'), { version: 1, sprites: {} });
      git(queueRepo, 'add', '-A');
      git(queueRepo, 'commit', '-m', 'queue setup');
      const sourceSha = git(queueRepo, 'rev-parse', 'HEAD').trim();
      const manifestPath = path.join(root, 'manifest.json');
      writeJson(manifestPath, {
        version: 1,
        sourceSha,
        normalization: 'bare-concept-v1',
        removals: [
          {
            key: 'golem-v1-var-0',
            duplicateOf: 'golem-var-0',
            contentHash: hash,
          },
        ],
      });
      writeFileSync(path.join(queueRepo, 'touch.txt'), 'drift');
      git(queueRepo, 'add', '-A');
      git(queueRepo, 'commit', '-m', 'drift');
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const code = await pruneStaleQueueDuplicates([
          '--apply',
          '--queue-generated-dir',
          queue,
          '--main-generated-dir',
          main,
          '--source-sha',
          sourceSha,
          '--removal-manifest',
          manifestPath,
        ]);
        expect(code).toBe(1);
        expect(stderr).toHaveBeenCalledWith(expect.stringContaining('does not match --source-sha'));
        expect(existsSync(path.join(queue, 'golem-v1-var-0.png'))).toBe(true);
      } finally {
        stderr.mockRestore();
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it(
    'reconstructs current main plus exactly ACC llama/welcome groups and the 52-key annotation delta',
    async () => {
      const { root, source, sourceSha, live } = setup();
      cleanups.push(root);
      corruptQueue(live);

      const audit = await runQueueRepair(live, freshDeps(live, sourceSha), {
        mode: 'audit',
        policy: SELECTIVE_RECOVERY_POLICY,
        remote: 'origin',
        sourceRemote: source,
      });
      expect(audit.status).toBe('audited');
      expect(audit.sourceSha).toBe(sourceSha);
      expect(audit.selectedGroups.map((group) => group.key)).toEqual(RECOVERY_GROUP_KEYS);
      expect(audit.annotationKeysApplied).toEqual(
        [...RECOVERY_ANNOTATION_KEYS].sort((left, right) => left.localeCompare(right)),
      );
      expect(
        audit.discardedChanges.some((change) => change.path.endsWith('batfolk-boss-var-0.png')),
      ).toBe(true);

      const result = await runQueueRepair(live, freshDeps(live, sourceSha), {
        mode: 'apply',
        policy: SELECTIVE_RECOVERY_POLICY,
        remote: 'origin',
        sourceRemote: source,
        expectedMainSha: audit.mainSha,
        expectedQueueSha: audit.queueSha,
      });
      expect(result.status).toBe('repaired');
      expect(result.backupRef).toBe(`refs/asset-queue-backups/${audit.queueSha}`);

      git(live, 'fetch', '--no-tags', 'origin', 'main', 'assets/queue');
      const changed = git(
        live,
        'diff',
        '--no-renames',
        '--name-only',
        'origin/main',
        'origin/assets/queue',
        '--',
        'public/assets/generated',
      )
        .trim()
        .split('\n')
        .filter(Boolean)
        .sort();
      const expected = [
        ...result.selectedGroups.flatMap((group) => [group.pngPath, group.shardPath]),
        'public/assets/generated/sprite-editor-annotations.json',
      ].sort();
      expect(changed).toEqual(expected);

      for (const group of result.selectedGroups) {
        expect(git(live, 'rev-parse', `origin/assets/queue:${group.pngPath}`).trim()).toBe(
          git(source, 'rev-parse', `${sourceSha}:${group.pngPath}`).trim(),
        );
        expect(git(live, 'rev-parse', `origin/assets/queue:${group.shardPath}`).trim()).toBe(
          git(source, 'rev-parse', `${sourceSha}:${group.shardPath}`).trim(),
        );
      }
      // ACC's unselected visual edit is absent: current main remains authoritative.
      expect(
        git(
          live,
          'rev-parse',
          'origin/assets/queue:public/assets/generated/batfolk-boss-var-0.png',
        ).trim(),
      ).toBe(
        git(live, 'rev-parse', 'origin/main:public/assets/generated/batfolk-boss-var-0.png').trim(),
      );
      expect(() =>
        git(live, 'rev-parse', 'origin/assets/queue:public/assets/generated/unrelated.png'),
      ).toThrow();

      const queueAnnotations = jsonAt(
        live,
        'origin/assets/queue',
        'public/assets/generated/sprite-editor-annotations.json',
      ) as { sprites: Record<string, unknown> };
      const sourceAnnotations = jsonAt(
        source,
        sourceSha,
        'public/assets/generated/sprite-editor-annotations.json',
      ) as { sprites: Record<string, unknown> };
      expect(queueAnnotations.sprites['main-only']).toEqual({
        favorite: true,
        disliked: false,
        comment: 'preserve me',
      });
      for (const key of result.annotationKeysApplied) {
        expect(queueAnnotations.sprites[key]).toEqual(sourceAnnotations.sprites[key]);
      }
      expect(git(live, 'ls-remote', 'origin', result.backupRef!)).toContain(audit.queueSha);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    'aborts before backup/rewrite when the audited queue or main snapshot drifts',
    async () => {
      const { root, source, sourceSha, live } = setup();
      cleanups.push(root);
      corruptQueue(live);
      const audit = await runQueueRepair(live, freshDeps(live, sourceSha), {
        mode: 'audit',
        remote: 'origin',
        sourceRemote: source,
      });
      // Advance queue after audit: expected OID binding must abort before mutation.
      git(live, 'fetch', '--no-tags', 'origin', 'assets/queue');
      git(live, 'reset', '--hard', 'origin/assets/queue');
      writeFileSync(path.join(live, 'queue-drift.txt'), 'queue');
      git(live, 'add', '-A');
      git(live, 'commit', '-m', 'queue drift');
      const driftSha = git(live, 'rev-parse', 'HEAD').trim();
      git(live, 'push', 'origin', `${driftSha}:refs/heads/assets/queue`);
      await expect(
        runQueueRepair(live, freshDeps(live, sourceSha), {
          mode: 'apply',
          remote: 'origin',
          sourceRemote: source,
          expectedMainSha: audit.mainSha,
          expectedQueueSha: audit.queueSha,
        }),
      ).rejects.toMatchObject({ kind: 'source-drift' });
      expect(git(live, 'ls-remote', 'origin', `refs/asset-queue-backups/${audit.queueSha}`)).toBe(
        '',
      );

      // A separate audit then a main advance exercises the other CAS binding.
      const secondAudit = await runQueueRepair(live, freshDeps(live, sourceSha), {
        mode: 'audit',
        remote: 'origin',
        sourceRemote: source,
      });
      git(live, 'fetch', '--no-tags', 'origin', 'main');
      git(live, 'reset', '--hard', 'origin/main');
      writeFileSync(path.join(live, 'main-drift.txt'), 'main');
      git(live, 'add', '-A');
      git(live, 'commit', '-m', 'main drift');
      git(live, 'push', 'origin', 'HEAD:main');
      await expect(
        runQueueRepair(live, freshDeps(live, sourceSha), {
          mode: 'apply',
          remote: 'origin',
          sourceRemote: source,
          expectedMainSha: secondAudit.mainSha,
          expectedQueueSha: secondAudit.queueSha,
        }),
      ).rejects.toMatchObject({ kind: 'source-drift' });
    },
    GIT_TIMEOUT_MS,
  );
});
