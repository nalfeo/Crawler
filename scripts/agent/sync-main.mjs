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

function gitIsAncestor(cwd, candidate, ancestorOf, runGit) {
  try {
    runGit(cwd, ['merge-base', '--is-ancestor', candidate, ancestorOf]);
    return true;
  } catch (error) {
    if (isExpectedGitNegative(error)) return false;
    throw error;
  }
}

function hasMainlineParent(cwd, parents, mainRef, runGit) {
  try {
    return parents.some((parent) => gitIsAncestor(cwd, parent, mainRef, runGit));
  } catch (error) {
    throw new Error(`Could not inspect merge parent ancestry: ${error.message}`);
  }
}

function branchHasShepherdContext(branch) {
  const lowerBranch = branch.toLowerCase();

  if (
    lowerBranch.startsWith('ci-recovery/') ||
    lowerBranch.startsWith('pr-shepherd/') ||
    lowerBranch.startsWith('shepherd/')
  ) {
    return true;
  }

  // Generic copilot branches require a shepherd/recovery segment delimited by
  // '/', '_' or '-' so unrelated names like "fix-recovery-timeout" stay on rebase.
  const segments = lowerBranch.split(/[/_-]+/);
  const hasShepherdMarker = segments.some((part) => part === 'shepherd' || part === 'recovery');
  return lowerBranch.startsWith('copilot/') && hasShepherdMarker;
}

function isExpectedGitNegative(error) {
  return error.status === 1;
}

function hasMainlineReconciliationMerge(cwd, mainRef, runGit) {
  let mergeBase;
  try {
    mergeBase = runGit(cwd, ['merge-base', 'HEAD', mainRef]);
  } catch (error) {
    if (!isExpectedGitNegative(error)) {
      throw new Error(`Could not find merge base with ${mainRef}: ${error.message}`);
    }
    return false;
  }

  let merges;
  try {
    merges = runGit(cwd, ['rev-list', '--merges', '--parents', `${mergeBase}..HEAD`]);
  } catch (error) {
    throw new Error(`Could not inspect merge commits since ${mergeBase}: ${error.message}`);
  }
  if (!merges) return false;

  for (const line of merges.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (hasMainlineParent(cwd, parts.slice(1), mainRef, runGit)) return true;
  }

  return false;
}

function selectSyncStrategy(cwd, branch, mainRef, runGit) {
  const shepherdContext = branchHasShepherdContext(branch);
  const hasReconciliationMerge = hasMainlineReconciliationMerge(cwd, mainRef, runGit);

  if (shepherdContext && hasReconciliationMerge) {
    return {
      name: 'merge-preserving',
      gitCommand: ['merge', '--no-edit', mainRef],
      abortCommand: ['merge', '--abort'],
      actionPastTense: 'merged',
      conflictOperation: 'Merge-preserving update',
      reason:
        'branch name has shepherd/recovery ownership context and an existing mainline reconciliation merge was found',
    };
  }

  return {
    name: 'rebase',
    gitCommand: ['rebase', mainRef],
    abortCommand: ['rebase', '--abort'],
    actionPastTense: 'rebased',
    conflictOperation: 'Rebase',
    reason: shepherdContext
      ? 'branch name has shepherd/recovery ownership context but no existing mainline reconciliation merge was found'
      : 'branch name has no shepherd/recovery ownership context, so reconciliation-merge preservation does not apply',
  };
}

function strategySummary(strategy) {
  return `strategy ${strategy.name} selected because ${strategy.reason}`;
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
    ...(result.strategy ? { lastStrategy: result.strategy } : {}),
    ...(result.strategyReason ? { lastStrategyReason: result.strategyReason } : {}),
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

    const strategy = selectSyncStrategy(cwd, branch, 'refs/remotes/origin/main', runGit);

    try {
      runGit(cwd, strategy.gitCommand);
    } catch (syncError) {
      let abortError = null;
      try {
        runGit(cwd, strategy.abortCommand);
      } catch (error) {
        abortError = error;
      }
      const result = {
        status: abortError ? 'failed-abort' : 'conflict-aborted',
        reason,
        branchChanged: false,
        strategy: strategy.name,
        strategyReason: strategy.reason,
        headSha: runGit(cwd, ['rev-parse', 'HEAD']),
        mainSha,
        message: abortError
          ? `${strategy.conflictOperation} failed: ${syncError.message}; abort also failed: ${abortError.message} (${strategySummary(strategy)}).`
          : `${strategy.conflictOperation} conflicted and was aborted cleanly (${strategySummary(strategy)}): ${syncError.message}`,
      };
      writeSyncState(cwd, resultState(state, result, now));
      return result;
    }

    const headAfter = runGit(cwd, ['rev-parse', 'HEAD']);
    const result = {
      status: 'success',
      reason,
      branchChanged: headAfter !== headBefore,
      strategy: strategy.name,
      strategyReason: strategy.reason,
      headSha: headAfter,
      mainSha,
      message:
        headAfter === headBefore
          ? `Branch already contains origin/main (${strategySummary(strategy)}).`
          : `Branch ${strategy.actionPastTense} onto origin/main (${strategySummary(strategy)}).`,
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
