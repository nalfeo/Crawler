import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyDocsUpdatePayload, isDocsPath } from './docs-update-payload-gate.mjs';

const LANDED = 'chore: land something\n\nMerge-Train-PR: 2901\nMerge-Train-Original-Head: abc123';

function classify(overrides = {}) {
  return classifyDocsUpdatePayload({
    conclusion: 'success',
    event: 'push',
    commitMessage: LANDED,
    changedFiles: ['src/core/foo.ts'],
    ...overrides,
  });
}

describe('classifyDocsUpdatePayload', () => {
  const cases = [
    { name: 'non-doc merge-train landing runs', overrides: {}, run: true },
    {
      name: 'docs-only landing is skipped',
      overrides: { changedFiles: ['docs/a.md', 'AGENTS.md', '.specify/specs/b.md', 'notes.txt'] },
      run: false,
    },
    {
      name: 'src markdown is not docs',
      overrides: { changedFiles: ['src/shared/data/README.md'] },
      run: true,
    },
    {
      name: 'cross-surface rename pair runs',
      overrides: { changedFiles: ['src/core/foo.ts', 'docs/foo.md'] },
      run: true,
    },
    { name: 'failed merge-train run is skipped', overrides: { conclusion: 'failure' }, run: false },
    {
      name: 'cancelled merge-train run is skipped',
      overrides: { conclusion: 'cancelled' },
      run: false,
    },
    { name: 'scheduled merge-train run is skipped', overrides: { event: 'schedule' }, run: false },
    {
      name: 'wake-up workflow_run merge-train run is skipped',
      overrides: { event: 'workflow_run' },
      run: false,
    },
    {
      name: 'raw main push without the promotion trailer is skipped',
      overrides: { commitMessage: 'fix: direct push to main' },
      run: false,
    },
    {
      name: 'a mention of the trailer inside prose does not count',
      overrides: { commitMessage: 'fix: mentions Merge-Train-PR: 12 inline' },
      run: false,
    },
    { name: 'empty payload is skipped', overrides: { changedFiles: [] }, run: false },
    {
      name: 'blank-only payload lines are skipped',
      overrides: { changedFiles: ['', '   '] },
      run: false,
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      assert.equal(classify(testCase.overrides).run, testCase.run);
    });
  }

  it('always explains its decision', () => {
    assert.match(classify().reason, /\S/);
    assert.match(classify({ conclusion: 'failure' }).reason, /\S/);
  });
});

describe('isDocsPath', () => {
  it('matches the detect-art-only.sh docs_only surface', () => {
    for (const file of ['docs/a.md', '.specify/specs/x.md', 'AGENTS.md', 'a/b.md', 'a/b.txt']) {
      assert.equal(isDocsPath(file), true, file);
    }
    for (const file of [
      'src/core/foo.ts',
      'src/shared/data/README.md',
      'src/notes.txt',
      '.github/workflows/docs-update.yml',
      'package.json',
    ]) {
      assert.equal(isDocsPath(file), false, file);
    }
  });
});
