import { spawnSync } from 'node:child_process';
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

function runStaticVerifier(fixtureDir: string) {
  const project = path
    .relative(REPO_ROOT, path.join(fixtureDir, 'tsconfig.json'))
    .replace(/\\/g, '/');
  return spawnSync('bash', [SCRIPT], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    env: bashEnv({
      NODE_ENV: 'test',
      VERIFY_FAST_TEST_STATIC_ONLY: '1',
      VERIFY_FAST_TSC_PROJECT: project,
    }),
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

      const result = runStaticVerifier(fixture);

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("Property 'reason' does not exist");
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

      const result = runStaticVerifier(fixture);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Fast verifier static checks passed');
    },
    30_000,
  );
});
