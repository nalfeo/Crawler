import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bashEnv, toBashScriptPath } from '../helpers/bash-script-path.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = toBashScriptPath(path.join(REPO_ROOT, 'scripts/agent/verify-fast.sh'));
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const hasGit = spawnSync('git', ['--version']).status === 0;
const fixtureDirs: string[] = [];

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
  const dir = mkdtempSync(path.join(tmpdir(), 'verify-fast-typecheck-'));
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
        extends: path.join(REPO_ROOT, 'tsconfig.json'),
        compilerOptions: {
          declaration: false,
          declarationMap: false,
          sourceMap: false,
          outDir: './dist',
          tsBuildInfoFile: './fixture.tsbuildinfo',
        },
        include: [
          'vite.config.ts',
          'vitest.config.ts',
          'vitest.mutation.config.ts',
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

  // Ensure `npx tsc` resolves from the fixture dir. npm v10 does not traverse
  // parent directories for `tsc`; it needs a local node_modules/.bin/tsc so it
  // doesn't fall through to the `tsc` npm-registry stub.
  const nodeBinDir = path.join(dir, 'node_modules', '.bin');
  mkdirSync(nodeBinDir, { recursive: true });
  const localTscBin = path.join(nodeBinDir, 'tsc');
  const localTscEntry = path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  writeFileSync(localTscBin, `#!/usr/bin/env node\nrequire(${JSON.stringify(localTscEntry)});\n`);
  chmodSync(localTscBin, 0o755);

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
  it
    .skipIf(!hasBash)
    .each([
      'src',
      'tests',
      'scripts',
      'tools',
      'vite.config.ts',
      'vitest.config.ts',
      'vitest.mutation.config.ts',
    ] as const)(
    'fails for a %s-only narrowed property error',
    (directory) => {
      const files: Record<string, string> = {
        'src/clean.ts': 'export const sourceValue = 1;\n',
        'tests/clean.test.ts': 'export const testValue = 1;\n',
        'scripts/clean.ts': 'export const scriptValue = 1;\n',
        'tools/clean.ts': 'export const toolValue = 1;\n',
        'vite.config.ts': 'export const rootValue = 1;\n',
        'vitest.config.ts': 'export const vitestRootValue = 1;\n',
        'vitest.mutation.config.ts': 'export const vitestMutationValue = 1;\n',
      };
      const errorPath = (() => {
        switch (directory) {
          case 'tests':
            return 'tests/narrowing.test.ts';
          case 'vite.config.ts':
            return 'vite.config.ts';
          case 'vitest.config.ts':
            return 'vitest.config.ts';
          case 'vitest.mutation.config.ts':
            return 'vitest.mutation.config.ts';
          default:
            return `${directory}/narrowing.ts`;
        }
      })();
      files[errorPath] = narrowingError;
      const fixture = makeFixture(files);

      const result = runStaticVerifier(fixture, {
        project: path.join(fixture, 'tsconfig.json'),
      });

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
        'tools/clean.ts': 'export const toolValue = 1;\n',
        'vite.config.ts': 'export const rootValue = 1;\n',
        'vitest.config.ts': 'export const vitestRootValue = 1;\n',
      });

      const result = runStaticVerifier(fixture, {
        project: path.join(fixture, 'tsconfig.json'),
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Fast verifier static checks passed');
    },
    30_000,
  );
});

