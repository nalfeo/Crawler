import test from 'node:test';
import assert from 'node:assert/strict';
import guard from '../guards/edit-phaser-in-core.mjs';

test('denies import from phaser in src/core', () => {
  const r = guard.check({
    path: 'src/core/foo.ts',
    new_str: "import Phaser from 'phaser';\nexport const x = 1;",
  });
  assert.equal(r.decision, 'deny');
});

test("denies require('phaser') in src/core", () => {
  const r = guard.check({
    path: 'src/core/foo.ts',
    new_str: "const Phaser = require('phaser');",
  });
  assert.equal(r.decision, 'deny');
});

test('denies dynamic import of phaser in src/core', () => {
  const r = guard.check({
    path: 'src/core/foo.ts',
    new_str: "const m = await import('phaser');",
  });
  assert.equal(r.decision, 'deny');
});

test('allows phaser import in src/engine', () => {
  assert.equal(guard.matches('edit', { path: 'src/engine/render.ts' }), false);
});

test('allows clean edit in src/core', () => {
  const r = guard.check({
    path: 'src/core/foo.ts',
    new_str: "import { query } from 'bitecs';",
  });
  assert.equal(r.decision, 'allow');
});

test('ignores phaser mention in comment/string', () => {
  const r = guard.check({
    path: 'src/core/foo.ts',
    new_str: "// don't import from 'phaser' here\nconst x = \"phaser\";",
  });
  assert.equal(r.decision, 'allow');
});
