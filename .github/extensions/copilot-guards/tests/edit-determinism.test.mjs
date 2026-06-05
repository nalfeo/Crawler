import test from 'node:test';
import assert from 'node:assert/strict';
import guard, { findViolations, shouldCheck } from '../guards/edit-determinism.mjs';

test('shouldCheck on guarded paths', () => {
  assert.equal(shouldCheck('src/core/foo.ts'), true);
  assert.equal(shouldCheck('src/game/bar.ts'), true);
  assert.equal(shouldCheck('src/shared/rng.ts'), true);
  assert.equal(shouldCheck('src\\core\\foo.ts'), true); // windows path

  // Excluded
  assert.equal(shouldCheck('src/labs/whatever.ts'), false);
  assert.equal(shouldCheck('src/engine/render.ts'), false);
  assert.equal(shouldCheck('tests/foo.ts'), false);
  assert.equal(shouldCheck('src/core/foo.test.ts'), false);
  assert.equal(shouldCheck('src/core/foo.spec.ts'), false);
  assert.equal(shouldCheck('src/core/foo.d.ts'), false);
  assert.equal(shouldCheck('README.md'), false);
});

test('findViolations catches Math.random call', () => {
  const hits = findViolations('const r = Math.random();');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, 'Math.random()');
});

test('findViolations catches Date.now and performance.now', () => {
  const hits = findViolations('const t = Date.now() + performance.now();');
  assert.equal(hits.length, 2);
});

test('findViolations ignores occurrences in comments', () => {
  const hits = findViolations('// avoid Math.random() here\nconst r = 5;');
  assert.equal(hits.length, 0);
});

test('findViolations ignores occurrences in strings', () => {
  const hits = findViolations('const msg = "use Math.random()";');
  assert.equal(hits.length, 0);
});

test('findViolations catches Math.random inside template expression', () => {
  const hits = findViolations('const s = `r=${Math.random()}`;');
  assert.equal(hits.length, 1);
});

test('guard denies edit introducing Math.random in src/core', () => {
  const r = guard.check({
    path: 'src/core/system.ts',
    new_str: 'function step(world) { return Math.random(); }',
  });
  assert.equal(r.decision, 'deny');
});

test('guard allows edit introducing Math.random in src/labs', () => {
  const fakeArgs = {
    path: 'src/labs/foo-lab/index.ts',
    new_str: 'Math.random();',
  };
  assert.equal(guard.matches('edit', fakeArgs), false);
});

test('guard allows clean edit in src/core', () => {
  const r = guard.check({
    path: 'src/core/system.ts',
    new_str: 'function step(world) { return world.rng.next(); }',
  });
  assert.equal(r.decision, 'allow');
});
