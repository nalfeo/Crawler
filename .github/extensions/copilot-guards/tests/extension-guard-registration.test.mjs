import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSION_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../extension.mjs',
);

test('extension imports and activates shell-blunt-merge-strategy', () => {
  const source = readFileSync(EXTENSION_PATH, 'utf8');
  assert.match(
    source,
    /import shellBluntMergeStrategy from '\.\/guards\/shell-blunt-merge-strategy\.mjs';/,
  );
  const guardsArray = source.match(/const guards = \[([\s\S]*?)\];/);
  assert.ok(guardsArray, 'expected to find the guards array in extension.mjs');
  assert.match(guardsArray[1], /\bshellBluntMergeStrategy\b/);
});
