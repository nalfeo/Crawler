import { spawnSync } from 'node:child_process';

let cachedMountPrefix: string | null | undefined;

/**
 * Converts an absolute Windows path (as produced by `path.resolve()`) into a
 * path the `bash` binary resolved from `PATH` can actually open when passed
 * as a `spawnSync` argv element. `spawnSync` with an argv array does not go
 * through a shell, so none of Git-Bash's/WSL's usual path-translation magic
 * (which only fires for shell-string invocations) applies — the resolved
 * bash sees the raw Windows path exactly as constructed.
 *
 * Two different `bash` binaries can be on `PATH` on Windows, and each wants a
 * different path form:
 * - Git-Bash (MSYS2): accepts drive-letter paths with forward slashes
 *   directly (`C:/Users/...`) — forward-slashing is sufficient.
 * - WSL's `bash.exe` shim: a genuine Linux bash with no concept of drive
 *   letters at all; it only understands the `/mnt/<drive>/...` mount form.
 *
 * We detect which one is on `PATH` once per process (memoized) by probing
 * for the WSL-style `/mnt/c` mount, and convert accordingly. On non-Windows
 * platforms this is a pure no-op passthrough (real CI never hits this path).
 */
export function toBashScriptPath(absoluteWindowsPath: string): string {
  if (process.platform !== 'win32') {
    return absoluteWindowsPath;
  }
  const forwardSlashed = absoluteWindowsPath.replace(/\\/g, '/');
  if (cachedMountPrefix === undefined) {
    const probe = spawnSync('bash', ['-c', 'test -d /mnt/c/Windows && echo wsl'], {
      encoding: 'utf8',
    });
    cachedMountPrefix = probe.stdout?.trim() === 'wsl' ? '/mnt/' : null;
  }
  if (cachedMountPrefix === null) {
    return forwardSlashed;
  }
  const driveMatch = /^([A-Za-z]):\/(.*)$/.exec(forwardSlashed);
  if (!driveMatch) {
    return forwardSlashed;
  }
  const [, drive, rest] = driveMatch;
  return `${cachedMountPrefix}${drive!.toLowerCase()}/${rest}`;
}

/**
 * Builds a `spawnSync` `env` object that reliably delivers `extraEnv` to the
 * child `bash` process, including when the resolved `bash` is the WSL
 * interop shim (`C:\Windows\System32\bash.exe`) rather than a native
 * Windows/Linux bash.
 *
 * WSL's interop layer does NOT forward the parent Windows process's
 * environment variables into the Linux session by default — only variables
 * explicitly named in `WSLENV` (a colon-separated allow-list) are imported.
 * Passing `SCOPE_FILES_OVERRIDE`/`GITHUB_OUTPUT`/etc. straight through
 * `spawnSync`'s `env` option is therefore silently dropped under WSL: the
 * script sees an empty value for every one of them, which is a much more
 * significant bug than a missing script file (every SCOPE_FILES_OVERRIDE-
 * driven classification silently degrades to "no changed files").
 *
 * We fix this by extending `WSLENV` (preserving anything already set by the
 * user) with the names of every key in `extraEnv`. On non-WSL bash — real
 * Linux CI, or Windows Git-Bash/MSYS2 — `WSLENV` is simply an inert, unused
 * environment variable, so this is a safe no-op there.
 */
export function bashEnv(extraEnv: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const existingWslEnv = process.env.WSLENV ? process.env.WSLENV.split(':').filter(Boolean) : [];
  const names = Object.keys(extraEnv);
  const wslEnv = [...new Set([...existingWslEnv, ...names])].join(':');
  return {
    ...process.env,
    ...extraEnv,
    ...(wslEnv ? { WSLENV: wslEnv } : {}),
  } as NodeJS.ProcessEnv;
}
