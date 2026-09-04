import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export type BashShellKind = 'posix-bash' | 'git-bash' | 'wsl';

export interface BashShell {
  command: string;
  kind: BashShellKind;
  argsPrefix: readonly string[];
}

interface SpawnResult {
  status: number | null;
  error?: Error;
  stderr?: string | Buffer | null;
  stdout?: string | Buffer | null;
}

export interface ShellResolverHost {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  existsSync: (path: string) => boolean;
  spawnSync: (
    command: string,
    args: readonly string[],
    options: { encoding: 'utf8' },
  ) => SpawnResult;
}

export class ShellResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShellResolutionError';
  }
}

export function windowsPathToWslPath(windowsPath: string): string {
  const forwardSlashed = windowsPath.replace(/\\/g, '/');
  const driveMatch = /^([A-Za-z]):\/(.*)$/.exec(forwardSlashed);
  if (!driveMatch) {
    return forwardSlashed;
  }
  const [, drive, rest] = driveMatch;
  return `/mnt/${drive!.toLowerCase()}/${rest}`;
}

export function envWithWslPassthrough(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const existing = env.WSLENV ? env.WSLENV.split(':').filter(Boolean) : [];
  const existingNames = new Set(existing.map((entry) => entry.split('/')[0]).filter(Boolean));
  const extraNames = Object.keys(env).filter((name) => {
    if (existingNames.has(name)) {
      return false;
    }
    return (
      /^VERIFY_/.test(name) ||
      /^SCOPE_/.test(name) ||
      /^SILENT_REVERT_/.test(name) ||
      name === 'GITHUB_BASE_SHA' ||
      name === 'GITHUB_OUTPUT' ||
      name === 'AUTOMATION_REPORT_DIR' ||
      name === 'NODE_ENV' ||
      name === 'CI'
    );
  });
  const wslEnv = [...existing, ...extraNames].join(':');
  return {
    ...env,
    ...(wslEnv ? { WSLENV: wslEnv } : {}),
  };
}

function defaultHost(): ShellResolverHost {
  return {
    env: process.env,
    platform: process.platform,
    existsSync,
    spawnSync: (command, args, options) => spawnSync(command, [...args], options),
  };
}

