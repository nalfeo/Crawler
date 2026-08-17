import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSION_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../extension.mjs',
);

test('extension registers sweep dispatch tools alongside the viewer canvas', () => {
  const source = readFileSync(EXTENSION_PATH, 'utf8');
  assert.match(source, /name: 'dispatch_weapon_sweep'/);
  assert.match(source, /name: 'dispatch_ai_sweep'/);
  assert.match(source, /id: 'sweep-results-viewer'/);
});