describe('verify-fast production-default typecheck (no project override)', () => {
  // These tests exercise the production TSC_PROJECT default ("tsconfig.json") by running
  // verify-fast.sh from the fixture directory without VERIFY_FAST_TSC_PROJECT set.
  // The fixture dir is in /tmp — outside any git repo — so the git block is bypassed and
  // tsc runs with the script's built-in default. If the production default ever regresses
  // to tsconfig.src.json (which omits tests/**), the clean case would fail (non-zero from
  // a missing project file) and the error case would fail the TS2339 assertion.

  it.skipIf(!hasBash)(
    'passes clean inputs using the default tsconfig.json',
    () => {
      const fixture = makeFixture({
        'src/clean.ts': 'export const sourceValue = 1;\n',
        'tests/clean.test.ts': 'export const testValue = 1;\n',
        'scripts/clean.ts': 'export const scriptValue = 1;\n',
        'tools/clean.ts': 'export const toolValue = 1;\n',
        'vite.config.ts': 'export const rootValue = 1;\n',
        'vitest.config.ts': 'export const vitestRootValue = 1;\n',
      });

      // No project option → VERIFY_FAST_TSC_PROJECT not set → script uses the
      // production default TSC_PROJECT="tsconfig.json", found in the fixture dir.
      const result = runStaticVerifier(fixture);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Fast verifier static checks passed');
    },
    30_000,
  );

  it.skipIf(!hasBash)(
    'fails for a tests-only narrowed property error using the default tsconfig.json',
    () => {
      const fixture = makeFixture({
        'src/clean.ts': 'export const sourceValue = 1;\n',
        'tests/narrowing.test.ts': narrowingError,
        'scripts/clean.ts': 'export const scriptValue = 1;\n',
        'tools/clean.ts': 'export const toolValue = 1;\n',
        'vite.config.ts': 'export const rootValue = 1;\n',
        'vitest.config.ts': 'export const vitestRootValue = 1;\n',
      });

      const result = runStaticVerifier(fixture);

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/TS2339/);
    },
    30_000,
  );
});

