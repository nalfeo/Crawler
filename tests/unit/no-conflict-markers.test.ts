import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../..');

/**
 * Guard against unresolved merge-conflict markers reaching a commit.
 *
 * This is not hypothetical tidiness. The repo's pre-commit hook performs a stash
 * dance that has TWICE injected conflict markers into files it was never asked
 * to touch, and both times the corruption landed on `main` unnoticed:
 *
 *   - `docs/knowledge/handoffs/2026-07-26-stone-floor-art-wave.md` (8 blocks)
 *   - `docs/knowledge/handoffs/2026-07-25-welcome-room-floor-decals.md` (2 blocks)
 *
 * Nothing caught it. Prettier happily reformats a conflicted markdown file —
 * it even rewrites `>>>>>>> Stashed changes` into a `> > > > > > >` blockquote,
 * which is why the second corruption swallowed a sentence of real prose and
 * still passed `prettier --check`. Lint does not scan markdown. Tests do not
 * read handoffs. The corruption was only ever found by a human reading the file.
 *
 * Hence a deterministic check, per the repo's "promote a recurring bug class
 * into a deterministic check" rule. It is a `git grep` over tracked files, so it
 * costs milliseconds and can never drift out of sync with what is committed.
 *
 * The blockquote-mangled form is matched explicitly: by the time Prettier has
 * run, `>>>>>>>` no longer looks like a conflict marker, so a naive search for
 * seven angle brackets finds nothing and reports a false all-clear.
 */
describe('no unresolved merge-conflict markers', () => {
  it('finds none in tracked files', () => {
    // `-I` skips binary files; `-n` gives line numbers for an actionable failure.
    const result = spawnSync(
      'git',
      [
        'grep',
        '-I',
        '-n',
        '-E',
        '^\\s*(<<<<<<<|>>>>>>>|(> ){7})\\s*(Updated upstream|Stashed changes|[A-Za-z0-9_./-]+)?\\s*$',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );

    // git grep exits 1 when there are no matches, which is the success case.
    // Anything above 1 is a real failure (not a repo, git missing, etc.).
    expect(result.error).toBeUndefined();
    expect(result.status, `git grep failed: ${result.stderr}`).toBeLessThanOrEqual(1);

    const hits = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      // This file necessarily contains the marker patterns in its own regex and
      // docstring. Excluding it by path is safe: it cannot mask a conflict in
      // any other file, and a conflict inside this file would break the parse.
      .filter((line) => !line.startsWith('tests/unit/no-conflict-markers.test.ts'));

    expect(
      hits,
      'unresolved merge-conflict markers found — resolve them, do not delete the check',
    ).toEqual([]);
  });
});
