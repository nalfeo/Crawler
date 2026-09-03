import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RETIRED_ISSUE_TITLE = ['balance:', 'telemetry-driven nightly improvement sweep'].join(' ');

async function automationSources(relativeRoot) {
  const root = path.join(REPO_ROOT, relativeRoot);
  const entries = await readdir(root, { withFileTypes: true });
  const sources = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeRoot, entry.name);
    if (entry.isDirectory()) {
      sources.push(...(await automationSources(relativePath)));
    } else if (/\.(?:mjs|js|ts|ya?ml)$/.test(entry.name)) {
      sources.push(relativePath);
    }
  }
  return sources;
}

test('retired balance improvement issue has no automated creation path', async () => {
  const sources = [
    ...(await automationSources('.github/actions')),
    ...(await automationSources('.github/workflows')),
    ...(await automationSources('.github/scripts')),
  ];
  const offenders = [];
  for (const relativePath of sources) {
    const source = await readFile(path.join(REPO_ROOT, relativePath), 'utf8');
    if (source.includes(RETIRED_ISSUE_TITLE)) offenders.push(relativePath);
  }

  assert.deepEqual(
    offenders,
    [],
    `Remove the retired recurring issue title from automated code: ${offenders.join(', ')}`,
  );
});

test('release baseline collection remains published without the retired issue filer', async () => {
  const deploy = await readFile(path.join(REPO_ROOT, '.github/workflows/deploy.yml'), 'utf8');
  assert.match(deploy, /npx tsx scripts\/agent\/perf\/release-baseline\.ts/);
  assert.match(deploy, /name: Publish to baselines branch/);
  assert.doesNotMatch(deploy, /nightly-balance-issue/);
});
