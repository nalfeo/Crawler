#!/usr/bin/env node
/* global console */

import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join, posix, resolve, win32 } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDir, '..', '..');

export function pinnedNodeVersion(root = repositoryRoot) {
  return readFileSync(join(root, '.node-version'), 'utf8').trim().replace(/^v/, '');
}

export function pinnedNodeCandidates({
  root = repositoryRoot,
  env = process.env,
  platform = process.platform,
  currentExecutable = process.execPath,
  currentVersion = process.versions.node,
} = {}) {
  const version = pinnedNodeVersion(root);
  const candidates = [];
  if (currentVersion === version) candidates.push(currentExecutable);
  if (env.CRAWLER_NODE_EXECUTABLE) candidates.push(env.CRAWLER_NODE_EXECUTABLE);

  if (platform === 'win32') {
    if (env.APPDATA) {
      candidates.push(
        join(env.APPDATA, 'fnm', 'node-versions', `v${version}`, 'installation', 'node.exe'),
      );
    }
    if (env.FNM_DIR) {
      candidates.push(
        join(env.FNM_DIR, 'node-versions', `v${version}`, 'installation', 'node.exe'),
      );
    }
  } else {
    if (env.FNM_DIR) {
      candidates.push(
        join(env.FNM_DIR, 'node-versions', `v${version}`, 'installation', 'bin', 'node'),
      );
    }
    if (env.HOME) {
      candidates.push(
        join(
          env.HOME,
          '.local',
          'share',
          'fnm',
          'node-versions',
          `v${version}`,
          'installation',
          'bin',
          'node',
        ),
      );
    }
  }

  return [...new Set(candidates)];
}

export function resolvePinnedNode(options = {}) {
  const exists = options.exists ?? existsSync;
  const versionFor = options.versionFor ?? nodeVersionForExecutable;
  const expectedVersion = pinnedNodeVersion(options.root);
  return (
    pinnedNodeCandidates(options).find(
      (candidate) => exists(candidate) && versionFor(candidate) === expectedVersion,
    ) ?? null
  );
}

export function nodeVersionForExecutable(executable) {
  const result = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout).trim().replace(/^v/, '') || null;
}

export function runtimeEnvironment(nodeExecutable, env = process.env) {
  const preload = resolve(scriptDir, 'windows-node-identity.cjs').replaceAll('\\', '/');
  const requireOption = `--require=${JSON.stringify(preload)}`;
  const existingOptions = String(env.NODE_OPTIONS || '').trim();
  return {
    ...env,
    NODE_OPTIONS: [existingOptions, requireOption].filter(Boolean).join(' '),
    PATH: [dirname(nodeExecutable), env.PATH].filter(Boolean).join(delimiter),
  };
}

export function npmCliForNode(nodeExecutable, platform = process.platform) {
  const paths = platform === 'win32' ? win32 : posix;
  const installationRoot =
    platform === 'win32'
      ? paths.dirname(nodeExecutable)
      : paths.resolve(paths.dirname(nodeExecutable), '..');
  return platform === 'win32'
    ? paths.join(installationRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : paths.join(installationRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

export function main(args = process.argv.slice(2)) {
  const nodeExecutable = resolvePinnedNode();
  const version = pinnedNodeVersion();
  if (!nodeExecutable) {
    console.error(
      `Crawler requires Node ${version}. Install it with fnm or set CRAWLER_NODE_EXECUTABLE to its node executable.`,
    );
    return 1;
  }

  const mode = args[0] === '--node' || args[0] === '--npm' ? args[0] : '--tsx';
  const forwarded = mode === '--tsx' ? args : args.slice(1);
  if (forwarded.length === 0) {
    console.error('Usage: node scripts/agent/run-tsx.mjs [--node|--npm] <script-or-arg> [...args]');
    return 2;
  }

  const entrypoint =
    mode === '--node'
      ? forwarded[0]
      : mode === '--npm'
        ? npmCliForNode(nodeExecutable)
        : join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!existsSync(entrypoint)) {
    console.error(
      mode === '--node'
        ? `Agent runtime entrypoint does not exist: ${entrypoint}`
        : mode === '--npm'
          ? `The pinned Node installation does not include npm: ${entrypoint}`
          : 'tsx is not installed in this worktree. Run `npm run preflight` first.',
    );
    return 1;
  }

  const childArgs = mode === '--node' ? forwarded : [entrypoint, ...forwarded];
  const result = spawnSync(nodeExecutable, childArgs, {
    cwd: repositoryRoot,
    env: runtimeEnvironment(nodeExecutable),
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
