import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSION_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../extension.mjs',
);

test('extension registers read-only PR cockpit tools', () => {
  const source = readFileSync(EXTENSION_PATH, 'utf8');
  assert.match(source, /name: 'list_pr_cockpit'/);
  assert.match(source, /name: 'get_pr_cockpit'/);
  assert.match(source, /name: 'get_pr_blockers'/);
  assert.doesNotMatch(source, /gh pr merge|gh pr create|gh api -X PATCH/);
});
