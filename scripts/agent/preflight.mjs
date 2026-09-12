#!/usr/bin/env node
/**
 * Bootstrap Crawler's normal Bash preflight on a fresh Windows worktree.
 * Node is the only prerequisite: Git Bash is resolved before local tsx exists.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export function gitBashCandidates(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return ['bash'];
  const roots = [
    env.GIT_BASH,
    env.ProgramFiles && join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    'C:\\Program Files\\Git\\bin\\bash.exe',
  ];
  return [...new Set(roots.filter(Boolean))];
}

export function resolveBootstrapBash(env, platform, exists = existsSync) {
  return (
    gitBashCandidates(env, platform).find(
      (candidate) => candidate === 'bash' || exists(candidate),
    ) ?? null
  );
}

export function needsInstall(root, exists = existsSync) {
  const bin = join(root, 'node_modules', '.bin', 'tsx');
  return !exists(bin) && !exists(`${bin}.cmd`);
}

function missingTsxMessage(root) {
  return (
    `Dependency bootstrap completed without ${join(root, 'node_modules', '.bin', 'tsx')}. ` +
    'Another npm install may be running in this worktree; wait for it to finish, then rerun npm run preflight.'
  );
}

export function npmCacheForWorktree(root) {
  return join(root, 'files', 'npm-cache');
}

function run(command, args, options) {
  const windowsBatch = process.platform === 'win32' && command.endsWith('.cmd');
  const result = spawnSync(
    windowsBatch ? (process.env.ComSpec ?? 'cmd.exe') : command,
    windowsBatch ? ['/d', '/s', '/c', command, ...args] : args,
    {
      stdio: 'inherit',
      ...options,
    },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function main({
  root = process.cwd(),
  env = process.env,
  platform = process.platform,
  exists = existsSync,
  runCommand = run,
} = {}) {
  const bash = resolveBootstrapBash(env, platform, exists);
  if (!bash) {
    console.error(
      'Preflight needs Git Bash. Install Git for Windows, then retry `npm run preflight`.',
    );
    return 1;
  }
  let installedDependencies = false;
  if (needsInstall(root, exists)) {
    console.log('Fresh worktree: installing dependencies once before preflight…');
    const npm = platform === 'win32' ? 'npm.cmd' : 'npm';
    // The normal preflight owns browser provisioning. Avoid downloading it twice.
    const installStatus = runCommand(npm, ['ci', '--prefer-offline'], {
      cwd: root,
      env: {
        ...env,
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
        // Codex can run multiple Windows worktrees concurrently. Do not let a
        // locked user-level npm cache prevent any one of them from bootstrapping.
        npm_config_cache: npmCacheForWorktree(root),
      },
    });
    if (installStatus !== 0) return installStatus;
    if (needsInstall(root, exists)) {
      console.error(missingTsxMessage(root));
      return 1;
    }
    installedDependencies = true;
  }
  const tsx = join(root, 'node_modules', '.bin', platform === 'win32' ? 'tsx.cmd' : 'tsx');
  return runCommand(tsx, ['scripts/agent/run-bash-wrapper.ts', 'scripts/agent/preflight.sh'], {
    cwd: root,
    // Reuse the bootstrap's answer so the wrapper does not depend on Codex
    // forwarding ProgramFiles or adding Git Bash to PATH.
    env: {
      ...env,
      GIT_BASH: bash,
      ...(installedDependencies ? { PREFLIGHT_DEPS_ALREADY_READY: '1' } : {}),
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main();
