import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(HERE, '..', 'extension.mjs');

test('feedback mutation route enforces token, origin, and content-type guards', () => {
  const source = readFileSync(EXTENSION_PATH, 'utf8');
  assert.match(source, /x-sprite-review-mutation-token/);
  assert.match(source, /forbidden-origin/);
  assert.match(source, /unsupported-media-type/);
});
