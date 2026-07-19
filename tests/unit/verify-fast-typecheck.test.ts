import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bashEnv, toBashScriptPath } from '../helpers/bash-script-path.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = toBashScriptPath(path.join(REPO_ROOT, 'scripts/agent/verify-fast.sh'));
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const hasGit = spawnSync('git', ['--version']).status === 0;
const fixtureDirs: string[] = [];
let fixtureIndex = 0;

async function rmDirWithRetry(dir: string, attempts = 15, delayMs = 300): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY';
      if (!retryable || attempt === attempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

afterEach(async () => {
  while (fixtureDirs.length > 0) {
    const dir = fixtureDirs.pop();
    if (dir) await rmDirWithRetry(dir);
  }
});

function makeFixture(files: Record<string, string>): string {
  const dir = path.join(
    REPO_ROOT,
    '.cache',
    `verify-fast-typecheck-${process.pid}-${fixtureIndex}`,
  );
  fixtureIndex += 1;
  fixtureDirs.push(dir);

  const write = (relativePath: string, contents: string): void => {
    const absolutePath = path.join(dir, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents);
  };

  write(
    'tsconfig.json',
    `${JSON.stringify(
      {
        extends: '../../tsconfig.json',
        compilerOptions: {
          declaration: false,
          declarationMap: false,
          sourceMap: false,
          outDir: './dist',
          tsBuildInfoFile: './fixture.tsbuildinfo',
        },
        include: [
          'vite.config.ts',
          'src/**/*.ts',
          'tests/**/*.ts',
          'scripts/**/*.ts',
          'tools/**/*.ts',
        ],
        exclude: [],
      },
      null,
      2,
    )}\n`,
  );
  for (const [relativePath, contents] of Object.entries(files)) {
    write(relativePath, contents);
  }
  return dir;
}

function runStaticVerifier(fixtureDir: string, options?: { cwd?: string; project?: string }) {
  const env: Record<string, string> = {
    NODE_ENV: 'test',
    VERIFY_FAST_TEST_STATIC_ONLY: '1',
  };
  if (options?.project) {
    env.VERIFY_FAST_TSC_PROJECT = options.project;
  }
  return spawnSync('bash', [SCRIPT], {
    cwd: options?.cwd ?? fixtureDir,
    encoding: 'utf8',
    timeout: 30_000,
    env: bashEnv(env),
  });
}

const narrowingError = `
type Result = { kind: 'ready' } | { kind: 'failed'; reason: string };
const result = { kind: 'ready' } as Result;
if (result.kind === 'ready') {
  void result.reason;
}
`;

describe('verify-fast full-project typecheck', () => {
  it.skipIf(!hasBash).each(['src', 'tests', 'scripts', 'tools', 'vite.config.ts'] as const)(
    'fails for a %s-only narrowed property error',
    (directory) => {
      const files: Record<string, string> = {
        'src/clean.ts': 'export const sourceValue = 1;\n',
        'tests/clean.test.ts': 'export const testValue = 1;\n',
        'scripts/clean.ts': 'export const scriptValue = 1;\n',
        'tools/clean.ts': 'export const toolValue = 1;\n',
        'vite.config.ts': 'export const rootValue = 1;\n',
      };
      const errorPath = (() => {
        switch (directory) {
          case 'tests':
            return 'tests/narrowing.test.ts';
          case 'vite.config.ts':
            return 'vite.config.ts';
          default:
            return `${directory}/narrowing.ts`;
        }
      })();
      files[errorPath] = narrowingError;
      const fixture = makeFixture(files);

      const result = runStaticVerifier(fixture, { cwd: fixture });

      expect(result.status).not.toBe(0);
      // Assert on the stable TS error code; the message text varies across TS versions.
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/TS2339/);
    },
    30_000,
  );

  it.skipIf(!hasBash)(
    'passes clean source, test, and script inputs',
    () => {
      const fixture = makeFixture({
        'src/clean.ts': 'export const sourceValue = 1;\n',
        'tests/clean.test.ts': 'export const testValue = 1;\n',
        'scripts/clean.ts': 'export const scriptValue = 1;\n',
      });

      const result = runStaticVerifier(fixture, { cwd: fixture });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Fast verifier static checks passed');
    },
    30_000,
  );
});