function windowsGitBashCandidates(env: NodeJS.ProcessEnv): string[] {
  return [
    env.GIT_BASH,
    env['ProgramFiles'] ? windowsJoin(env['ProgramFiles'], 'Git', 'bin', 'bash.exe') : undefined,
    env['ProgramFiles']
      ? windowsJoin(env['ProgramFiles'], 'Git', 'usr', 'bin', 'bash.exe')
      : undefined,
    env['ProgramFiles(x86)']
      ? windowsJoin(env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe')
      : undefined,
    env['ProgramFiles(x86)']
      ? windowsJoin(env['ProgramFiles(x86)'], 'Git', 'usr', 'bin', 'bash.exe')
      : undefined,
    env.LOCALAPPDATA
      ? windowsJoin(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')
      : undefined,
    env.LOCALAPPDATA
      ? windowsJoin(env.LOCALAPPDATA, 'Programs', 'Git', 'usr', 'bin', 'bash.exe')
      : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));
}

function windowsJoin(first: string, ...rest: string[]): string {
  const head = first.replace(/[\\/]+$/, '');
  return [head, ...rest.map((part) => part.replace(/^[\\/]+|[\\/]+$/g, ''))].join('\\');
}

function pathCandidates(env: NodeJS.ProcessEnv, executableName: string): string[] {
  const pathValue = env.Path ?? env.PATH ?? '';
  const pathExts = (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
  return pathValue
    .split(';')
    .filter(Boolean)
    .flatMap((entry) => [
      windowsJoin(entry, executableName),
      ...pathExts.map((extension) => windowsJoin(entry, `${executableName}${extension}`)),
    ]);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isGitBashPath(candidate: string): boolean {
  return /[\\/]Git[\\/](?:bin|usr[\\/]bin)[\\/]bash\.exe$/i.test(candidate);
}

interface WslLauncher {
  command: string;
  argsPrefix: readonly string[];
}

function wslLaunchers(
  env: NodeJS.ProcessEnv,
  pathBashes: readonly string[],
  pathWsl: readonly string[],
): WslLauncher[] {
  const wslExeLaunchers = unique(
    [
      env.WINDIR ? windowsJoin(env.WINDIR, 'System32', 'wsl.exe') : undefined,
      env.SystemRoot ? windowsJoin(env.SystemRoot, 'System32', 'wsl.exe') : undefined,
      ...pathWsl.filter((candidate) => /[\\/]System32[\\/]wsl\.exe$/i.test(candidate)),
    ].filter((candidate): candidate is string => Boolean(candidate)),
  ).map((command) => ({ command, argsPrefix: ['-e', 'bash'] as const }));

  const bashShimLaunchers = unique(
    [
      env.WINDIR ? windowsJoin(env.WINDIR, 'System32', 'bash.exe') : undefined,
      env.SystemRoot ? windowsJoin(env.SystemRoot, 'System32', 'bash.exe') : undefined,
      ...pathBashes.filter((candidate) => /[\\/]System32[\\/]bash\.exe$/i.test(candidate)),
    ].filter((candidate): candidate is string => Boolean(candidate)),
  ).map((command) => ({ command, argsPrefix: [] as const }));

  return [...wslExeLaunchers, ...bashShimLaunchers];
}

function outputText(value: string | Buffer | null | undefined): string {
  return typeof value === 'string' ? value : (value?.toString('utf8') ?? '');
}

function unusableWslMessage(candidate: string, probe?: SpawnResult): string {
  const details = probe ? outputText(probe.stderr).trim() || outputText(probe.stdout).trim() : '';
  const suffix = details ? `\nWSL reported: ${details}` : '';
  return [
    `No usable Bash shell is available for Crawler wrappers.`,
    `Found the Windows WSL shim at ${candidate}, but it could not start a configured Linux distribution.`,
    `Install Git for Windows, or configure WSL with a distribution (for example: wsl --install -d Ubuntu), then retry.`,
    suffix,
  ].join('\n');
}

export function resolveBashShell(host: ShellResolverHost = defaultHost()): BashShell {
  if (host.platform !== 'win32') {
    return { command: 'bash', kind: 'posix-bash', argsPrefix: [] };
  }

  const pathBashes = pathCandidates(host.env, 'bash');
  const pathWsl = pathCandidates(host.env, 'wsl');
  const gitBash = unique([
    ...windowsGitBashCandidates(host.env),
    ...pathBashes.filter(isGitBashPath),
  ]).find((candidate) => host.existsSync(candidate));
  if (gitBash) {
    return { command: gitBash, kind: 'git-bash', argsPrefix: [] };
  }

  const wslLauncher = wslLaunchers(host.env, pathBashes, pathWsl).find((candidate) =>
    host.existsSync(candidate.command),
  );
  if (wslLauncher) {
    const probe = host.spawnSync(
      wslLauncher.command,
      [...wslLauncher.argsPrefix, '-lc', 'printf __crawler_wsl_ready__'],
      {
        encoding: 'utf8',
      },
    );
    if (probe.status === 0 && outputText(probe.stdout).includes('__crawler_wsl_ready__')) {
      return { command: wslLauncher.command, kind: 'wsl', argsPrefix: wslLauncher.argsPrefix };
    }
    throw new ShellResolutionError(unusableWslMessage(wslLauncher.command, probe));
  }

  throw new ShellResolutionError(
    [
      `No usable Bash shell is available for Crawler wrappers.`,
      `Install Git for Windows, or configure WSL with a Linux distribution, then retry.`,
    ].join('\n'),
  );
}
