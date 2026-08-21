/** Production filesystem/process wiring for the source-bound queue recovery. */

import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeCheckinFileLock, realExec } from './checkin-runtime.js';
import type { Exec } from './checkin.js';
import type { SpriteAnnotationUpdate } from './queue-commit.js';
import type { QueueRepairDeps, RecoveryGroup } from './queue-repair.js';

const SUBPROCESS_TIMEOUT_MS = 120_000;

function nonInteractiveGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GCM_INTERACTIVE: 'never',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
    LANG: 'C',
  };
}

function validateSelectedGroups(worktree: string, groups: readonly RecoveryGroup[]): void {
  for (const group of groups) {
    const png = path.join(worktree, ...group.pngPath.split('/'));
    const shard = path.join(worktree, ...group.shardPath.split('/'));
    if (!existsSync(png) || !existsSync(shard)) {
      throw new Error(`${group.key} must contain both ${group.pngPath} and ${group.shardPath}.`);
    }
    let entry: { assetPath?: unknown; contentHash?: unknown };
    try {
      entry = JSON.parse(readFileSync(shard, 'utf8')) as {
        assetPath?: unknown;
        contentHash?: unknown;
      };
    } catch (error) {
      throw new Error(
        `${group.shardPath} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const expectedPath = `generated/${group.key}.png`;
    const actualHash = createHash('sha256').update(readFileSync(png)).digest('hex');
    if (
      entry.assetPath !== expectedPath ||
      typeof entry.contentHash !== 'string' ||
      entry.contentHash !== actualHash
    ) {
      throw new Error(
        `${group.key} failed integrity: shard assetPath/contentHash must match ${expectedPath} and PNG bytes.`,
      );
    }
  }
}

function mergeAnnotations(worktree: string, updates: readonly SpriteAnnotationUpdate[]): void {
  const relative = 'public/assets/generated/sprite-editor-annotations.json';
  const target = path.join(worktree, ...relative.split('/'));
  let sprites: Record<string, unknown> = {};
  if (existsSync(target)) {
    const parsed = JSON.parse(readFileSync(target, 'utf8')) as { sprites?: unknown };
    if (
      typeof parsed.sprites !== 'object' ||
      parsed.sprites === null ||
      Array.isArray(parsed.sprites)
    ) {
      throw new Error(`${relative} must contain an object-valued sprites map.`);
    }
    sprites = { ...(parsed.sprites as Record<string, unknown>) };
  }
  for (const update of updates) {
    sprites[update.key] = {
      favorite: update.favorite,
      disliked: update.disliked,
      comment: update.comment,
    };
  }
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ version: 1, sprites }, null, 2)}\n`, 'utf8');
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function createDefaultQueueRepairDeps(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  withCrossProcessLock = true,
): QueueRepairDeps {
  const gitEnv = nonInteractiveGitEnv(env);
  const exec: Exec = (command, args, options) =>
    realExec(command, args, {
      ...options,
      env: options?.env ?? gitEnv,
      timeoutMs: options?.timeoutMs ?? SUBPROCESS_TIMEOUT_MS,
    });
  return {
    exec,
    validateSelectedGroups: async (worktree, groups) => validateSelectedGroups(worktree, groups),
    mergeAnnotations: async (worktree, updates) => mergeAnnotations(worktree, updates),
    makeTempDir: () => Promise.resolve(mkdtempSync(path.join(tmpdir(), 'asset-queue-repair-'))),
    removeDir: async (dir) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          rmSync(dir, { recursive: true, force: true });
          return;
        } catch {
          if (attempt === 4) return;
          await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
        }
      }
    },
    ...(withCrossProcessLock ? { withCrossProcessLock: makeCheckinFileLock(repoRoot) } : {}),
  };
}