function runGit(dir: string, ...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function initGitFixture(dir: string): void {
  runGit(dir, 'init');
  runGit(dir, 'config', 'user.name', 'Copilot');
  runGit(dir, 'config', 'user.email', 'copilot@example.com');
  // Disable signing so the commit works on any runner regardless of global
  // commit.gpgsign settings (mirrors local-scope.test.ts:137).
  runGit(dir, 'config', 'commit.gpgsign', 'false');
  runGit(dir, 'add', '.');
  runGit(dir, 'commit', '-m', 'fixture');
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
        'vitest.config.ts': 'export const vitestRootValue = 1;\n',
        // commitlint.config.ts is a real-world root TS file that is NOT in the
        // supported surface — used here as the canonical "unsupported" example.
        'commitlint.config.ts': 'export const unsupportedRootValue = 1;\n',
      });
      initGitFixture(fixture);
      writeFileSync(path.join(fixture, 'commitlint.config.ts'), narrowingError);

      const result = runStaticVerifier(fixture, { cwd: fixture });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        'verify:fast does not support changed TypeScript files outside vite.config.ts, vitest.config.ts, src/, tests/, scripts/, functions/, and tools/:',
      );
      expect(`${result.stdout}\n${result.stderr}`).toContain('commitlint.config.ts');
    },
    30_000,
  );

  it.skipIf(!hasBash || !hasGit)(
    'fails when a changed .mts file is outside the supported verifier roots',
    () => {
      const fixture = makeFixture({
        'src/clean.ts': 'export const sourceValue = 1;\n',
        'tests/clean.test.ts': 'export const testValue = 1;\n',
        'scripts/clean.ts': 'export const scriptValue = 1;\n',
        'tools/clean.ts': 'export const toolValue = 1;\n',
        'vite.config.ts': 'export const rootValue = 1;\n',
        'vitest.config.ts': 'export const vitestRootValue = 1;\n',
        'vitest.config.mts': 'export const unsupportedMtsValue = 1;\n',
      });
      initGitFixture(fixture);
      writeFileSync(path.join(fixture, 'vitest.config.mts'), 'export const x = 1;\n');

      const result = runStaticVerifier(fixture, { cwd: fixture });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        'verify:fast does not support changed TypeScript files outside vite.config.ts, vitest.config.ts, src/, tests/, scripts/, functions/, and tools/:',
      );
      expect(`${result.stdout}\n${result.stderr}`).toContain('vitest.config.mts');
    },
    30_000,
  );

  it.skipIf(!hasBash || !hasGit)(
    'catches a clean-committed unsupported TS file when GITHUB_BASE_SHA is set',
    () => {
      // Simulates a shallow CI checkout where there is no origin/main to resolve
      // a merge base, but GITHUB_BASE_SHA is injected by the Actions runner.
      const fixture = makeFixture({
        'src/clean.ts': 'export const sourceValue = 1;\n',
        'tests/clean.test.ts': 'export const testValue = 1;\n',
        'scripts/clean.ts': 'export const scriptValue = 1;\n',
        'tools/clean.ts': 'export const toolValue = 1;\n',
        'vite.config.ts': 'export const rootValue = 1;\n',
        'vitest.config.ts': 'export const vitestRootValue = 1;\n',
      });
      // First commit: initial clean state (this becomes the base SHA).
      initGitFixture(fixture);
      const baseSha = runGit(fixture, 'rev-parse', 'HEAD');

      // Second commit: add an unsupported TS file — clean, no uncommitted changes.
      writeFileSync(path.join(fixture, 'commitlint.config.ts'), 'export const x = 1;\n');
      runGit(fixture, 'add', 'commitlint.config.ts');
      runGit(fixture, 'commit', '-m', 'add unsupported file');

      // Run with GITHUB_BASE_SHA pointing to the first commit so the diff
      // includes the unsupported file even without a resolvable origin/main.
      const env: Record<string, string> = {
        NODE_ENV: 'test',
        VERIFY_FAST_TEST_STATIC_ONLY: '1',
        GITHUB_BASE_SHA: baseSha,
      };
      const result = spawnSync('bash', [SCRIPT], {
        cwd: fixture,
        encoding: 'utf8',
        timeout: 30_000,
        env: bashEnv(env),
      });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        'verify:fast does not support changed TypeScript files outside vite.config.ts, vitest.config.ts, src/, tests/, scripts/, functions/, and tools/:',
      );
      expect(`${result.stdout}\n${result.stderr}`).toContain('commitlint.config.ts');
    },
    30_000,
  );

  it.skipIf(!hasBash || !hasGit)(
    'fails closed when a clean-committed unsupported TS file exists but no merge base is available',
    () => {
      const fixture = makeFixture({
        'src/clean.ts': 'export const sourceValue = 1;\n',
        'tests/clean.test.ts': 'export const testValue = 1;\n',
        'scripts/clean.ts': 'export const scriptValue = 1;\n',
        'tools/clean.ts': 'export const toolValue = 1;\n',
        'vite.config.ts': 'export const rootValue = 1;\n',
        'vitest.config.ts': 'export const vitestRootValue = 1;\n',
      });
      initGitFixture(fixture);
      writeFileSync(path.join(fixture, 'commitlint.config.ts'), 'export const x = 1;\n');
      runGit(fixture, 'add', 'commitlint.config.ts');
      runGit(fixture, 'commit', '-m', 'add unsupported file');

      const result = runStaticVerifier(fixture, { cwd: fixture });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        'verify:fast could not determine a git merge base for changed-file scanning.',
      );
    },
    30_000,
  );
});

