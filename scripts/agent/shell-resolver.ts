import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export type BashShellKind = 'posix-bash' | 'git-bash' | 'wsl';

export interface BashShell {
  command: string;
  kind: BashShellKind;
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
  const extraNames = Object.keys(env).filter(
    (name) =>
      name !== 'PATH' &&
      name !== 'Path' &&
      name !== 'PATHEXT' &&
      name !== 'WSLENV' &&
      !existingNames.has(name),
  );
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

function pathCandidates(env: NodeJS.ProcessEnv): string[] {
  const pathValue = env.Path ?? env.PATH ?? '';
  const pathExts = (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
  return pathValue
    .split(';')
    .filter(Boolean)
    .flatMap((entry) => [
      windowsJoin(entry, 'bash'),
      ...pathExts.map((extension) => windowsJoin(entry, `bash${extension}`)),
    ]);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isGitBashPath(candidate: string): boolean {
  return /[\\/]Git[\\/](?:bin|usr[\\/]bin)[\\/]bash\.exe$/i.test(candidate);
}

function wslShimCandidates(env: NodeJS.ProcessEnv, pathBashes: readonly string[]): string[] {
  return unique(
    [
      env.WINDIR ? windowsJoin(env.WINDIR, 'System32', 'bash.exe') : undefined,
      env.SystemRoot ? windowsJoin(env.SystemRoot, 'System32', 'bash.exe') : undefined,
      ...pathBashes.filter((candidate) => /[\\/]System32[\\/]bash\.exe$/i.test(candidate)),
    ].filter((candidate): candidate is string => Boolean(candidate)),
  );
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
    return { command: 'bash', kind: 'posix-bash' };
  }

  const pathBashes = pathCandidates(host.env);
  const gitBash = unique([
    ...windowsGitBashCandidates(host.env),
    ...pathBashes.filter(isGitBashPath),
  ]).find((candidate) => host.existsSync(candidate));
  if (gitBash) {
    return { command: gitBash, kind: 'git-bash' };
  }

  const wslShim = wslShimCandidates(host.env, pathBashes).find((candidate) =>
    host.existsSync(candidate),
  );
  if (wslShim) {
    const probe = host.spawnSync(wslShim, ['-lc', 'printf __crawler_wsl_ready__'], {
      encoding: 'utf8',
    });
    if (probe.status === 0 && outputText(probe.stdout).includes('__crawler_wsl_ready__')) {
      return { command: wslShim, kind: 'wsl' };
    }
    throw new ShellResolutionError(unusableWslMessage(wslShim, probe));
  }

  throw new ShellResolutionError(
    [
      `No usable Bash shell is available for Crawler wrappers.`,
      `Install Git for Windows, or configure WSL with a Linux distribution, then retry.`,
    ].join('\n'),
  );
}
