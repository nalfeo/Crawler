/**
 * Unit tests for the reusable fs YAML reader, using a throwaway temp fixture tree
 * (no dependency on the repo's real plans/ or briefs/).
 *
 * Moved from the now-removed standalone Sprite Review canvas — Workflow has its
 * own copy of `lib/yaml-reader.mjs` (identical contract).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  listArtPlans,
  listBriefs,
  readYaml,
  loadArtPlans,
  loadBriefs,
  DEFAULT_REPO_ROOT,
} from '../lib/yaml-reader.mjs';

let root;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'workflow-yaml-'));
  mkdirSync(path.join(root, 'plans', 'nested'), { recursive: true });
  mkdirSync(path.join(root, 'briefs'), { recursive: true });
  writeFileSync(path.join(root, 'plans', 'goblin.art.yaml'), 'id: goblin\nsprites:\n  - idle\n');
  writeFileSync(path.join(root, 'plans', 'nested', 'rat.art.yaml'), 'id: rat\n');
  writeFileSync(path.join(root, 'plans', 'notes.txt'), 'ignore me');
  writeFileSync(path.join(root, 'briefs', 'goblin.yaml'), 'concept: goblin\n');
  writeFileSync(path.join(root, 'briefs', 'legacy.yml'), 'concept: legacy\n');
  // A .art.yaml under briefs/ must be excluded (it is a plan, not a brief).
  writeFileSync(path.join(root, 'briefs', 'skip.art.yaml'), 'id: skip\n');
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

test('DEFAULT_REPO_ROOT resolves to the repo root (contains package.json path shape)', () => {
  assert.ok(DEFAULT_REPO_ROOT.length > 0);
  assert.ok(path.isAbsolute(DEFAULT_REPO_ROOT));
});

test('listArtPlans finds *.art.yaml recursively and derives ids', () => {
  const plans = listArtPlans({ repoRoot: root });
  const ids = plans.map((p) => p.id).sort();
  assert.deepEqual(ids, ['goblin', 'rat']);
  const goblin = plans.find((p) => p.id === 'goblin');
  assert.equal(goblin.relPath, 'plans/goblin.art.yaml');
});

test('listBriefs finds .yaml/.yml but excludes *.art.yaml', () => {
  const briefs = listBriefs({ repoRoot: root });
  const ids = briefs.map((b) => b.id).sort();
  assert.deepEqual(ids, ['goblin', 'legacy']);
});

test('readYaml parses valid YAML and returns null on error', () => {
  const parsed = readYaml(path.join(root, 'briefs', 'goblin.yaml'));
  assert.deepEqual(parsed, { concept: 'goblin' });
  assert.equal(readYaml(path.join(root, 'briefs', 'does-not-exist.yaml')), null);
});

test('loadArtPlans / loadBriefs attach parsed data', () => {
  const plans = loadArtPlans({ repoRoot: root });
  const goblin = plans.find((p) => p.id === 'goblin');
  assert.deepEqual(goblin.data, { id: 'goblin', sprites: ['idle'] });

  const briefs = loadBriefs({ repoRoot: root });
  const legacy = briefs.find((b) => b.id === 'legacy');
  assert.deepEqual(legacy.data, { concept: 'legacy' });
});

test('listArtPlans returns [] for a repo root with no plans dir', () => {
  const empty = mkdtempSync(path.join(tmpdir(), 'workflow-yaml-empty-'));
  try {
    assert.deepEqual(listArtPlans({ repoRoot: empty }), []);
    assert.deepEqual(listBriefs({ repoRoot: empty }), []);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
