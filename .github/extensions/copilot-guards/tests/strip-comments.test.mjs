import test from 'node:test';
import assert from 'node:assert/strict';
import { stripCommentsAndStrings } from '../lib/strip-comments.mjs';

test('strips line comments', () => {
  const out = stripCommentsAndStrings('const x = 1; // Math.random()\nconst y = 2;');
  assert.ok(!out.includes('Math.random'));
  assert.ok(out.includes('const x = 1'));
  assert.ok(out.includes('const y = 2'));
});

test('strips block comments', () => {
  const out = stripCommentsAndStrings('/* Math.random() */ const x = Math.random();');
  // First Math.random was inside comment (stripped), second is real code
  const count = (out.match(/Math\.random/g) || []).length;
  assert.equal(count, 1);
});

test('strips single-quoted strings', () => {
  const out = stripCommentsAndStrings("const a = 'Math.random()';");
  assert.ok(!out.includes('Math.random'));
});

test('strips double-quoted strings', () => {
  const out = stripCommentsAndStrings('const a = "Math.random()";');
  assert.ok(!out.includes('Math.random'));
});

test('strips template literal text but keeps expressions', () => {
  const out = stripCommentsAndStrings('const a = `text Math.random() ${Math.random()}`;');
  // Outside ${...} stripped; inside kept
  const count = (out.match(/Math\.random/g) || []).length;
  assert.equal(count, 1);
});

test('preserves code outside strings/comments', () => {
  const src = 'function f() { return Math.random(); }';
  const out = stripCommentsAndStrings(src);
  assert.match(out, /Math\.random/);
});

test('handles escape sequences in strings', () => {
  const out = stripCommentsAndStrings("const a = 'it\\'s ok Math.random()';");
  assert.ok(!out.includes('Math.random'));
});

test('scans Math.random inside ${...} preceded by a code block with braces', () => {
  // Regression: depth tracking on every `}` previously broke after the
  // first `}` inside an object literal, dropping the rest of the
  // expression including the forbidden call.
  const src = 'const a = `prefix ${ ({a:1, b:2}, Math.random()) } suffix`;';
  const out = stripCommentsAndStrings(src);
  assert.match(out, /Math\.random/, 'must still see Math.random in the expression body');
});

test('scans Math.random inside nested object literal in template expression', () => {
  const src = 'const a = `${ {nested: {x: Math.random()}} }`;';
  const out = stripCommentsAndStrings(src);
  assert.match(out, /Math\.random/);
});

test('scans Math.random inside nested template inside ${...}', () => {
  const src = 'const a = `${ `inner ${Math.random()}` }`;';
  const out = stripCommentsAndStrings(src);
  assert.match(out, /Math\.random/);
});

test("stripCommentsOnly recurses into template ${...} so import 'phaser' is visible", async () => {
  const { stripCommentsOnly } = await import('../lib/strip-comments.mjs');
  // Real false-negative: a template-literal expression could hide
  // require('phaser') from edit-phaser-in-core. The strings inside the
  // expression must still pass through so the regex matches.
  const src = "const x = `${require('phaser')}`;";
  const out = stripCommentsOnly(src);
  assert.match(out, /require\(\s*['"]phaser['"]\s*\)/);
});

test('stripCommentsOnly preserves string contents but drops comments inside ${...}', async () => {
  const { stripCommentsOnly } = await import('../lib/strip-comments.mjs');
  const src = "const x = `${ 'keep' /* drop */ }`;";
  const out = stripCommentsOnly(src);
  assert.match(out, /'keep'/);
  assert.ok(!out.includes('drop'), 'comment inside expression must be removed');
});