describe('verify-fast changed .mjs path coverage', () => {
  it.skipIf(!hasBash || !hasGit)(
    'accepts changed .github/scripts .mjs files',
    () => {
      const fixture = makeFixture({
        'src/clean.ts': 'export const sourceValue = 1;\n',
        'tests/clean.test.ts': 'export const testValue = 1;\n',
        'scripts/clean.ts': 'export const scriptValue = 1;\n',
        'tools/clean.ts': 'export const toolValue = 1;\n',
        'vite.config.ts': 'export const rootValue = 1;\n',
        'vitest.config.ts': 'export const vitestRootValue = 1;\n',
        '.github/scripts/example.mjs': 'export const example = 1;\n',
      });
      initGitFixture(fixture);
      writeFileSync(
        path.join(fixture, '.github/scripts/example.mjs'),
        'export const example = 2;\n',
      );

      const result = runStaticVerifier(fixture, { cwd: fixture });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Fast verifier static checks passed');
    },
    30_000,
  );

  it.skipIf(!hasBash || !hasGit)(
    'accepts changed .github/extensions .mjs files without linting them locally',
    () => {
      const fixture = makeFixture({
        'src/clean.ts': 'export const sourceValue = 1;\n',
        'tests/clean.test.ts': 'export const testValue = 1;\n',
        'scripts/clean.ts': 'export const scriptValue = 1;\n',
        'tools/clean.ts': 'export const toolValue = 1;\n',
        'vite.config.ts': 'export const rootValue = 1;\n',
        'vitest.config.ts': 'export const vitestRootValue = 1;\n',
        '.github/extensions/my-ext/extension.mjs': 'export const ext = 1;\n',
      });
      initGitFixture(fixture);
      writeFileSync(
        path.join(fixture, '.github/extensions/my-ext/extension.mjs'),
        'export const ext = 2;\n',
      );

      const result = runStaticVerifier(fixture, { cwd: fixture });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Fast verifier static checks passed');
    },
    30_000,
  );

  it.skipIf(!hasBash || !hasGit)(
    'accepts a changed .github/extensions .d.mts declaration file beside a known .mjs module',
    () => {
      // Regression: a hand-written `.d.mts` twin lets a .ts file import a
      // sibling .mjs without `allowJs` (see
      // .github/extensions/sprite-editor/lib/pending-annotation-overlay.d.mts).
      // It must be treated like the .mjs it types -- known and skip-locally,
      // not rejected as an unsupported changed TypeScript file.
      const fixture = makeFixture({
        'src/clean.ts': 'export const sourceValue = 1;\n',
        'tests/clean.test.ts': 'export const testValue = 1;\n',
        'scripts/clean.ts': 'export const scriptValue = 1;\n',
        'tools/clean.ts': 'export const toolValue = 1;\n',
        'vite.config.ts': 'export const rootValue = 1;\n',
        'vitest.config.ts': 'export const vitestRootValue = 1;\n',
        '.github/extensions/my-ext/lib/shared.mjs': 'export const shared = 1;\n',
        '.github/extensions/my-ext/lib/shared.d.mts': 'export declare const shared: number;\n',
      });
      initGitFixture(fixture);
      writeFileSync(
        path.join(fixture, '.github/extensions/my-ext/lib/shared.d.mts'),
        'export declare const shared: number;\nexport declare const added: string;\n',
      );

      const result = runStaticVerifier(fixture, { cwd: fixture });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Fast verifier static checks passed');
    },
    30_000,
  );

  it.skipIf(!hasBash || !hasGit)(
    'still rejects a changed .d.mts file outside .github/extensions/ and the supported TS trees',
    () => {
      const fixture = makeFixture({
        'src/clean.ts': 'export const sourceValue = 1;\n',
        'tests/clean.test.ts': 'export const testValue = 1;\n',
        'scripts/clean.ts': 'export const scriptValue = 1;\n',
        'tools/clean.ts': 'export const toolValue = 1;\n',
        'vite.config.ts': 'export const rootValue = 1;\n',
        'vitest.config.ts': 'export const vitestRootValue = 1;\n',
        'infra/shared.d.mts': 'export declare const infraValue: number;\n',
      });
      initGitFixture(fixture);
      writeFileSync(
        path.join(fixture, 'infra/shared.d.mts'),
        'export declare const infraValue: number;\nexport declare const added: string;\n',
      );

      const result = runStaticVerifier(fixture, { cwd: fixture });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        'verify:fast does not support changed TypeScript files outside vite.config.ts, vitest.config.ts, src/, tests/, scripts/, functions/, and tools/:',
      );
      expect(`${result.stdout}\n${result.stderr}`).toContain('infra/shared.d.mts');
    },
    30_000,
  );

  it.skipIf(!hasBash || !hasGit)(
    'accepts changed scripts/ .mjs files without linting them locally',
    () => {
      const fixture = makeFixture({
        'src/clean.ts': 'export const sourceValue = 1;\n',
        'tests/clean.test.ts': 'export const testValue = 1;\n',
        'scripts/clean.ts': 'export const scriptValue = 1;\n',
        'tools/clean.ts': 'export const toolValue = 1;\n',
        'vite.config.ts': 'export const rootValue = 1;\n',
        'vitest.config.ts': 'export const vitestRootValue = 1;\n',
        'scripts/agent/my-tool.mjs': 'export const tool = 1;\n',
      });
      initGitFixture(fixture);
      writeFileSync(path.join(fixture, 'scripts/agent/my-tool.mjs'), 'export const tool = 2;\n');

      const result = runStaticVerifier(fixture, { cwd: fixture });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Fast verifier static checks passed');
    },
    30_000,
  );

  it.skipIf(!hasBash || !hasGit)(
    'fails when a changed .mjs file is in a truly unsupported location',
    () => {
      const fixture = makeFixture({
        'src/clean.ts': 'export const sourceValue = 1;\n',
        'tests/clean.test.ts': 'export const testValue = 1;\n',
        'scripts/clean.ts': 'export const scriptValue = 1;\n',
        'tools/clean.ts': 'export const toolValue = 1;\n',
        'vite.config.ts': 'export const rootValue = 1;\n',
        'vitest.config.ts': 'export const vitestRootValue = 1;\n',
        'vitest.config.mjs': 'export const unsupportedMjsValue = 1;\n',
      });
      initGitFixture(fixture);
      writeFileSync(
        path.join(fixture, 'vitest.config.mjs'),
        'export const unsupportedMjsValue = 2;\n',
      );

      const result = runStaticVerifier(fixture, { cwd: fixture });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        'verify:fast does not support changed .mjs files outside .github/scripts/, .github/extensions/, or scripts/:',
      );
      expect(`${result.stdout}\n${result.stderr}`).toContain('vitest.config.mjs');
    },
    30_000,
  );
});

