import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  collectBareEsmImports,
  findFileViolations,
  scanExtensions,
} from './health/check-extensions.mjs';

test('collectBareEsmImports detects static, side-effect, dynamic, and multiline imports', () => {
  const source = `
import zod from 'zod';
import 'yaml';
import(
  'esbuild'
);
import {
  parse
} from 'yaml';
`;
  const imports = collectBareEsmImports(source).map((entry) => entry.specifier);
  assert.ok(imports.includes('zod'));
  assert.ok(imports.includes('yaml'));
  assert.ok(imports.includes('esbuild'));
  const multilineOnly = collectBareEsmImports("import {\n  parse\n} from 'yaml';\n").map(
    (entry) => entry.specifier,
  );
  assert.deepEqual(multilineOnly, ['yaml']);
});

test('findFileViolations ignores comments/strings and allowed node/sdk imports', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'check-ext-'));
  try {
    const file = path.join(root, 'example.mjs');
    writeFileSync(
      file,
      `
// import 'zod'
const s = "import('yaml')";
import fs from 'node:fs';
import { register } from '@github/copilot-sdk';
import 'zod';
`,
    );
    const violations = findFileViolations(file);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].specifier, 'zod');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scanExtensions finds violations under .github/extensions and skips tests directories', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'check-ext-tree-'));
  try {
    const extRoot = path.join(root, '.github', 'extensions', 'demo');
    mkdirSync(path.join(extRoot, 'lib'), { recursive: true });
    mkdirSync(path.join(extRoot, 'tests'), { recursive: true });
    writeFileSync(path.join(extRoot, 'lib', 'bad.mjs'), "import 'zod';\n");
    writeFileSync(path.join(extRoot, 'tests', 'ok.test.mjs'), "import 'yaml';\n");

    const result = scanExtensions({ repoRoot: root });
    assert.equal(result.filesChecked, 1);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].specifier, 'zod');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
