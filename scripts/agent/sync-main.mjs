import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const SYNC_STATE_RELATIVE_PATH = 'files/main-sync-state.json';

function defaultState() {
  return {
    schema: 'crawler-main-sync/v1',
  };
}

export function readSyncState(cwd) {
  const statePath = join(cwd, SYNC_STATE_RELATIVE_PATH);
  if (!existsSync(statePath)) return defaultState();
  try {
    return { ...defaultState(), ...JSON.parse(readFileSync(statePath, 'utf8')) };
  } catch (error) {
    return {
      ...defaultState(),
      evidenceReadError: `Could not read ${SYNC_STATE_RELATIVE_PATH}: ${error.message}`,
    };
  }
}

export function writeSyncState(cwd, state) {
  const statePath = join(cwd, SYNC_STATE_RELATIVE_PATH);
  const tempPath = `${statePath}.${process.pid}.tmp`;
  mkdirSync(dirname(statePath), { recursive: true });
  try {
    writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(tempPath, statePath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitOperationInProgress(cwd, runGit) {
  for (const operation of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD']) {
    const gitPath = runGit(cwd, ['rev-parse', '--git-path', operation]);
    const absolutePath = isAbsolute(gitPath) ? gitPath : resolve(cwd, gitPath);
    if (existsSync(absolutePath)) return operation;
  }
  return null;
}

function resultState(state, result, now) {
  return {
    ...state,
    schema: 'crawler-main-sync/v1',
    lastAttemptAt: new Date(now).toISOString(),
    lastReason: result.reason,
    lastResult: result.status,
    lastMessage: result.message,
    ...(result.headSha ? { headSha: result.headSha } : {}),
    ...(result.mainSha ? { mainSha: result.mainSha } : {}),
    ...(result.status === 'success' ? { lastSuccessAt: new Date(now).toISOString() } : {}),
  };
}

export function attemptMainSync({
  cwd = process.cwd(),
  reason = 'manual',
  now = Date.now(),
  runGit = git,
} = {}) {
  const state = readSyncState(cwd);

  try {
    const operation = gitOperationInProgress(cwd, runGit);
    if (operation) {
      const result = {
        status: 'deferred-operation',
        reason,
        branchChanged: false,
        message: `Main sync deferred because ${operation} is in progress.`,
      };
      writeSyncState(cwd, resultState(state, result, now));
      return result;
    }

    const branch = runGit(cwd, ['branch', '--show-current']);
    if (!branch) {
      const result = {
        status: 'deferred-detached-head',
        reason,
        branchChanged: false,
        message: 'Main sync deferred because HEAD is detached.',
      };
      writeSyncState(cwd, resultState(state, result, now));
      return result;
    }

    // Check dirtiness before the network fetch: a dirty worktree cannot be
    // rebased and the fetch is wasted work. Skip the fetch when dirty.
    if (branch !== 'main' && runGit(cwd, ['status', '--porcelain'])) {
      const result = {
        status: 'deferred-dirty',
        reason,
        branchChanged: false,
        message:
          'Main sync deferred because the worktree is dirty; checkpoint the work, then sync.',
      };
      writeSyncState(cwd, resultState(state, result, now));
      return result;
    }

    runGit(cwd, ['fetch', 'origin', 'main:refs/remotes/origin/main', '--quiet']);
    const mainSha = runGit(cwd, ['rev-parse', 'refs/remotes/origin/main']);
    const headBefore = runGit(cwd, ['rev-parse', 'HEAD']);

    if (branch === 'main') {
      const result = {
        status: 'success',
        reason,
        branchChanged: false,
        headSha: headBefore,
        mainSha,
        message: 'On main; refreshed origin/main without rebasing.',
      };
      writeSyncState(cwd, resultState(state, result, now));
      return result;
    }

    if (runGit(cwd, ['status', '--porcelain'])) {
      const result = {
        status: 'deferred-dirty',
        reason,
        branchChanged: false,
        headSha: headBefore,
        mainSha,
        message:
          'Main sync deferred because the worktree is dirty; checkpoint the work, then sync.',
      };
      writeSyncState(cwd, resultState(state, result, now));
      return result;
    }

    try {
      runGit(cwd, ['rebase', 'refs/remotes/origin/main']);
    } catch (rebaseError) {
      let abortError = null;
      try {
        runGit(cwd, ['rebase', '--abort']);
      } catch (error) {
        abortError = error;
      }
      const result = {
        status: abortError ? 'failed-abort' : 'conflict-aborted',
        reason,
        branchChanged: false,
        headSha: runGit(cwd, ['rev-parse', 'HEAD']),
        mainSha,
        message: abortError
          ? `Rebase failed and abort also failed: ${abortError.message}`
          : `Rebase conflicted and was aborted cleanly: ${rebaseError.message}`,
      };
      writeSyncState(cwd, resultState(state, result, now));
      return result;
    }

    const headAfter = runGit(cwd, ['rev-parse', 'HEAD']);
    const result = {
      status: 'success',
      reason,
      branchChanged: headAfter !== headBefore,
      headSha: headAfter,
      mainSha,
      message:
        headAfter === headBefore
          ? 'Branch already contains origin/main.'
          : 'Branch rebased onto origin/main.',
    };
    writeSyncState(cwd, resultState(state, result, now));
    return result;
  } catch (error) {
    const result = {
      status: 'failed',
      reason,
      branchChanged: false,
      message: `Main sync could not complete: ${error.message}`,
    };
    try {
      writeSyncState(cwd, resultState(state, result, now));
    } catch (writeError) {
      result.message += ` Evidence write also failed: ${writeError.message}`;
    }
    return result;
  }
}

function cliReason(args) {
  const inline = args.find((arg) => arg.startsWith('--reason='));
  if (inline) return inline.slice('--reason='.length);
  const index = args.indexOf('--reason');
  return index >= 0 ? args[index + 1] || 'manual' : 'manual';
}

function isCli() {
  return process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

if (isCli()) {
  const result = attemptMainSync({ reason: cliReason(process.argv.slice(2)) });
  const prefix = result.status === 'success' ? 'main-sync' : 'main-sync warning';
  process.stdout.write(`${prefix}: ${result.message}\n`);
}