describe('.github/scripts lint wiring', () => {
  it('package lint scripts include .github/scripts', () => {
    const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts.lint).toContain('.github/scripts/');
    expect(packageJson.scripts['lint:cache']).toContain('.github/scripts/');
  });
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

kill_recorded_descendants() {
  local pid_file="$1"
  [ -s "$pid_file" ] || return 0
  local child_pid
  child_pid="$(tr -d '[:space:]' < "$pid_file")"
  [[ "$child_pid" =~ ^[0-9]+$ ]] || return 0
  # Attempt both process-group and pid termination so descendants die even if
  # verify-fast itself was SIGKILLed before its EXIT trap ran.
  kill -TERM -- "-$child_pid" 2>/dev/null || true
  kill -TERM "$child_pid" 2>/dev/null || true
  sleep 0.05
  kill -KILL -- "-$child_pid" 2>/dev/null || true
  kill -KILL "$child_pid" 2>/dev/null || true
}

cleanup() {
  kill_recorded_descendants "$tsc_pid_file"
  kill_recorded_descendants "$eslint_pid_file"
  kill -TERM -- "-$verify_pid" 2>/dev/null || true
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
# Poll up to 1 s for descendants to be fully reaped; process-table cleanup
# (zombie → gone) is asynchronous and may lag by a few ms on loaded CI runners.
poll_attempts=20
poll_attempt=0
while kill -0 "$tsc_child" 2>/dev/null || kill -0 "$eslint_child" 2>/dev/null; do
  if [ "$poll_attempt" -ge "$poll_attempts" ]; then
    echo "Descendant process survived cleanup (tsc=$tsc_child eslint=$eslint_child)" >&2
    exit 1
  fi
  poll_attempt=$((poll_attempt + 1))
  sleep 0.05
done
trap - EXIT
echo "signal lifecycle ok"
`,
  );

  return spawnSync(
    'bash',
    [
      toBashScriptPath(supervisorScript),
      SCRIPT,
      toBashScriptPath(logFile),
      toBashScriptPath(tscChildPidFile),
      toBashScriptPath(eslintChildPidFile),
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
        VERIFY_FAST_TSC_STUB_TSC_CHILD_PID_FILE: toBashScriptPath(tscChildPidFile),
        VERIFY_FAST_TSC_STUB_ESLINT_CHILD_PID_FILE: toBashScriptPath(eslintChildPidFile),
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
