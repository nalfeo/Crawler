import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bashEnv, toBashScriptPath } from '../helpers/bash-script-path.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = toBashScriptPath(path.join(REPO_ROOT, 'scripts/agent/verify-fast.sh'));
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
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
        include: ['src/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.ts'],
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
  it.skipIf(!hasBash).each(['src', 'tests', 'scripts'] as const)(
    'fails for a %s-only narrowed property error',
    (directory) => {
      const files: Record<string, string> = {
        'src/clean.ts': 'export const sourceValue = 1;\n',
        'tests/clean.test.ts': 'export const testValue = 1;\n',
        'scripts/clean.ts': 'export const scriptValue = 1;\n',
      };
      const errorPath =
        directory === 'tests' ? 'tests/narrowing.test.ts' : `${directory}/narrowing.ts`;
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

/** Intentionally long: must outlast the SIGINT that interrupts the verifier. */
const STUB_DURATION_SECONDS = 300;
/** Brief wait after seeing "Step 1/3" to let background sleep stubs reach their wait state. */
const STUB_STARTUP_DELAY_MS = 200;
/** Bound close wait so regressions cannot hang and leak background stub processes. */
const CLOSE_TIMEOUT_MS = 5_000;

describe('verify-fast signal lifecycle', () => {
  it.skipIf(!hasBash)(
    'exits 130 on SIGINT and terminates background stub processes',
    async () => {
      const fixture = makeFixture({
        'src/clean.ts': 'export const sourceValue = 1;\n',
        'tests/clean.test.ts': 'export const testValue = 1;\n',
        'scripts/clean.ts': 'export const scriptValue = 1;\n',
      });

      const proc = spawn('bash', [SCRIPT], {
        cwd: fixture,
        env: bashEnv({
          NODE_ENV: 'test',
          VERIFY_FAST_TEST_STATIC_ONLY: '1',
          VERIFY_FAST_TSC_PROJECT: path.join(fixture, 'tsconfig.json'),
          // Replace real tsc + lint with sleep stubs so the verifier is blocked
          // in its parallel wait and can be cleanly interrupted via SIGINT.
          VERIFY_FAST_TSC_STUB_SECONDS: String(STUB_DURATION_SECONDS),
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let closed = false;
      const closedPromise = new Promise<number | null>((resolve) => {
        proc.on('close', (code) => {
          closed = true;
          resolve(code);
        });
      });

      try {
        // Wait until the parallel phase has been announced (both background jobs
        // have been launched — the echo precedes the `&` invocations by only the
        // LINT_CMD setup block, which completes in milliseconds).
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Timed out waiting for Step 1/3 output')),
            10_000,
          );
          proc.stdout?.on('data', (chunk: Buffer) => {
            if (chunk.toString().includes('Step 1/3')) {
              clearTimeout(timer);
              // Brief delay to let the background sleep stubs reach their own wait.
              setTimeout(resolve, STUB_STARTUP_DELAY_MS);
            }
          });
          proc.on('exit', () => {
            clearTimeout(timer);
            reject(new Error('Process exited before Step 1/3 was printed'));
          });
        });

        // Interrupt the verifier — should trigger `trap 'exit 130' INT` then
        // `trap cleanup_parallel EXIT`, killing the background process groups.
        proc.kill('SIGINT');

        const closeResult = await Promise.race([
          closedPromise.then((code) => ({ timedOut: false as const, code })),
          new Promise<{ timedOut: true; code: null }>((resolve) => {
            setTimeout(() => resolve({ timedOut: true, code: null }), CLOSE_TIMEOUT_MS);
          }),
        ]);
        if (closeResult.timedOut) {
          proc.kill('SIGKILL');
          await closedPromise;
          throw new Error(`Timed out waiting ${CLOSE_TIMEOUT_MS}ms for SIGINT shutdown`);
        }
        expect(closeResult.code).toBe(130);
      } finally {
        if (!closed) {
          proc.kill('SIGKILL');
          await closedPromise;
        }
      }
    },
    30_000,
  );
});
