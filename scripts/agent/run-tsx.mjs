#!/usr/bin/env node
/* global console, fetch */

/**
 * Runs agent tooling with the exact Node release in .node-version.
 *
 * The outer Node only bootstraps this file.  A missing pinned runtime is
 * downloaded into the ignored worktree cache, checksum-verified against the
 * official Node release manifest, then used for every child command.
 */
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, posix, resolve, win32 } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDir, '..', '..');

export function pinnedNodeVersion(root = repositoryRoot) {
  return readFileSync(join(root, '.node-version'), 'utf8').trim().replace(/^v/, '');
}

export function runtimeCacheDirectory(root = repositoryRoot, env = process.env) {
  return env.CRAWLER_RUNTIME_CACHE || join(root, 'files', 'runtime-cache');
}

export function nodeArchive({ version, platform = process.platform, arch = process.arch }) {
  const nodeArch = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null;
  if (!nodeArch || !['win32', 'linux', 'darwin'].includes(platform)) return null;
  const target = `${platform === 'win32' ? 'win' : platform}-${nodeArch}`;
  return {
    target,
    filename: `node-v${version}-${target}.${platform === 'win32' ? 'zip' : 'tar.gz'}`,
  };
}

export function managedNodePath({
  root = repositoryRoot,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const archive = nodeArchive({ version: pinnedNodeVersion(root), platform, arch });
  if (!archive) return null;
  const paths = platform === 'win32' ? win32 : posix;
  return paths.join(
    runtimeCacheDirectory(root, env),
    `node-v${pinnedNodeVersion(root)}-${archive.target}`,
    platform === 'win32' ? 'node.exe' : 'bin/node',
  );
}

export function nodeVersionForExecutable(executable) {
  const result = spawnSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout).trim().replace(/^v/, '') || null;
}

export function pinnedNodeCandidates({
  root = repositoryRoot,
  env = process.env,
  platform = process.platform,
  currentExecutable = process.execPath,
  currentVersion = process.versions.node,
  arch = process.arch,
} = {}) {
  const version = pinnedNodeVersion(root);
  const paths = platform === 'win32' ? win32 : posix;
  const candidates = [managedNodePath({ root, env, platform, arch }), env.CRAWLER_NODE_EXECUTABLE];
  if (currentVersion === version) candidates.unshift(currentExecutable);
  if (platform === 'win32') {
    if (env.APPDATA)
      candidates.push(
        paths.join(env.APPDATA, 'fnm', 'node-versions', `v${version}`, 'installation', 'node.exe'),
      );
    if (env.FNM_DIR)
      candidates.push(
        paths.join(env.FNM_DIR, 'node-versions', `v${version}`, 'installation', 'node.exe'),
      );
  } else if (env.FNM_DIR) {
    candidates.push(
      paths.join(env.FNM_DIR, 'node-versions', `v${version}`, 'installation', 'bin', 'node'),
    );
  }
  return [...new Set(candidates.filter(Boolean))];
}

export function resolvePinnedNode(options = {}) {
  const exists = options.exists ?? existsSync;
  const versionFor = options.versionFor ?? nodeVersionForExecutable;
  const expected = pinnedNodeVersion(options.root);
  return (
    pinnedNodeCandidates(options).find(
      (candidate) => exists(candidate) && versionFor(candidate) === expected,
    ) ?? null
  );
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function provisionPinnedNode({
  root = repositoryRoot,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  fetchBytes = download,
} = {}) {
  const version = pinnedNodeVersion(root);
  const archive = nodeArchive({ version, platform, arch });
  const nodePath = managedNodePath({ root, env, platform, arch });
  if (!archive || !nodePath)
    throw new Error(
      `Crawler cannot provision Node ${version} for ${platform}/${arch}. Set CRAWLER_NODE_EXECUTABLE to that runtime.`,
    );
  if (existsSync(nodePath) && nodeVersionForExecutable(nodePath) === version) return nodePath;

  const cache = runtimeCacheDirectory(root, env);
  const base = `https://nodejs.org/download/release/v${version}`;
  const [checksums, bytes] = await Promise.all([
    fetchBytes(`${base}/SHASUMS256.txt`),
    fetchBytes(`${base}/${archive.filename}`),
  ]);
  const escapedFilename = archive.filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expected = checksums
    .toString('utf8')
    .match(new RegExp(`^([a-f0-9]{64})\\s+${escapedFilename}$`, 'm'))?.[1];
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (!expected || actual !== expected)
    throw new Error(
      `Node ${version} archive checksum verification failed; no runtime was installed.`,
    );

  mkdirSync(cache, { recursive: true });
  const archivePath = join(cache, archive.filename);
  const temporaryPath = `${archivePath}.partial`;
  writeFileSync(temporaryPath, bytes);
  renameSync(temporaryPath, archivePath);
  const result = spawnSync(
    'tar',
    platform === 'win32' ? ['-xf', archivePath, '-C', cache] : ['-xzf', archivePath, '-C', cache],
    { stdio: 'inherit', windowsHide: true },
  );
  if (result.error || result.status !== 0 || nodeVersionForExecutable(nodePath) !== version) {
    rmSync(join(cache, `node-v${version}-${archive.target}`), { recursive: true, force: true });
    throw new Error(`Node ${version} archive could not be extracted into ${cache}.`);
  }
  return nodePath;
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

export function runtimeEnvironment(nodeExecutable, env = process.env, platform = process.platform) {
  const paths = platform === 'win32' ? win32 : posix;
  const preload = resolve(scriptDir, 'windows-node-identity.cjs').replaceAll('\\', '/');
  const existingOptions = String(env.NODE_OPTIONS || '').trim();
  const inheritedPath = env.PATH ?? env.Path;
  const withoutPath = Object.fromEntries(
    Object.entries(env).filter(([key]) => key.toLowerCase() !== 'path'),
  );
  return {
    ...withoutPath,
    CRAWLER_NODE_EXECUTABLE: nodeExecutable,
    CRAWLER_NPM_CLI: npmCliForNode(nodeExecutable, platform),
    NODE_OPTIONS: [existingOptions, `--require=${JSON.stringify(preload)}`]
      .filter(Boolean)
      .join(' '),
    PATH: [paths.dirname(nodeExecutable), inheritedPath].filter(Boolean).join(paths.delimiter),
  };
}

export async function main(args = process.argv.slice(2)) {
  let nodeExecutable = resolvePinnedNode();
  if (!nodeExecutable) {
    console.log(`Agent runtime: provisioning Node ${pinnedNodeVersion()}…`);
    nodeExecutable = await provisionPinnedNode();
  }
  console.log(`Agent runtime: Node ${pinnedNodeVersion()} (${nodeExecutable})`);
  const mode = args[0] === '--node' || args[0] === '--npm' ? args[0] : '--tsx';
  const forwarded = mode === '--tsx' ? args : args.slice(1);
  if (forwarded.length === 0) return 2;
  const entrypoint =
    mode === '--node'
      ? forwarded[0]
      : mode === '--npm'
        ? npmCliForNode(nodeExecutable)
        : join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!existsSync(entrypoint))
    throw new Error(
      mode === '--tsx'
        ? 'tsx is not installed in this worktree. Run npm run preflight first.'
        : `Agent runtime entrypoint does not exist: ${entrypoint}`,
    );
  const result = spawnSync(
    nodeExecutable,
    mode === '--node' ? forwarded : [entrypoint, ...forwarded],
    { cwd: repositoryRoot, env: runtimeEnvironment(nodeExecutable), stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main();
