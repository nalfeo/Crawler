/**
 * One-time, source-bound recovery for the 2026-08 asset queue corruption.
 *
 * This intentionally does not infer provenance from a merge-base.  The queue
 * predates the taxonomy migration, so that heuristic would treat legitimate
 * renames and edits as disposable.  The policy below is an audited exception:
 * start from current main and copy only the named ACC snapshot paths.
 */

import type { SpriteAnnotationUpdate } from './queue-commit.js';
import type { Exec } from './checkin.js';

export const SELECTIVE_RECOVERY_POLICY = 'acc25eda-selective-v1';
export const SELECTIVE_RECOVERY_SOURCE_SHA = 'acc25eda2680af595f65d5248ed53049d1fe9ab3';
export const SELECTIVE_RECOVERY_ANNOTATION_DELTA_COUNT = 52;

const GENERATED_ROOT = 'public/assets/generated';
const ANNOTATIONS_PATH = `${GENERATED_ROOT}/sprite-editor-annotations.json`;
const SELECTED_GROUP_KEYS = [
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

export type QueueRepairMode = 'audit' | 'apply';

export interface RecoveryGroup {
  readonly key: string;
  readonly pngPath: string;
  readonly shardPath: string;
}

export interface DiscardedChange {
  readonly status: string;
  readonly path: string;
}

export interface QueueRepairDeps {
  readonly exec: Exec;
  /**
   * Test-only replacement for the production policy's immutable source SHA.
   * Production callers do not provide this, so they remain pinned to ACC.
   */
  readonly immutableSourceSha?: string;
  readonly makeTempDir: () => Promise<string>;
  readonly removeDir: (dir: string) => Promise<void>;
  readonly validateSelectedGroups: (
    worktree: string,
    groups: readonly RecoveryGroup[],
  ) => Promise<void>;
  readonly mergeAnnotations: (
    worktree: string,
    updates: readonly SpriteAnnotationUpdate[],
  ) => Promise<void>;
  readonly withCrossProcessLock?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface QueueRepairOptions {
  readonly mode: QueueRepairMode;
  readonly policy?: string;
  readonly remote?: string;
  /** Test-only alternate remote for the immutable source snapshot. */
  readonly sourceRemote?: string;
  readonly baseBranch?: string;
  readonly queueBranch?: string;
  /** Required for apply: values emitted by a preceding audit. */
  readonly expectedMainSha?: string;
  readonly expectedQueueSha?: string;
}

export interface QueueRepairResult {
  readonly status: 'audited' | 'repaired';
  readonly policy: typeof SELECTIVE_RECOVERY_POLICY;
  readonly sourceSha: string;
  readonly sourceParentSha: string;
  readonly mainSha: string;
  readonly queueSha: string;
  readonly selectedGroups: readonly RecoveryGroup[];
  readonly annotationKeysApplied: readonly string[];
  readonly discardedChanges: readonly DiscardedChange[];
  readonly backupRef?: string;
}

export class QueueRepairError extends Error {
  constructor(
    readonly kind: 'usage' | 'git-failed' | 'source-invalid' | 'source-drift',
    message: string,
  ) {
    super(message);
    this.name = 'QueueRepairError';
  }
}

function selectedGroups(): readonly RecoveryGroup[] {
  return SELECTED_GROUP_KEYS.map((key) => ({
    key,
    pngPath: `${GENERATED_ROOT}/${key}.png`,
    shardPath: `${GENERATED_ROOT}/entries/${key}.json`,
  }));
}

async function git(
  exec: Exec,
  cwd: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return exec('git', args, { cwd });
}

async function mustGit(exec: Exec, cwd: string, args: readonly string[]): Promise<string> {
  const result = await git(exec, cwd, args);
  if (result.code !== 0) {
    throw new QueueRepairError(
      'git-failed',
      `git ${args.join(' ')} failed (exit ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function parseAnnotationDocument(text: string, ref: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new QueueRepairError(
      'source-invalid',
      `${ANNOTATIONS_PATH} is invalid JSON at ${ref}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const sprites = (value as { sprites?: unknown })?.sprites;
  if (typeof sprites !== 'object' || sprites === null || Array.isArray(sprites)) {
    throw new QueueRepairError(
      'source-invalid',
      `${ANNOTATIONS_PATH} at ${ref} has no sprites map.`,
    );
  }
  const result: Record<string, unknown> = {};
  for (const [key, annotation] of Object.entries(sprites)) {
    if (typeof annotation !== 'object' || annotation === null || Array.isArray(annotation)) {
      throw new QueueRepairError(
        'source-invalid',
        `${ANNOTATIONS_PATH} at ${ref} has an invalid annotation for ${key}.`,
      );
    }
    result[key] = annotation;
  }
  return result;
}

function annotationDelta(
  parent: Record<string, unknown>,
  source: Record<string, unknown>,
  sourceSha: string,
): readonly SpriteAnnotationUpdate[] {
  const keys = [...new Set([...Object.keys(parent), ...Object.keys(source)])].sort((a, b) =>
    a.localeCompare(b),
  );
  const updates = keys.filter((key) => JSON.stringify(parent[key]) !== JSON.stringify(source[key]));
  if (updates.length !== SELECTIVE_RECOVERY_ANNOTATION_DELTA_COUNT) {
    throw new QueueRepairError(
      'source-invalid',
      `Policy ${SELECTIVE_RECOVERY_POLICY} expected ${SELECTIVE_RECOVERY_ANNOTATION_DELTA_COUNT} annotation deltas at ${sourceSha}, found ${updates.length}.`,
    );
  }
  const missing = updates.find((key) => source[key] === undefined);
  if (missing !== undefined) {
    throw new QueueRepairError(
      'source-invalid',
      `Policy ${SELECTIVE_RECOVERY_POLICY} cannot apply deleted annotation ${missing}; this policy permits updates only at ${sourceSha}.`,
    );
  }
  return updates.map((key) => {
    const value = source[key] as Partial<SpriteAnnotationUpdate>;
    if (
      typeof value.favorite !== 'boolean' ||
      typeof value.disliked !== 'boolean' ||
      typeof value.comment !== 'string'
    ) {
      throw new QueueRepairError(
        'source-invalid',
        `${ANNOTATIONS_PATH} at ${sourceSha} has no complete favorite/disliked/comment update for ${key}.`,
      );
    }
    return { key, favorite: value.favorite, disliked: value.disliked, comment: value.comment };
  });
}

function parseNameStatus(
  stdout: string,
  selectedPaths: ReadonlySet<string>,
): readonly DiscardedChange[] {
  const discarded: DiscardedChange[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const [status, ...paths] = line.split('\t');
    for (const path of paths) {
      if (path && path !== ANNOTATIONS_PATH && !selectedPaths.has(path)) {
        discarded.push({ status: status ?? '?', path });
      }
    }
  }
  return discarded.sort((left, right) => left.path.localeCompare(right.path));
}

async function remoteSha(
  exec: Exec,
  repoRoot: string,
  remote: string,
  branch: string,
): Promise<string> {
  const stdout = await mustGit(exec, repoRoot, ['ls-remote', '--heads', remote, branch]);
  const match = /^([0-9a-f]{40,64})\s/m.exec(stdout);
  if (!match) throw new QueueRepairError('git-failed', `Remote branch ${branch} does not exist.`);
  return match[1]!;
}

/**
 * Audit or apply the explicitly named recovery.  Apply always reconstructs from
 * current main; it never overlays the bad queue or invents a generic survivor
 * rule.  The expected main/queue OIDs are both checked before every remote write.
 */
export async function runQueueRepair(
  repoRoot: string,
  deps: QueueRepairDeps,
  options: QueueRepairOptions,
): Promise<QueueRepairResult> {
  if ((options.policy ?? SELECTIVE_RECOVERY_POLICY) !== SELECTIVE_RECOVERY_POLICY) {
    throw new QueueRepairError(
      'usage',
      `Unsupported recovery policy. Use --policy ${SELECTIVE_RECOVERY_POLICY}.`,
    );
  }
  if (
    options.mode === 'apply' &&
    (options.expectedMainSha === undefined || options.expectedQueueSha === undefined)
  ) {
    throw new QueueRepairError(
      'usage',
      '--apply requires --expect-main and --expect-queue from the preceding JSON audit.',
    );
  }

  const remote = options.remote ?? 'origin';
  const sourceRemote = options.sourceRemote ?? remote;
  const immutableSourceSha = deps.immutableSourceSha ?? SELECTIVE_RECOVERY_SOURCE_SHA;
  const baseBranch = options.baseBranch ?? 'main';
  const queueBranch = options.queueBranch ?? 'assets/queue';
  const withLock = deps.withCrossProcessLock ?? ((fn) => fn());

  return withLock(async () => {
    // The process-wide queue lock serializes recovery in one clone; PID keeps
    // scratch refs distinct across linked worktrees without making policy output
    // depend on a random value.
    const suffix = String(process.pid);
    const mainRef = `refs/queue-recovery/main-${suffix}`;
    const queueRef = `refs/queue-recovery/queue-${suffix}`;
    const sourceRef = `refs/queue-recovery/source-${suffix}`;
    let worktree: string | undefined;
    try {
      await mustGit(deps.exec, repoRoot, [
        'fetch',
        '--no-tags',
        remote,
        `+${baseBranch}:${mainRef}`,
        `+${queueBranch}:${queueRef}`,
      ]);
      await mustGit(deps.exec, repoRoot, [
        'fetch',
        '--no-tags',
        sourceRemote,
        `+${immutableSourceSha}:${sourceRef}`,
      ]);
      const [mainSha, queueSha, sourceSha, sourceParentSha] = await Promise.all([
        mustGit(deps.exec, repoRoot, ['rev-parse', mainRef]).then((value) => value.trim()),
        mustGit(deps.exec, repoRoot, ['rev-parse', queueRef]).then((value) => value.trim()),
        mustGit(deps.exec, repoRoot, ['rev-parse', sourceRef]).then((value) => value.trim()),
        mustGit(deps.exec, repoRoot, ['rev-parse', `${sourceRef}^`]).then((value) => value.trim()),
      ]);
      if (sourceSha !== immutableSourceSha) {
        throw new QueueRepairError(
          'source-invalid',
          `Fetched recovery source ${sourceSha}, expected immutable ${immutableSourceSha}.`,
        );
      }
      if (
        (options.expectedMainSha !== undefined && options.expectedMainSha !== mainSha) ||
        (options.expectedQueueSha !== undefined && options.expectedQueueSha !== queueSha)
      ) {
        throw new QueueRepairError(
          'source-drift',
          `Fetched main=${mainSha} queue=${queueSha}; re-run the audit before applying this recovery.`,
        );
      }

      const groups = selectedGroups();
      const selectedPaths = new Set(groups.flatMap((group) => [group.pngPath, group.shardPath]));
      const sourcePaths = new Set(
        (
          await mustGit(deps.exec, repoRoot, [
            'ls-tree',
            '-r',
            '--name-only',
            sourceRef,
            '--',
            ...selectedPaths,
          ])
        )
          .split(/\r?\n/)
          .filter(Boolean),
      );
      const missingSelectedPath = [...selectedPaths].find((path) => !sourcePaths.has(path));
      if (missingSelectedPath !== undefined) {
        throw new QueueRepairError(
          'source-invalid',
          `Recovery source ${immutableSourceSha} does not contain ${missingSelectedPath}.`,
        );
      }
      // Audit is evidence, not a mere path listing: validate every selected
      // PNG/shard pair against its contentHash before printing an applyable JSON
      // snapshot. This worktree is local-only and never stages or pushes.
      const sourceValidationWorktree = await deps.makeTempDir();
      try {
        await mustGit(deps.exec, repoRoot, [
          'worktree',
          'add',
          '--detach',
          '--no-checkout',
          sourceValidationWorktree,
          sourceRef,
        ]);
        await mustGit(deps.exec, sourceValidationWorktree, [
          'checkout',
          sourceRef,
          '--',
          ...groups.flatMap((group) => [group.pngPath, group.shardPath]),
        ]);
        await deps.validateSelectedGroups(sourceValidationWorktree, groups);
      } finally {
        try {
          await git(deps.exec, repoRoot, [
            'worktree',
            'remove',
            sourceValidationWorktree,
            '--force',
          ]);
        } catch {
          // Best-effort local cleanup.
        }
        try {
          await deps.removeDir(sourceValidationWorktree);
        } catch {
          // Best-effort local cleanup.
        }
      }
      const [parentAnnotations, sourceAnnotations, sourceDiff] = await Promise.all([
        mustGit(deps.exec, repoRoot, ['show', `${sourceParentSha}:${ANNOTATIONS_PATH}`]),
        mustGit(deps.exec, repoRoot, ['show', `${sourceRef}:${ANNOTATIONS_PATH}`]),
        mustGit(deps.exec, repoRoot, [
          'diff',
          '--no-renames',
          '--name-status',
          sourceParentSha,
          sourceRef,
          '--',
          GENERATED_ROOT,
        ]),
      ]);
      const updates = annotationDelta(
        parseAnnotationDocument(parentAnnotations, sourceParentSha),
        parseAnnotationDocument(sourceAnnotations, sourceSha),
        immutableSourceSha,
      );
      const result = {
        policy: SELECTIVE_RECOVERY_POLICY,
        sourceSha: immutableSourceSha,
        sourceParentSha,
        mainSha,
        queueSha,
        selectedGroups: groups,
        annotationKeysApplied: updates.map((update) => update.key),
        discardedChanges: parseNameStatus(sourceDiff, selectedPaths),
      } as const;
      if (options.mode === 'audit') return { status: 'audited', ...result };

      const [liveMain, liveQueue] = await Promise.all([
        remoteSha(deps.exec, repoRoot, remote, baseBranch),
        remoteSha(deps.exec, repoRoot, remote, queueBranch),
      ]);
      if (liveMain !== mainSha || liveQueue !== queueSha) {
        throw new QueueRepairError(
          'source-drift',
          `Remote changed before recovery: main=${liveMain} queue=${liveQueue}; no backup or rewrite was attempted.`,
        );
      }

      const backupRef = `refs/asset-queue-backups/${queueSha}`;
      const existingBackup = await mustGit(deps.exec, repoRoot, ['ls-remote', remote, backupRef]);
      const backupSha = /^([0-9a-f]{40,64})\s/m.exec(existingBackup)?.[1];
      if (backupSha !== undefined && backupSha !== queueSha) {
        throw new QueueRepairError(
          'git-failed',
          `Immutable backup ${backupRef} points at ${backupSha}, not expected queue ${queueSha}.`,
        );
      }
      if (backupSha === undefined) {
        await mustGit(deps.exec, repoRoot, [
          'push',
          '--no-verify',
          remote,
          `${queueSha}:${backupRef}`,
        ]);
      }

      worktree = await deps.makeTempDir();
      await mustGit(deps.exec, repoRoot, ['worktree', 'add', worktree, '--detach', mainRef]);
      await mustGit(deps.exec, worktree, [
        'checkout',
        sourceRef,
        '--',
        ...groups.flatMap((group) => [group.pngPath, group.shardPath]),
      ]);
      await deps.validateSelectedGroups(worktree, groups);
      await deps.mergeAnnotations(worktree, updates);
      await mustGit(deps.exec, worktree, [
        'add',
        '--',
        ...groups.flatMap((group) => [group.pngPath, group.shardPath]),
        ANNOTATIONS_PATH,
      ]);
      const stagedDeletions = await mustGit(deps.exec, worktree, [
        'diff',
        '--cached',
        '--name-only',
        '--diff-filter=D',
        '--',
        GENERATED_ROOT,
      ]);
      if (stagedDeletions.trim() !== '') {
        throw new QueueRepairError(
          'source-invalid',
          `Selective recovery staged generated deletions: ${stagedDeletions.trim()}. Refusing to publish.`,
        );
      }
      await mustGit(deps.exec, worktree, [
        'commit',
        '--allow-empty',
        '--no-verify',
        '-m',
        `chore(assets): selective queue recovery (${SELECTIVE_RECOVERY_POLICY})`,
      ]);
      const repairedCommit = (await mustGit(deps.exec, worktree, ['rev-parse', 'HEAD'])).trim();
      const mainBeforePush = await remoteSha(deps.exec, repoRoot, remote, baseBranch);
      if (mainBeforePush !== mainSha) {
        throw new QueueRepairError(
          'source-drift',
          `main advanced from ${mainSha} to ${mainBeforePush}; no queue rewrite was attempted.`,
        );
      }
      await mustGit(deps.exec, repoRoot, [
        'push',
        '--no-verify',
        `--force-with-lease=refs/heads/${queueBranch}:${queueSha}`,
        remote,
        `${repairedCommit}:refs/heads/${queueBranch}`,
      ]);
      return { status: 'repaired', backupRef, ...result };
    } finally {
      if (worktree !== undefined) {
        try {
          await git(deps.exec, repoRoot, ['worktree', 'remove', worktree, '--force']);
        } catch {
          // Best-effort cleanup must not mask an audited/repaired result.
        }
        try {
          await deps.removeDir(worktree);
        } catch {
          // Best-effort cleanup must not mask an audited/repaired result.
        }
      }
      for (const ref of [mainRef, queueRef, sourceRef]) {
        try {
          await git(deps.exec, repoRoot, ['update-ref', '-d', ref]);
        } catch {
          // Best-effort cleanup.
        }
      }
    }
  });
}
