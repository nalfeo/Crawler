/**
 * extension.mjs wires a live @github/copilot-sdk/extension session at import
 * time (joinSession(...) runs as a side effect of loading the module), so it
 * cannot be safely `import`-ed from a unit test without a full SDK mock. This
 * mirrors the workflow extension's `extension-security-guards.test.mjs`
 * convention of asserting on the source text of the handler instead.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '..', 'extension.mjs');

test('load_sheet returns a unique reload URL so the host iframe re-navigates on mutation', () => {
  const source = readFileSync(EXTENSION_PATH, 'utf8');
  const start = source.indexOf("name: 'load_sheet'");
  assert.ok(start >= 0, 'load_sheet action must exist');
  const end = source.indexOf('},', source.indexOf('handler: async (ctx)', start));
  const handler = source.slice(start, end < 0 ? source.length : end);
  // A stale `{ ok: true, url: entry.url }` return means the host sees the
  // SAME url as before the mutation and does not reload the iframe, so the
  // canvas keeps showing the pre-swap sheet/animation.
  assert.doesNotMatch(handler, /return \{ ok: true, url: entry\.url \};/);
  assert.match(
    handler,
    /return \{ ok: true, url: `\$\{entry\.url\}\?reload=\$\{Date\.now\(\)\}` \};/,
  );
});
