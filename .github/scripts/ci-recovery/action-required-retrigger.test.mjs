/**
 * Unit tests for the action_required retrigger helpers.
 *
 * Lives beside the module under test as ESM rather than in tests/unit as
 * TypeScript: the CI-recovery scripts are untyped `.mjs`, so importing them from
 * a TS test file fails `noImplicitAny` (TS7016). `.github/scripts/ci-recovery/
 * *.test.mjs` is already wired into `npm run test:guards`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyParkedRun, pushEmptyCommit } from './action-required-retrigger.mjs';

const baseRun = {
  id: 123,
  conclusion: 'action_required',
  event: 'pull_request',
  path: '.github/workflows/ci.yml',
  head_sha: 'abc',
};

const basePull = {
  state: 'open',
  head: { repo: { full_name: 'nalfeo/Crawler' }, sha: 'abc' },
};

describe('action-required retrigger classification', () => {
  it('accepts latest parked required same-repo PR workflow runs', () => {
    assert.equal(
      classifyParkedRun({
        run: baseRun,
        pull: basePull,
        latestRun: baseRun,
        repository: 'nalfeo/Crawler',
      }),
      null,
    );
  });

  it('accepts latest cancelled required same-repo PR workflow runs', () => {
    assert.equal(
      classifyParkedRun({
        run: { ...baseRun, conclusion: 'cancelled' },
        pull: basePull,
        latestRun: { ...baseRun, conclusion: 'cancelled' },
        repository: 'nalfeo/Crawler',
      }),
      null,
    );
  });

  it('rejects stale parked runs after a newer run exists', () => {
    assert.equal(
      classifyParkedRun({
        run: baseRun,
        pull: basePull,
        latestRun: { ...baseRun, id: 124 },
        repository: 'nalfeo/Crawler',
      }),
      'stale-run',
    );
  });

  it('rejects non-required workflows and moved PR heads', () => {
    assert.equal(
      classifyParkedRun({
        run: { ...baseRun, path: '.github/workflows/merge-train.yml' },
        pull: basePull,
        latestRun: { ...baseRun, path: '.github/workflows/merge-train.yml' },
        repository: 'nalfeo/Crawler',
      }),
      'workflow-not-required',
    );
    assert.equal(
      classifyParkedRun({
        run: baseRun,
        pull: { ...basePull, head: { ...basePull.head, sha: 'def' } },
        latestRun: baseRun,
        repository: 'nalfeo/Crawler',
      }),
      'head-moved',
    );
  });
});

describe('pushEmptyCommit', () => {
  it('fetches the validated sha and pushes with a force-with-lease bound to it', () => {
    const calls = [];
    const result = pushEmptyCommit(
      {
        number: 42,
        head: {
          ref: 'feature/retrigger',
          sha: 'a'.repeat(40),
          repo: { full_name: 'nalfeo/Crawler' },
        },
      },
      {
        owner: 'nalfeo',
        repo: 'Crawler',
        retriggerPat: 'test-token',
        git: (args) => {
          calls.push(args);
          return '';
        },
      },
    );

    assert.equal(result, 'pushed');
    assert.deepEqual(
      calls.find((args) => args[0] === 'fetch'),
      ['fetch', 'origin', 'a'.repeat(40)],
    );
    assert.deepEqual(
      calls.find((args) => args[0] === 'push'),
      [
        'push',
        `--force-with-lease=refs/heads/feature/retrigger:${'a'.repeat(40)}`,
        'origin',
        'HEAD:refs/heads/feature/retrigger',
      ],
    );
  });

  it('treats force-with-lease drift as a safe skip', () => {
    const result = pushEmptyCommit(
      {
        number: 42,
        head: {
          ref: 'feature/retrigger',
          sha: 'b'.repeat(40),
          repo: { full_name: 'nalfeo/Crawler' },
        },
      },
      {
        owner: 'nalfeo',
        repo: 'Crawler',
        retriggerPat: 'test-token',
        git: (args) => {
          if (args[0] === 'push') {
            const error = new Error('stale info');
            error.stderr = 'stale info';
            throw error;
          }
          return '';
        },
      },
    );

    assert.equal(result, 'lease-miss');
  });
});