function initGitFixture(dir: string): void {
  const runGit = (...args: string[]) => {
    const result = spawnSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(
        `git ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    }
  };

  runGit('init');
  runGit('config', 'user.name', 'Copilot');
  runGit('config', 'user.email', 'copilot@example.com');
  runGit('add', '.');
  runGit('commit', '-m', 'fixture');
}

describe('verify-fast changed TS path coverage', () => {
  it.skipIf(!hasBash || !hasGit)(
    'fails when a changed TS file is outside the supported verifier roots',
    () => {
      const fixture = makeFixture({
        'src/clean.ts': 'export const sourceValue = 1;\n',
        'tests/clean.test.ts': 'export const testValue = 1;\n',
        'scripts/clean.ts': 'export const scriptValue = 1;\n',
        'tools/clean.ts': 'export const toolValue = 1;\n',
        'vite.config.ts': 'export const rootValue = 1;\n',
        'vitest.config.ts': 'export const unsupportedRootValue = 1;\n',
      });
      initGitFixture(fixture);
      writeFileSync(path.join(fixture, 'vitest.config.ts'), narrowingError);

      const result = runStaticVerifier(fixture, { cwd: fixture });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        'verify:fast does not support changed TypeScript files outside vite.config.ts, src/, tests/, scripts/, and tools/:',
      );
      expect(`${result.stdout}\n${result.stderr}`).toContain('vitest.config.ts');
    },
    30_000,
  );
});

/** Intentionally long: must outlast the SIGTERM that interrupts the verifier. */
const STUB_DURATION_SECONDS = 300;
/** Brief wait after seeing "Step 1/3" to let background sleep stubs reach their wait state. */
const STUB_STARTUP_DELAY_MS = 200;
/** Bound close wait so regressions cannot hang and leak background stub processes. */
const CLOSE_TIMEOUT_MS = 5_000;
/** Bound PID-file wait so the test fails fast if stub descendants never launch. */
const CHILD_PID_TIMEOUT_MS = 3_000;

function runSignalLifecycleSupervisor(
  fixtureDir: string,
  tscChildPidFile: string,
  eslintChildPidFile: string,
) {
  const logFile = path.join(fixtureDir, 'verify-fast-signal.log');
  const supervisorScript = path.join(fixtureDir, 'verify-fast-signal-supervisor.sh');
  writeFileSync(
    supervisorScript,
    `#!/usr/bin/env bash
set -euo pipefail

script_path="$1"
log_file="$2"
tsc_pid_file="$3"
eslint_pid_file="$4"
startup_delay_seconds="$5"
child_pid_timeout_ms="$6"
close_timeout_ms="$7"

assert_pid_file() {
  local label="$1"
  local pid_file="$2"
  local attempts="$3"
  local attempt=0
  while [ ! -s "$pid_file" ]; do
    if [ "$attempt" -ge "$attempts" ]; then
      echo "Timed out waiting for $label child pid file: $pid_file" >&2
      exit 1
    fi
    attempt=$((attempt + 1))
    sleep 0.05
  done
}

bash -m "$script_path" > "$log_file" 2>&1 &
verify_pid=$!
cleanup() {
  kill -KILL "$verify_pid" 2>/dev/null || true
  wait "$verify_pid" 2>/dev/null || true
}
trap cleanup EXIT

# 200 attempts * 50ms = 10s total wait for the Step 1/3 marker.
step_attempts=200
step_attempt=0
while ! grep -q 'Step 1/3' "$log_file" 2>/dev/null; do
  if ! kill -0 "$verify_pid" 2>/dev/null; then
    echo "Process exited before Step 1/3 was printed" >&2
    cat "$log_file" >&2 || true
    exit 1
  fi
  if [ "$step_attempt" -ge "$step_attempts" ]; then
    echo "Timed out waiting for Step 1/3 output" >&2
    cat "$log_file" >&2 || true
    exit 1
  fi
  step_attempt=$((step_attempt + 1))
  sleep 0.05
done

sleep "$startup_delay_seconds"
pid_attempts=$(( child_pid_timeout_ms / 50 ))
assert_pid_file "tsc" "$tsc_pid_file" "$pid_attempts"
assert_pid_file "eslint" "$eslint_pid_file" "$pid_attempts"
tsc_child="$(tr -d '[:space:]' < "$tsc_pid_file")"
eslint_child="$(tr -d '[:space:]' < "$eslint_pid_file")"
if ! [[ "$tsc_child" =~ ^[0-9]+$ ]] || ! [[ "$eslint_child" =~ ^[0-9]+$ ]]; then
  echo "Invalid child pid content: tsc='$tsc_child' eslint='$eslint_child'" >&2
  exit 1
fi
kill -0 "$tsc_child"
kill -0 "$eslint_child"

kill -TERM "$verify_pid" 2>/dev/null || true
kill -TERM -- "-$verify_pid" 2>/dev/null || true
timeout_marker="$log_file.timeout"
rm -f "$timeout_marker"
close_timeout_seconds="$(awk -v ms="$close_timeout_ms" 'BEGIN { printf "%.3f", ms / 1000 }')"
# Millisecond -> second.fraction conversion for POSIX sleep.
(
  sleep "$close_timeout_seconds"
  if kill -0 "$verify_pid" 2>/dev/null; then
    printf "timeout\n" > "$timeout_marker"
    kill -KILL "$verify_pid" 2>/dev/null || true
  fi
) &
timeout_pid=$!

set +e
wait "$verify_pid"
verify_status=$?
set -e
kill "$timeout_pid" 2>/dev/null || true
wait "$timeout_pid" 2>/dev/null || true
if [ -f "$timeout_marker" ]; then
  echo "Timed out waiting $close_timeout_ms ms for SIGTERM shutdown" >&2
  exit 1
fi
if [ "$verify_status" -ne 143 ]; then
  echo "Expected verify-fast exit 143, got $verify_status" >&2
  cat "$log_file" >&2 || true
  exit 1
fi
if kill -0 "$tsc_child" 2>/dev/null || kill -0 "$eslint_child" 2>/dev/null; then
  echo "Descendant process survived cleanup (tsc=$tsc_child eslint=$eslint_child)" >&2
  exit 1
fi
trap - EXIT
echo "signal lifecycle ok"
`,
  );

  return spawnSync(
    'bash',
    [
      toBashScriptPath(supervisorScript),
      SCRIPT,
      logFile,
      tscChildPidFile,
      eslintChildPidFile,
      String(STUB_STARTUP_DELAY_MS / 1000),
      String(CHILD_PID_TIMEOUT_MS),
      String(CLOSE_TIMEOUT_MS),
    ],
    {
      cwd: fixtureDir,
      encoding: 'utf8',
      timeout: 30_000,
      env: bashEnv({
        NODE_ENV: 'test',
        VERIFY_FAST_TEST_STATIC_ONLY: '1',
        VERIFY_FAST_TSC_PROJECT: path.join(fixtureDir, 'tsconfig.json'),
        VERIFY_FAST_TSC_STUB_SECONDS: String(STUB_DURATION_SECONDS),
        VERIFY_FAST_TSC_STUB_WITH_DESCENDANT: '1',
        VERIFY_FAST_TSC_STUB_TSC_CHILD_PID_FILE: tscChildPidFile,
        VERIFY_FAST_TSC_STUB_ESLINT_CHILD_PID_FILE: eslintChildPidFile,
      }),
    },
  );
}

describe('verify-fast signal lifecycle', () => {
  it.skipIf(!hasBash)(
    // The supervisor runs verify-fast as an async Bash job; SIGTERM is used here
    // because non-interactive async jobs can ignore SIGINT, especially across
    // Windows->WSL launch boundaries. The cleanup assertion is the same: both
    // descendant stub processes must be gone after signal-triggered shutdown.
    'exits 143 on SIGTERM and terminates background stub processes',
    () => {
      const fixture = makeFixture({
        'src/clean.ts': 'export const sourceValue = 1;\n',
        'tests/clean.test.ts': 'export const testValue = 1;\n',
        'scripts/clean.ts': 'export const scriptValue = 1;\n',
      });
      const tscChildPidFile = path.join(fixture, 'tsc-child.pid');
      const eslintChildPidFile = path.join(fixture, 'eslint-child.pid');

      const result = runSignalLifecycleSupervisor(fixture, tscChildPidFile, eslintChildPidFile);

      if (result.status !== 0) {
        throw new Error(
          `signal supervisor failed with status ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        );
      }
      expect(`${result.stdout}\n${result.stderr}`).toContain('signal lifecycle ok');
    },
    30_000,
  );
});
