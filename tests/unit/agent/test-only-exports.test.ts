import { describe, expect, it } from 'vitest';
import {
  buildTestScaffoldAllowlist,
  collectNamedExports,
  collectNamedImports,
  findDuplicateExportNames,
  findTestOnlyExports,
  isTestScaffoldAllowlisted,
  type SourceFile,
} from '../../../scripts/agent/health/test-only-exports-lib.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Helper: build a SourceFile with a given path and content. */
function src(path: string, content: string): SourceFile {
  return { path, content };
}

// ---------------------------------------------------------------------------
// collectNamedExports
// ---------------------------------------------------------------------------

describe('collectNamedExports', () => {
  it('collects exported function declarations', () => {
    const result = collectNamedExports([src('src/foo.ts', 'export function myFn() {}')]);
    expect(result).toEqual([{ name: 'myFn', file: 'src/foo.ts' }]);
  });

  it('collects exported const declarations', () => {
    const result = collectNamedExports([src('src/foo.ts', 'export const MY_CONST = 42;')]);
    expect(result).toEqual([{ name: 'MY_CONST', file: 'src/foo.ts' }]);
  });

  it('collects exported class declarations', () => {
    const result = collectNamedExports([src('src/foo.ts', 'export class MyClass {}')]);
    expect(result).toEqual([{ name: 'MyClass', file: 'src/foo.ts' }]);
  });

  it('collects exported interface declarations', () => {
    const result = collectNamedExports([src('src/foo.ts', 'export interface MyInterface {}')]);
    expect(result).toEqual([{ name: 'MyInterface', file: 'src/foo.ts' }]);
  });

  it('collects exported type aliases', () => {
    const result = collectNamedExports([src('src/foo.ts', 'export type MyType = string;')]);
    expect(result).toEqual([{ name: 'MyType', file: 'src/foo.ts' }]);
  });

  it('collects exported enum declarations', () => {
    const result = collectNamedExports([src('src/foo.ts', 'export enum Color { Red, Green }')]);
    expect(result).toEqual([{ name: 'Color', file: 'src/foo.ts' }]);
  });

  it('collects named export specifiers', () => {
    const result = collectNamedExports([src('src/foo.ts', 'function foo() {} export { foo };')]);
    expect(result).toContainEqual({ name: 'foo', file: 'src/foo.ts' });
  });

  it('uses the alias name for renamed export specifiers', () => {
    const result = collectNamedExports([
      src('src/foo.ts', 'function foo() {} export { foo as bar };'),
    ]);
    expect(result).toContainEqual({ name: 'bar', file: 'src/foo.ts' });
  });

  it('does NOT collect barrel re-export specifiers (with from clause)', () => {
    // `export { foo } from '...'` is intentionally excluded: the re-export counts
    // as a src/ consumer of the original, not as a dead-export candidate.
    const result = collectNamedExports([
      src('src/index.ts', "export { listInventoryEntries } from './inventory.js';"),
    ]);
    expect(result).not.toContainEqual({ name: 'listInventoryEntries', file: 'src/index.ts' });
  });

  it('does NOT collect non-exported function declarations', () => {
    const result = collectNamedExports([src('src/foo.ts', 'function notExported() {}')]);
    expect(result).toHaveLength(0);
  });

  it('does NOT collect export default', () => {
    const result = collectNamedExports([src('src/foo.ts', 'export default function() {}')]);
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// collectNamedImports
// ---------------------------------------------------------------------------

describe('collectNamedImports', () => {
  it('collects simple named imports', () => {
    const result = collectNamedImports([src('src/bar.ts', "import { foo } from './foo.js';")]);
    expect(result.get('foo')).toContain('src/bar.ts');
  });

  it('collects the original name for aliased imports', () => {
    const result = collectNamedImports([
      src('src/bar.ts', "import { foo as localFoo } from './foo.js';"),
    ]);
    // Original name tracked, not alias
    expect(result.get('foo')).toContain('src/bar.ts');
    expect(result.has('localFoo')).toBe(false);
  });

  it('collects multiple names from one import statement', () => {
    const result = collectNamedImports([
      src('src/bar.ts', "import { a, b, c } from './stuff.js';"),
    ]);
    expect(result.get('a')).toContain('src/bar.ts');
    expect(result.get('b')).toContain('src/bar.ts');
    expect(result.get('c')).toContain('src/bar.ts');
  });

  it('does NOT treat re-export specifiers (barrel files) as import evidence', () => {
    const result = collectNamedImports([src('src/index.ts', "export { foo } from './foo.js';")]);
    expect(result.has('foo')).toBe(false);
  });

  it('does NOT collect namespace imports', () => {
    const result = collectNamedImports([src('src/bar.ts', "import * as utils from './utils.js';")]);
    expect(result.size).toBe(0);
  });

  it('does NOT collect default imports', () => {
    const result = collectNamedImports([src('src/bar.ts', "import MyClass from './my-class.js';")]);
    expect(result.size).toBe(0);
  });

  it('tracks the same name from multiple importing files', () => {
    const result = collectNamedImports([
      src('src/bar.ts', "import { foo } from './foo.js';"),
      src('src/baz.ts', "import { foo } from './foo.js';"),
    ]);
    const consumers = result.get('foo')!;
    expect(consumers).toContain('src/bar.ts');
    expect(consumers).toContain('src/baz.ts');
  });
});

// ---------------------------------------------------------------------------
// findTestOnlyExports
// ---------------------------------------------------------------------------

describe('findTestOnlyExports', () => {
  it('flags an export consumed only by tests', () => {
    const srcFiles = [
      src(
        'src/shared/inventory.ts',
        'export function listInventoryEntries(bag: unknown) { return []; }',
      ),
    ];
    const testFiles = [
      src(
        'tests/unit/inventory.test.ts',
        "import { listInventoryEntries } from '../../src/shared/inventory.js';",
      ),
    ];

    const results = findTestOnlyExports(srcFiles, testFiles);
    expect(results).toHaveLength(1);
    const [firstResult] = results;
    expect(firstResult!.name).toBe('listInventoryEntries');
    expect(firstResult!.file).toBe('src/shared/inventory.ts');
    expect(firstResult!.testConsumers).toContain('tests/unit/inventory.test.ts');
  });

  it('does NOT flag an export that has a production caller in src/', () => {
    const srcFiles = [
      src('src/shared/foo.ts', 'export function foo() {}'),
      src('src/game/bar.ts', "import { foo } from '../shared/foo.js';"),
    ];
    const testFiles = [
      src('tests/unit/foo.test.ts', "import { foo } from '../../src/shared/foo.js';"),
    ];

    const results = findTestOnlyExports(srcFiles, testFiles);
    expect(results).toHaveLength(0);
  });

  it('does NOT flag an export that has NO consumers at all (not test-only — just dead)', () => {
    const srcFiles = [src('src/shared/foo.ts', 'export function foo() {}')];
    const testFiles: SourceFile[] = [];

    const results = findTestOnlyExports(srcFiles, testFiles);
    expect(results).toHaveLength(0);
  });

  it('does NOT flag an export consumed only by the exporting file itself', () => {
    // Self-import is unusual but possible; should not be counted as a production consumer.
    const srcFiles = [
      src(
        'src/shared/foo.ts',
        [
          'export function foo() {}',
          // A pathological case: re-import within same file (effectively a no-op, but
          // the lib should not treat it as an external src/ consumer).
          "import { foo } from './foo.js';",
        ].join('\n'),
      ),
    ];
    const testFiles = [
      src('tests/unit/foo.test.ts', "import { foo } from '../../src/shared/foo.js';"),
    ];

    // The only src/ "importer" IS the exporting file itself — doesn't count.
    const results = findTestOnlyExports(srcFiles, testFiles);
    expect(results).toHaveLength(1);
    const [firstResult] = results;
    expect(firstResult!.name).toBe('foo');
  });

  it('flags an export when tests reach it only through a src/ barrel re-export', () => {
    const srcFiles = [
      src('src/shared/foo.ts', 'export function foo() {}'),
      src('src/shared/index.ts', "export { foo } from './foo.js';"),
    ];
    const testFiles = [
      src('tests/unit/foo.test.ts', "import { foo } from '../../src/shared/index.js';"),
    ];

    const results = findTestOnlyExports(srcFiles, testFiles);
    expect(results).toHaveLength(1);
    const [firstResult] = results;
    expect(firstResult!.name).toBe('foo');
    expect(firstResult!.file).toBe('src/shared/foo.ts');
  });

  it('flags multiple test-only exports from the same file', () => {
    const srcFiles = [
      src('src/shared/helpers.ts', 'export function helperA() {} export function helperB() {}'),
    ];
    const testFiles = [
      src(
        'tests/unit/helpers.test.ts',
        "import { helperA, helperB } from '../../src/shared/helpers.js';",
      ),
    ];

    const results = findTestOnlyExports(srcFiles, testFiles);
    const names = results.map((r) => r.name);
    expect(names).toContain('helperA');
    expect(names).toContain('helperB');
  });

  it('returns testConsumers listing each test file that imports the symbol', () => {
    const srcFiles = [src('src/shared/foo.ts', 'export function foo() {}')];
    const testFiles = [
      src('tests/unit/a.test.ts', "import { foo } from '../../src/shared/foo.js';"),
      src('tests/property/b.test.ts', "import { foo } from '../../src/shared/foo.js';"),
    ];

    const results = findTestOnlyExports(srcFiles, testFiles);
    expect(results).toHaveLength(1);
    const [firstResult] = results;
    expect(firstResult!.testConsumers).toContain('tests/unit/a.test.ts');
    expect(firstResult!.testConsumers).toContain('tests/property/b.test.ts');
  });
});

// ---------------------------------------------------------------------------
// findDuplicateExportNames
// ---------------------------------------------------------------------------

describe('findDuplicateExportNames', () => {
  it('returns empty for no duplicates', () => {
    const exports = [
      { name: 'foo', file: 'src/a.ts' },
      { name: 'bar', file: 'src/b.ts' },
    ];
    expect(findDuplicateExportNames(exports)).toHaveLength(0);
  });

  it('reports a duplicate when the same name appears in two files', () => {
    const exports = [
      { name: 'create', file: 'src/a.ts' },
      { name: 'create', file: 'src/b.ts' },
    ];
    const dups = findDuplicateExportNames(exports);
    expect(dups).toHaveLength(1);
    const [firstDuplicate] = dups;
    expect(firstDuplicate!.name).toBe('create');
    expect(firstDuplicate!.files).toContain('src/a.ts');
    expect(firstDuplicate!.files).toContain('src/b.ts');
  });

  it('does not report a name that appears once', () => {
    const exports = [{ name: 'uniqueName', file: 'src/x.ts' }];
    expect(findDuplicateExportNames(exports)).toHaveLength(0);
  });
});

describe('isTestScaffoldAllowlisted', () => {
  it('matches only the exact file + symbol pair', () => {
    expect(
      isTestScaffoldAllowlisted({
        file: 'src/shared/generated-assets.ts',
        name: 'buildGeneratedSpriteRegistry',
      }),
    ).toBe(true);

    expect(
      isTestScaffoldAllowlisted({
        file: 'src/shared/another-registry.ts',
        name: 'buildGeneratedSpriteRegistry',
      }),
    ).toBe(false);
  });

  it('supports custom path-scoped allowlists', () => {
    const allowlist = buildTestScaffoldAllowlist([{ file: 'src/a.ts', name: 'foo' }]);
    expect(isTestScaffoldAllowlisted({ file: 'src/a.ts', name: 'foo' }, allowlist)).toBe(true);
    expect(isTestScaffoldAllowlisted({ file: 'src/b.ts', name: 'foo' }, allowlist)).toBe(false);
  });
});
