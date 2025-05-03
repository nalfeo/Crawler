import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Regression coverage for the `verify:fast` TypeScript gate.
 *
 * Before this fix, `scripts/agent/verify-fast.sh` ran `tsc --project
 * tsconfig.src.json`, which excludes `tests/` and `scripts/`. A TS error in a
 * test file therefore produced a false-green local gate. This suite proves:
 *
 *  1. The script now references `tsconfig.json` (which includes tests/ and
 *     scripts/) rather than the src-only config.
 *  2. `tsconfig.json` includes `tests/**\/*.ts` in its include paths.
 *  3. A TS2339 error in a test file (the exact pre-fix error class) is caught
 *     by `tsc --noEmit --project tsconfig.json`.
 *  4. A clean test file passes the same check.
 */

const __dirname_resolved = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname_resolved, '../..');
const require = createRequire(import.meta.url);
const TSC_BIN = require.resolve('typescript/bin/tsc');

const MINIMAL_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'ES2022',
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    lib: ['ES2022'],
  },
  include: ['src/**/*.ts', 'tests/**/*.ts'],
});

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeTsProject(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vf-typecheck-'));
  tempDirs.push(dir);
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(dir, relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

function runTsc(args: string[], cwd = REPO_ROOT) {
  return spawnSync(process.execPath, [TSC_BIN, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

describe('verify:fast typecheck gate', () => {
  it('verify-fast.sh invokes tsc with tsconfig.json, not tsconfig.src.json', () => {
    const source = readFileSync(path.join(REPO_ROOT, 'scripts/agent/verify-fast.sh'), 'utf8');
    // The typecheck step must reference the full tsconfig (src + tests + scripts).
    expect(source).toMatch(/tsc\b.*--project\s+(?:\.\/)?["']?tsconfig\.json["']?/);
    // The src-only config must NOT be used for the typecheck step.
    expect(source).not.toMatch(/tsc\b.*--project\s+(?:\.\/)?["']?tsconfig\.src\.json["']?/);
  });

  it('resolved tsconfig.json includes tests/**/*.ts', () => {
    const result = runTsc(['--showConfig', '--project', path.join(REPO_ROOT, 'tsconfig.json')]);
    expect(result.status).toBe(0);
    const tsconfig = JSON.parse(result.stdout) as {
      include?: string[];
    };
    expect(tsconfig.include).toContain('tests/**/*.ts');
  });

  it('tsc exits non-zero for a TS2339 error in a test file (pre-fix regression class)', () => {
    const dir = makeTsProject({
      'tsconfig.json': MINIMAL_TSCONFIG,
      'src/ok.ts': 'export const x = 1;\n',
      // TS2339: accessing a property that does not exist on the declared type.
      // This is the exact error class reproduced on d858c905 in
      // tests/unit/shared/generated-equipment-generator.test.ts.
      'tests/broken.test.ts': [
        'const obj: { a: number } = { a: 1 };',
        'const _bad = obj.nonExistentProp;',
        'export {};',
      ].join('\n'),
    });
    const result = runTsc(['--noEmit', '--project', path.join(dir, 'tsconfig.json')], dir);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('TS2339');
  });

  it('tsc exits 0 for a clean test file', () => {
    const dir = makeTsProject({
      'tsconfig.json': MINIMAL_TSCONFIG,
      'src/ok.ts': 'export const x = 1;\n',
      'tests/valid.test.ts': [
        'const obj: { a: number } = { a: 1 };',
        'const _good: number = obj.a;',
        'export {};',
      ].join('\n'),
    });
    const result = runTsc(['--noEmit', '--project', path.join(dir, 'tsconfig.json')], dir);
    expect(result.status).toBe(0);
  });
});
