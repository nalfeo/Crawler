import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  envWithWslPassthrough,
  resolveBashShell,
  ShellResolutionError,
  windowsPathToWslPath,
} from '../../scripts/agent/shell-resolver.js';

type SpawnCall = {
  command: string;
  args: readonly string[];
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function makeHost(options: {
  env?: NodeJS.ProcessEnv;
  existing?: readonly string[];
  platform?: NodeJS.Platform;
  spawnStatus?: number;
  spawnStdout?: string;
  spawnStderr?: string;
}) {
  const existing = new Set(options.existing ?? []);
  const calls: SpawnCall[] = [];
  const host = {
    env: options.env ?? {},
    platform: options.platform ?? 'win32',
    existsSync: (candidate: string) => existing.has(candidate),
    spawnSync: (command: string, args: readonly string[]) => {
      calls.push({ command, args });
      return {
        status: options.spawnStatus ?? 0,
        stdout: options.spawnStdout ?? '__crawler_wsl_ready__',
        stderr: options.spawnStderr ?? '',
      };
    },
  };
  return { host, calls };
}

describe('resolveBashShell', () => {
  it('keeps non-Windows behavior on ambient bash', () => {
    const { host, calls } = makeHost({ platform: 'linux' });

    expect(resolveBashShell(host)).toEqual({ command: 'bash', kind: 'posix-bash' });
    expect(calls).toEqual([]);
  });

  it('prefers a known Git Bash executable on Windows', () => {
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    const { host, calls } = makeHost({
      env: { ProgramFiles: 'C:\\Program Files', WINDIR: 'C:\\Windows' },
      existing: [gitBash, 'C:\\Windows\\System32\\bash.exe'],
    });

    expect(resolveBashShell(host)).toEqual({ command: gitBash, kind: 'git-bash' });
    expect(calls).toEqual([]);
  });

  it('falls back to a configured WSL shim when Git Bash is unavailable', () => {
    const wsl = 'C:\\Windows\\System32\\bash.exe';
    const { host, calls } = makeHost({
      env: { ProgramFiles: 'C:\\Program Files', WINDIR: 'C:\\Windows' },
      existing: [wsl],
      spawnStatus: 0,
      spawnStdout: '__crawler_wsl_ready__',
    });

    expect(resolveBashShell(host)).toEqual({ command: wsl, kind: 'wsl' });
    expect(calls).toEqual([{ command: wsl, args: ['-lc', 'printf __crawler_wsl_ready__'] }]);
  });

  it('diagnoses an unusable WSL shim without falling through to ambient bash', () => {
    const wsl = 'C:\\Windows\\System32\\bash.exe';
    const { host } = makeHost({
      env: { WINDIR: 'C:\\Windows' },
      existing: [wsl],
      spawnStatus: 1,
      spawnStdout: '',
      spawnStderr:
        'Windows Subsystem for Linux has no installed distributions. Use wsl.exe --install.',
    });

    expect(() => resolveBashShell(host)).toThrow(ShellResolutionError);
    expect(() => resolveBashShell(host)).toThrow(/Install Git for Windows/);
    expect(() => resolveBashShell(host)).toThrow(/wsl --install -d Ubuntu/);
    expect(() => resolveBashShell(host)).toThrow(/no installed distributions/);
  });

  it('reports a clear remediation when no Windows Bash shell is available', () => {
    const { host } = makeHost({
      env: { ProgramFiles: 'C:\\Program Files', WINDIR: 'C:\\Windows' },
      existing: [],
    });

    expect(() => resolveBashShell(host)).toThrow(ShellResolutionError);
    expect(() => resolveBashShell(host)).toThrow(/No usable Bash shell/);
    expect(() => resolveBashShell(host)).toThrow(/Install Git for Windows/);
    expect(() => resolveBashShell(host)).toThrow(/configure WSL/);
  });

  it('routes package shell wrappers through the central resolver', () => {
    const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts['verify:fast']).toBe(
      'tsx scripts/agent/run-bash-wrapper.ts scripts/agent/verify-fast.sh',
    );
    expect(packageJson.scripts['scope']).toBe(
      'tsx scripts/agent/run-bash-wrapper.ts scripts/agent/ci/local-scope.sh',
    );
    expect(packageJson.scripts['verify']).toBe(
      'tsx scripts/agent/run-bash-wrapper.ts scripts/agent/verify.sh',
    );
    expect(packageJson.scripts['security:check']).not.toMatch(/(?:^|&& )bash scripts\/agent\//);
  });

  it('converts Windows paths for the WSL fallback', () => {
    expect(
      windowsPathToWslPath('C:\\Users\\runner\\work\\Crawler\\scripts\\agent\\verify.sh'),
    ).toBe('/mnt/c/Users/runner/work/Crawler/scripts/agent/verify.sh');
    expect(windowsPathToWslPath('/already/posix/path.sh')).toBe('/already/posix/path.sh');
  });

  it('passes wrapper environment variables into WSL without replacing its PATH', () => {
    expect(
      envWithWslPassthrough({
        PATH: 'C:\\Windows\\System32',
        WSLENV: 'EXISTING/u',
        VERIFY_FAST_TEST_STATIC_ONLY: '1',
        SCOPE_FILES_OVERRIDE: 'docs/readme.md',
      }),
    ).toMatchObject({
      PATH: 'C:\\Windows\\System32',
      WSLENV: 'EXISTING/u:VERIFY_FAST_TEST_STATIC_ONLY:SCOPE_FILES_OVERRIDE',
    });
  });
});
