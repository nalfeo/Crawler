import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACK_TRAILER,
  type FileTriple,
  dedupeByPath,
  findSilentReverts,
  findUnusedAcks,
  generatedEntryRenamePreservesContent,
  isDiscarded,
  parseAckTrailers,
  parseDiffLineChanges,
  sideAdditionsSubsumedByOther,
  survivesToHead,
} from '../../scripts/agent/health/silent-reverts-lib.js';

/**
 * Regression coverage for the silent-merge-revert guard (issue #2282).
 *
 * The bug class: a merge commit resolves a conflict by keeping one side
 * wholesale, so changes the other side made vanish with NO diff hunk anyone
 * reviews and NO future conflict, because git records the discarded commit as
 * an ancestor. It has already cost one manual recovery session
 * (`2026-07-29-pr2022-main-merge-silent-revert-recovery`).
 *
 * The single most important test here is `-s ours` with BOTH sides editing the
 * file. An earlier draft of this guard used the predicate
 * `side !== base && result === base`, which detects reset-to-ancestor but NOT
 * took-our-side: after `-s ours` the result equals OUR blob, which only equals
 * the base when our side happened not to touch the file too. That draft was
 * proven to MISS the exact `boss-abilities` incident it was written for. The
 * `result === other` arm is the fix, and `discards a change the other side
 * made even when BOTH sides edited the file` is its non-tautological pin —
 * reverting the predicate turns that test red while every other test stays
 * green.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const guard = path.join(repoRoot, 'scripts', 'agent', 'health', 'silent-reverts.ts');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function triple(over: Partial<FileTriple> = {}): FileTriple {
  return { path: 'f.json', base: 'B', side: 'B', other: 'B', result: 'B', head: 'B', ...over };
}

describe('isDiscarded', () => {
  it('ignores a file the incoming side never changed', () => {
    expect(isDiscarded(triple({ side: 'B', result: 'X' }))).toBe(false);
  });

  it('ignores a merge that kept the incoming version', () => {
    expect(isDiscarded(triple({ side: 'S', result: 'S' }))).toBe(false);
  });

  it('detects a reset back to the merge base', () => {
    expect(isDiscarded(triple({ side: 'S', other: 'B', result: 'B' }))).toBe(true);
  });

  it('detects taking the opposing side wholesale when BOTH sides edited it', () => {
    // The `-s ours` shape. result === other, and result !== base because our
    // side edited the file too. The base-only predicate returns false here.
    expect(isDiscarded(triple({ base: 'B', side: 'S', other: 'O', result: 'O' }))).toBe(true);
  });

  it('does not flag taking the opposing blob when it already contains the incoming change', () => {
    expect(
      isDiscarded(
        triple({
          base: 'B',
          side: 'S',
          other: 'O',
          result: 'O',
          sideAlreadyPresentInOther: true,
        }),
      ),
    ).toBe(false);
  });

  it('detects a discarded deletion', () => {
    expect(isDiscarded(triple({ base: 'B', side: null, other: 'B', result: 'B' }))).toBe(true);
  });

  it('detects a discarded file addition', () => {
    expect(isDiscarded(triple({ base: null, side: 'S', other: null, result: null }))).toBe(true);
  });

  it('does not flag a genuine third resolution', () => {
    // A hand-merged result that matches neither parent is a real, reviewable
    // change — not a silent discard.
    expect(isDiscarded(triple({ base: 'B', side: 'S', other: 'O', result: 'MERGED' }))).toBe(false);
  });
});

describe('survivesToHead', () => {
  it('survives when nothing touched the file after the merge', () => {
    expect(survivesToHead(triple({ result: 'B', head: 'B' }))).toBe(true);
  });

  it('is superseded when a later commit rewrote the file', () => {
    // Then the change IS visible in the PR diff, so it is reviewable and not
    // silent. Reporting it would be noise.
    expect(survivesToHead(triple({ result: 'B', head: 'LATER' }))).toBe(false);
  });

  it('is superseded when the incoming content survives at a renamed path', () => {
    expect(
      survivesToHead(
        triple({ result: null, head: null, side: 'S', sideContentPreservedAtHead: true }),
      ),
    ).toBe(false);
  });

  it('survives an `-s ours` discard, where the surviving blob is ours not the base', () => {
    expect(survivesToHead(triple({ base: 'B', result: 'O', head: 'O' }))).toBe(true);
  });

  describe('generatedEntryRenamePreservesContent', () => {
    const entry = {
      briefId: 'legacy-v1',
      spriteName: 'legacy-v1-var-0',
      assetPath: 'generated/legacy-v1-var-0.png',
      variantIndex: 0,
      sourceRun: 'generated/runs/legacy/imported-abc',
      contentHash: 'abc',
      anchor: { x: 1, y: 2 },
    };

    it('accepts generated-entry renames that change identity fields only', () => {
      const target = {
        ...entry,
        briefId: 'canonical',
        spriteName: 'canonical-var-7',
        assetPath: 'generated/canonical-var-7.png',
        variantIndex: 7,
      };
      expect(
        generatedEntryRenamePreservesContent(
          'public/assets/generated/entries/legacy-v1-var-0.json',
          'public/assets/generated/entries/canonical-var-7.json',
          JSON.stringify(entry),
          JSON.stringify(target),
        ),
      ).toBe(true);
    });

    it('rejects a rename that changes substantive metadata', () => {
      const target = { ...entry, sourceRun: 'generated/runs/other/imported-def' };
      expect(
        generatedEntryRenamePreservesContent(
          'public/assets/generated/entries/legacy-v1-var-0.json',
          'public/assets/generated/entries/canonical-var-0.json',
          JSON.stringify(entry),
          JSON.stringify(target),
        ),
      ).toBe(false);
    });

    it('ignores JSON object key order when comparing substantive metadata', () => {
      const reordered = {
        anchor: { y: 2, x: 1 },
        contentHash: 'abc',
        sourceRun: 'generated/runs/legacy/imported-abc',
        variantIndex: 0,
        assetPath: 'generated/canonical-var-0.png',
        spriteName: 'canonical-var-0',
        briefId: 'canonical',
      };
      expect(
        generatedEntryRenamePreservesContent(
          'public/assets/generated/entries/legacy-v1-var-0.json',
          'public/assets/generated/entries/canonical-var-0.json',
          JSON.stringify(entry),
          JSON.stringify(reordered),
        ),
      ).toBe(true);
    });
  });
});

describe('parseDiffLineChanges', () => {
  it('splits added and removed lines, excluding file headers', () => {
    const diff = [
      '--- a/f.md',
      '+++ b/f.md',
      '@@ -1,2 +1,2 @@',
      '-old line',
      '+new line',
      ' context line',
    ].join('\n');
    expect(parseDiffLineChanges(diff)).toEqual({
      added: ['new line'],
      removed: ['old line'],
    });
  });

  it('returns empty arrays for a diff with no content changes', () => {
    expect(parseDiffLineChanges('')).toEqual({ added: [], removed: [] });
  });

  it('does not mistake a content line starting with -- or ++ for a diff file header', () => {
    const diff = [
      '--- a/f.md',
      '+++ b/f.md',
      '@@ -1 +1 @@',
      '-old --no-color',
      '+new ++verbose',
    ].join('\n');
    expect(parseDiffLineChanges(diff)).toEqual({
      added: ['new ++verbose'],
      removed: ['old --no-color'],
    });
  });
});

describe('sideAdditionsSubsumedByOther', () => {
  it('is false when the side added nothing', () => {
    expect(sideAdditionsSubsumedByOther([], [], ['+row'])).toBe(false);
  });

  it('is false when the side removed a line, even if additions match', () => {
    expect(sideAdditionsSubsumedByOther(['row'], ['old row'], ['row'])).toBe(false);
  });

  it('is false when the added line is missing from the other side', () => {
    expect(sideAdditionsSubsumedByOther(['row a'], [], ['row b'])).toBe(false);
  });

  it('is true when every added line reappears verbatim in the other side', () => {
    expect(sideAdditionsSubsumedByOther(['row a', 'row b'], [], ['row b', 'row a', 'row c'])).toBe(
      true,
    );
  });

  it('ignores whitespace-run differences from markdown table re-justification', () => {
    const sideAdded = [
      '| AI headless (tsx loader)  | `npm run ai:headless:tsx`                  |',
    ];
    const otherAdded = [
      '| AI headless (tsx loader)  | `npm run ai:headless:tsx`                                                                                                                   |',
    ];
    expect(sideAdditionsSubsumedByOther(sideAdded, [], otherAdded)).toBe(true);
  });

  it('does not ignore genuine content differences beyond whitespace', () => {
    const sideAdded = ['ai:headless pre-bundles the CLI, which removes ~2.7s of startup.'];
    const otherAdded = ['The headless and sweep CLIs pre-bundle, which removes the fixed startup.'];
    expect(sideAdditionsSubsumedByOther(sideAdded, [], otherAdded)).toBe(false);
  });
});

describe('parseAckTrailers', () => {
  it('parses a single path', () => {
    expect([...parseAckTrailers(`x\n\n${ACK_TRAILER}: a/b.json`)]).toEqual(['a/b.json']);
  });

  it('parses comma-separated paths and ignores the reason suffix', () => {
    const acked = parseAckTrailers(`${ACK_TRAILER}: a.json, b.json -- superseded by #123`);
    expect([...acked].sort()).toEqual(['a.json', 'b.json']);
  });

  it('ignores unrelated trailers', () => {
    expect(parseAckTrailers('Co-authored-by: x\nSigned-off-by: y').size).toBe(0);
  });

  it('does not treat a body mention as a trailer — only the final trailer block counts', () => {
    // A commit message that documents or quotes the ack format in prose must
    // not suppress a real finding. The last paragraph here is "Co-authored-by: x"
    // (a real trailer, not an ack), so the body line is never reached.
    const msg = [
      'feat: update merge strategy',
      '',
      `To acknowledge use ${ACK_TRAILER}: path/to/file in the merge message.`,
      '',
      'Co-authored-by: x',
    ].join('\n');
    expect(parseAckTrailers(msg).size).toBe(0);
  });

  it('does not treat a mixed body paragraph as a trailer block', () => {
    // The last paragraph mixes prose and a trailer-looking line; since not all
    // lines match the trailer regex, the whole paragraph is body text.
    const msg = ['feat: subject', '', 'Some body prose.', `${ACK_TRAILER}: a.json`].join('\n');
    expect(parseAckTrailers(msg).size).toBe(0);
  });
});

describe('findSilentReverts', () => {
  const merge = (over: Partial<Parameters<typeof findSilentReverts>[0][number]> = {}) => ({
    sha: 'deadbeef',
    subject: 'Merge main',
    sideRef: 'aaaaaaa',
    sideIsMainline: true,
    ackedPaths: new Set<string>(),
    files: [triple({ side: 'S', other: 'B', result: 'B', head: 'B' })],
    ...over,
  });

  it('reports a surviving mainline discard as an error', () => {
    expect(findSilentReverts([merge()])).toEqual([
      expect.objectContaining({ path: 'f.json', severity: 'error' }),
    ]);
  });

  it('downgrades a branch-local discard to a warning', () => {
    expect(findSilentReverts([merge({ sideIsMainline: false })])[0]?.severity).toBe('warn');
  });

  it('suppresses an acked path', () => {
    expect(findSilentReverts([merge({ ackedPaths: new Set(['f.json']) })])).toEqual([]);
  });

  it('suppresses a discard that a later commit superseded', () => {
    const files = [triple({ side: 'S', other: 'B', result: 'B', head: 'LATER' })];
    expect(findSilentReverts([merge({ files })])).toEqual([]);
  });

  it('requires agreement across every candidate base in criss-cross history', () => {
    // Same (merge, side, path) judged against two bases; only one says discard.
    // Reporting it would mean the verdict hinged on an arbitrary base choice.
    const discarding = merge({ baseCount: 2 });
    const notDiscarding = merge({
      baseCount: 2,
      files: [triple({ base: 'S', side: 'S', other: 'B', result: 'B', head: 'B' })],
    });
    expect(findSilentReverts([discarding, notDiscarding])).toEqual([]);
  });

  it('reports a discard that holds under every candidate base', () => {
    const first = merge({ baseCount: 2 });
    const second = merge({
      baseCount: 2,
      files: [triple({ base: 'B2', side: 'S', other: 'B', result: 'B', head: 'B' })],
    });
    expect(findSilentReverts([first, second])).toHaveLength(1);
  });
});

describe('dedupeByPath', () => {
  const base = { mergeSubject: 's', sideRef: 'a', severity: 'error' as const };

  it('keeps the newest merge and counts the rest', () => {
    const out = dedupeByPath([
      { ...base, mergeSha: 'newest', path: 'f.json' },
      { ...base, mergeSha: 'older', path: 'f.json' },
      { ...base, mergeSha: 'oldest', path: 'f.json' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.mergeSha).toBe('newest');
    expect(out[0]?.mergeCount).toBe(3);
    // All SHAs must be listed so remediation can tell the user which commits
    // need an acknowledgement trailer — not only the most recent one.
    expect(out[0]?.allMergeShas).toEqual(['newest', 'older', 'oldest']);
  });

  it('promotes a mainline loss over a branch-local one for the same path', () => {
    const out = dedupeByPath([
      { ...base, severity: 'warn', mergeSha: 'newest', path: 'f.json' },
      { ...base, severity: 'error', mergeSha: 'older', path: 'f.json' },
    ]);
    expect(out[0]?.severity).toBe('error');
  });

  it('keeps distinct paths separate', () => {
    const out = dedupeByPath([
      { ...base, mergeSha: 'm', path: 'a.json' },
      { ...base, mergeSha: 'm', path: 'b.json' },
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('findUnusedAcks', () => {
  it('flags an ack that matched no discard', () => {
    const merges = [
      {
        sha: 'deadbeef',
        subject: 's',
        sideRef: 'a',
        sideIsMainline: true,
        ackedPaths: new Set(['ghost.json']),
        files: [triple()],
      },
    ];
    expect(findUnusedAcks(merges)).toEqual([{ mergeSha: 'deadbeef', path: 'ghost.json' }]);
  });

  it('accepts an ack that matched a real discard', () => {
    const merges = [
      {
        sha: 'deadbeef',
        subject: 's',
        sideRef: 'a',
        sideIsMainline: true,
        ackedPaths: new Set(['f.json']),
        files: [triple({ side: 'S', other: 'B', result: 'B' })],
      },
    ];
    expect(findUnusedAcks(merges)).toEqual([]);
  });

  it('accepts an ack matched on the OTHER side of the same merge', () => {
    // collectMergeInputs emits one entry per parent, and the ack lives on the
    // merge commit rather than on a side. Checking sides independently marked
    // every legitimate ack unused, which would have made acks unusable.
    const common = { sha: 'deadbeef', subject: 's', sideIsMainline: true };
    const merges = [
      {
        ...common,
        sideRef: 'a',
        ackedPaths: new Set(['f.json']),
        files: [triple({ side: 'S', other: 'B', result: 'B' })], // discarded here
      },
      {
        ...common,
        sideRef: 'b',
        ackedPaths: new Set(['f.json']),
        files: [triple({ side: 'B', other: 'S', result: 'B' })], // not discarded here
      },
    ];
    expect(findUnusedAcks(merges)).toEqual([]);
  });
});

/**
 * End-to-end against REAL git. The unit tests above pin the predicate, but the
 * predicate is only as good as the blobs fed to it, and every hard-won bug in
 * this guard has been in the plumbing (which parent is `other`, what a merge
 * base is after the merge already landed, deletions as null blobs). These run
 * the actual CLI over purpose-built histories.
 */
describe('silent-reverts CLI (real git)', () => {
  interface RunResult {
    readonly status: number;
    readonly output: string;
  }

  function runGuard(dir: string, baseRef: string): RunResult {
    try {
      const output = execFileSync(process.execPath, [tsxCli, guard], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: 'pipe',
        env: {
          ...process.env,
          SILENT_REVERT_REPO: dir,
          SILENT_REVERT_BASE_REF: baseRef,
          SILENT_REVERT_HEAD_REF: 'HEAD',
        },
      });
      return { status: 0, output };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? -1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  }

  function makeRepo(): {
    dir: string;
    git: (...a: string[]) => string;
    write: (f: string, c: string) => void;
  } {
    const dir = mkdtempSync(path.join(tmpdir(), 'silent-reverts-'));
    const git = (...a: string[]): string =>
      execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
    const write = (f: string, c: string): void => {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      writeFileSync(path.join(dir, f), c);
    };
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'guard@test.local');
    git('config', 'user.name', 'Guard Test');
    git('config', 'commit.gpgsign', 'false');
    return { dir, git, write };
  }

  /** A just-exited git child can hold the dir briefly on Windows. */
  function cleanup(dir: string): void {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* best effort: OS temp dir */
    }
  }

  /**
   * Builds the exact #2010/#2022 shape: a shared coordination ledger where main
   * flips one row and the PR edits a DIFFERENT row, reconciled with `-s ours`.
   */
  function buildOursScenario(): { dir: string; git: (...a: string[]) => string } {
    const { dir, git, write } = makeRepo();
    write('ledger.json', '{"don-paco":"not-started","mine":"x"}\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');

    write('ledger.json', '{"don-paco":"verified","mine":"x"}\n');
    git('commit', '-qam', 'main: don-paco verified');
    const mainSha = git('rev-parse', 'HEAD');
    git('branch', '-f', 'mainline', mainSha);

    git('checkout', '-q', '-b', 'pr', base);
    write('ledger.json', '{"don-paco":"not-started","mine":"MINE"}\n');
    git('commit', '-qam', 'pr: my ability');
    git('merge', '-s', 'ours', '--no-edit', mainSha);
    return { dir, git };
  }

  it('detects `-s ours` discarding mainline work when both sides edited the file', () => {
    const { dir, git } = buildOursScenario();
    try {
      // Precondition: main's value really is gone from the merged tree.
      expect(git('show', 'HEAD:ledger.json')).toContain('"don-paco":"not-started"');

      const { status, output } = runGuard(dir, 'mainline');
      expect(output).toContain('ledger.json');
      expect(output).toContain('[ERROR]');
      expect(status).toBe(1);
    } finally {
      cleanup(dir);
    }
  });

  /**
   * Third-branch shape: the PR merges a COLLEAGUE branch (never merged to main)
   * that had itself merged main's TIP, so it contains all of main. Discarding it
   * with `-s ours` loses mainline content even though that parent is not an
   * ancestor of main. Grading on ancestry-of-side alone graded this `warn`, so
   * CI exited 0 on a genuine mainline revert (verified by repro before the fix).
   *
   * ISOLATION: feature-x edits shared.ts AFTER merging main, so its blob differs
   * from main's current blob and the content rule (`mainBlob === side`) cannot
   * fire. Ancestry clause (b) — "main is reachable FROM side" — is therefore the
   * only path to `error`. Without that separating edit this test passed with
   * clause (b) reverted (i.e. it was tautological, caught by mutation testing).
   */
  it('grades a mainline loss arriving via a non-mainline parent as blocking', () => {
    const { dir, git, write } = makeRepo();
    try {
      write('shared.ts', 'export const V = 1;\n');
      git('add', '.');
      git('commit', '-qm', 'base');
      const base = git('rev-parse', 'HEAD');

      write('shared.ts', 'export const V = 2; // MAIN CRITICAL FIX\n');
      git('commit', '-qam', 'main: critical fix');
      git('branch', '-f', 'mainline', git('rev-parse', 'HEAD'));

      // Colleague forks from base, merges main's TIP -> contains all of main.
      git('checkout', '-q', '-b', 'feature-x', base);
      write('other.ts', 'export const X = 1;\n');
      git('add', '.');
      git('commit', '-qm', 'feature-x work');
      git('merge', '--no-edit', '-q', 'mainline');
      // ...then edits the file on top, so side !== main's current blob.
      write('shared.ts', 'export const V = 3; // MAIN CRITICAL FIX + fx tweak\n');
      git('commit', '-qam', 'feature-x: build on the fix');

      // PR forks from base, edits the same file, discards feature-x wholesale.
      git('checkout', '-q', '-b', 'pr', base);
      write('shared.ts', 'export const V = 1; // pr tweak\n');
      git('commit', '-qam', 'pr: tweak shared');
      git('merge', '-s', 'ours', '--no-edit', '-q', 'feature-x');

      // feature-x is NOT on main (so clause (a) cannot fire)...
      expect(() => git('merge-base', '--is-ancestor', 'feature-x', 'mainline')).toThrow();
      // ...but it CONTAINS main, which is exactly what clause (b) detects.
      expect(() => git('merge-base', '--is-ancestor', 'mainline', 'feature-x')).not.toThrow();
      // The content rule cannot fire: side's blob differs from main's current one.
      expect(git('show', 'feature-x:shared.ts')).not.toBe(git('show', 'mainline:shared.ts'));
      // And main's fix really is gone from the merged tree.
      expect(git('show', 'HEAD:shared.ts')).not.toContain('MAIN CRITICAL FIX');

      const { status, output } = runGuard(dir, 'mainline');
      expect(output).toMatch(/\[ERROR][^\n]*shared\.ts/);
      expect(status).toBe(1);
    } finally {
      cleanup(dir);
    }
  });

  /**
   * Older-main-tip shape: the colleague branch merged M1, then main advanced to
   * M2 in an UNRELATED file — so M1's content is still current on main, yet the
   * colleague tip is neither an ancestor nor a descendant of main. No ancestry
   * test can see this; only content grading can. Verified by repro: before the
   * content rule this graded `warn` and exited 0 while main still held the fix.
   */
  it('grades a discard of still-current main content as blocking via content, not ancestry', () => {
    const { dir, git, write } = makeRepo();
    try {
      write('shared.ts', 'export const V = 1;\n');
      write('unrelated.ts', 'a\n');
      git('add', '.');
      git('commit', '-qm', 'base');
      const base = git('rev-parse', 'HEAD');

      write('shared.ts', 'export const V = 2; // M1 FIX\n');
      git('commit', '-qam', 'main: M1 fix');
      const m1 = git('rev-parse', 'HEAD');
      // Main advances in an UNRELATED file, so M1's shared.ts is still current.
      write('unrelated.ts', 'b\n');
      git('commit', '-qam', 'main: M2 unrelated');
      git('branch', '-f', 'mainline', git('rev-parse', 'HEAD'));

      git('checkout', '-q', '-b', 'feature-x', base);
      write('other.ts', 'x\n');
      git('add', '.');
      git('commit', '-qm', 'feature-x work');
      git('merge', '--no-edit', '-q', m1);

      git('checkout', '-q', '-b', 'pr', base);
      write('mine.ts', 'm\n');
      git('add', '.');
      git('commit', '-qm', 'pr work');
      git('merge', '-s', 'ours', '--no-edit', '-q', 'feature-x');

      // Neither ancestry direction holds — this is the point of the fixture.
      expect(() => git('merge-base', '--is-ancestor', 'feature-x', 'mainline')).toThrow();
      expect(() => git('merge-base', '--is-ancestor', 'mainline', 'feature-x')).toThrow();
      // Main still holds the fix the PR threw away.
      expect(git('show', 'mainline:shared.ts')).toContain('M1 FIX');
      expect(git('show', 'HEAD:shared.ts')).not.toContain('M1 FIX');

      const { status, output } = runGuard(dir, 'mainline');
      expect(status).toBe(1);
      // Precision: the still-current main content blocks...
      expect(output).toMatch(/\[ERROR][^\n]*shared\.ts/);
      // ...while genuinely branch-local work stays a non-blocking warning.
      expect(output).toMatch(/\[WARN][^\n]*other\.ts/);
    } finally {
      cleanup(dir);
    }
  });

  /**
   * Mainline DELETION discarded, with ancestry deliberately broken in BOTH
   * directions so only content grading can fire. main deletes the file at M1
   * then advances unrelated to M2; the colleague merged M1 only, so it is
   * neither an ancestor nor a descendant of current main. Here `mainBlob` and
   * `side` are both null — an over-defensive `mainBlob !== null` guard let this
   * genuine loss grade `warn` and exit 0.
   *
   * NOTE: an earlier version of this fixture had the colleague merge main's
   * TIP, which made it a descendant of main — ancestry graded it `error` and
   * the test passed with the content fix reverted (i.e. it was tautological).
   * The unrelated M2 advance is what makes this test actually load-bearing.
   */
  it('grades a discard of a mainline deletion as blocking via content', () => {
    const { dir, git, write } = makeRepo();
    try {
      write('deleted.ts', 'to be deleted\n');
      write('unrelated.ts', 'a\n');
      git('add', '.');
      git('commit', '-qm', 'base');
      const base = git('rev-parse', 'HEAD');

      git('rm', '-q', 'deleted.ts');
      git('commit', '-qm', 'main: delete file');
      const m1 = git('rev-parse', 'HEAD');
      // Main advances elsewhere, so the deletion is still current but the tip
      // is no longer m1 — this is what breaks ancestry in both directions.
      write('unrelated.ts', 'b\n');
      git('commit', '-qam', 'main: unrelated advance');
      git('branch', '-f', 'mainline', git('rev-parse', 'HEAD'));

      git('checkout', '-q', '-b', 'feature-x', base);
      write('fx.ts', 'x\n');
      git('add', '.');
      git('commit', '-qm', 'feature-x work');
      git('merge', '--no-edit', '-q', m1);

      git('checkout', '-q', '-b', 'pr', base);
      write('deleted.ts', 'modified\n');
      git('commit', '-qam', 'pr: modified file instead of deleting');
      git('merge', '-s', 'ours', '--no-edit', '-q', 'feature-x');

      // Ancestry cannot grade this: neither direction holds.
      expect(() => git('merge-base', '--is-ancestor', 'feature-x', 'mainline')).toThrow();
      expect(() => git('merge-base', '--is-ancestor', 'mainline', 'feature-x')).toThrow();
      // Main holds the deletion; the PR resurrected the file.
      expect(git('ls-tree', 'mainline', 'deleted.ts')).toBe('');
      expect(git('show', 'HEAD:deleted.ts')).toContain('modified');

      const { status, output } = runGuard(dir, 'mainline');
      expect(status).toBe(1);
      expect(output).toMatch(/\[ERROR][^\n]*deleted\.ts/);
    } finally {
      cleanup(dir);
    }
  });

  it('accepts the same merge once the discard is acknowledged', () => {
    const { dir, git } = buildOursScenario();
    try {
      git(
        'commit',
        '--amend',
        '-q',
        '-m',
        `Merge main\n\n${ACK_TRAILER}: ledger.json -- intentional`,
      );
      const { status, output } = runGuard(dir, 'mainline');
      expect(output).toContain('no surviving silent reverts');
      expect(status).toBe(0);
    } finally {
      cleanup(dir);
    }
  });

  it('fails on a stale ack that matches no discard', () => {
    const { dir, git } = buildOursScenario();
    try {
      git('commit', '--amend', '-q', '-m', `Merge main\n\n${ACK_TRAILER}: ledger.json, ghost.json`);
      const { status, output } = runGuard(dir, 'mainline');
      expect(output).toContain('ghost.json');
      expect(status).toBe(1);
    } finally {
      cleanup(dir);
    }
  });

  it('stays silent on an ordinary clean merge', () => {
    const { dir, git, write } = makeRepo();
    try {
      write('a.txt', 'a\n');
      write('b.txt', 'b\n');
      git('add', '.');
      git('commit', '-qm', 'base');
      const base = git('rev-parse', 'HEAD');

      write('a.txt', 'a-main\n');
      git('commit', '-qam', 'main edits a');
      const mainSha = git('rev-parse', 'HEAD');
      git('branch', '-f', 'mainline', mainSha);

      git('checkout', '-q', '-b', 'pr', base);
      write('b.txt', 'b-pr\n');
      git('commit', '-qam', 'pr edits b');
      git('merge', '--no-edit', '-q', mainSha);

      const { status, output } = runGuard(dir, 'mainline');
      expect(output).toContain('no surviving silent reverts');
      expect(status).toBe(0);
    } finally {
      cleanup(dir);
    }
  });

  it('does not report a discard that a later commit repaired', () => {
    const { dir, git } = buildOursScenarioWithRepair();
    try {
      expect(git('show', 'HEAD:ledger.json')).toContain('"don-paco":"verified"');
      const { status, output } = runGuard(dir, 'mainline');
      expect(output).toContain('no surviving silent reverts');
      expect(status).toBe(0);
    } finally {
      cleanup(dir);
    }
    function buildOursScenarioWithRepair(): { dir: string; git: (...a: string[]) => string } {
      const built = buildOursScenario();
      writeFileSync(path.join(built.dir, 'ledger.json'), '{"don-paco":"verified","mine":"MINE"}\n');
      built.git('commit', '-qam', 'pr: re-apply main row');
      return built;
    }
  });

  function buildGeneratedEntryRenameScenario(
    preserveIncomingMetadata: boolean,
    canonicalTargetPreexists = false,
  ): {
    dir: string;
    git: (...a: string[]) => string;
  } {
    const { dir, git, write } = makeRepo();
    const legacyPath = 'public/assets/generated/entries/legacy-v1-var-0.json';
    const canonicalPath = 'public/assets/generated/entries/canonical-var-0.json';
    const entry = (sourceRun: string, canonical: boolean): string =>
      `${JSON.stringify(
        {
          briefId: canonical ? 'canonical' : 'legacy-v1',
          spriteName: canonical ? 'canonical-var-0' : 'legacy-v1-var-0',
          assetPath: canonical ? 'generated/canonical-var-0.png' : 'generated/legacy-v1-var-0.png',
          sourceRun,
          variantIndex: 0,
          contentHash: 'abc123',
          anchor: { x: 12, y: 34, source: 'manual' },
        },
        null,
        2,
      )}\n`;

    write(legacyPath, entry('local/temp/run', false));
    if (canonicalTargetPreexists) write(canonicalPath, entry('local/temp/run', true));
    git('add', '.');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');

    write(legacyPath, entry('generated/runs/imported-abc123', false));
    git('commit', '-qam', 'main: make provenance portable');
    const mainSha = git('rev-parse', 'HEAD');
    git('branch', '-f', 'mainline', mainSha);

    git('checkout', '-q', '-b', 'pr', base);
    if (canonicalTargetPreexists) {
      git('rm', '-q', legacyPath);
    } else {
      git('mv', legacyPath, canonicalPath);
      write(canonicalPath, entry('local/temp/run', true));
    }
    git('commit', '-qam', 'pr: canonicalize generated entry');
    git('merge', '-s', 'ours', '--no-edit', '-q', mainSha);

    if (preserveIncomingMetadata) {
      write(canonicalPath, entry('generated/runs/imported-abc123', true));
      git('commit', '-qam', 'pr: preserve incoming provenance at canonical path');
    }
    return { dir, git };
  }

  it('accepts a generated-entry rename that preserves incoming metadata', () => {
    const { dir } = buildGeneratedEntryRenameScenario(true);
    try {
      const { status, output } = runGuard(dir, 'mainline');
      expect(output).toContain('no surviving silent reverts');
      expect(status).toBe(0);
    } finally {
      cleanup(dir);
    }
  });

  it('still blocks a generated-entry rename that drops incoming metadata', () => {
    const { dir } = buildGeneratedEntryRenameScenario(false);
    try {
      const { status, output } = runGuard(dir, 'mainline');
      expect(output).toMatch(/\[ERROR][^\n]*legacy-v1-var-0\.json/);
      expect(status).toBe(1);
    } finally {
      cleanup(dir);
    }
  });

  it('accepts preservation merged into a canonical target that already existed', () => {
    const { dir } = buildGeneratedEntryRenameScenario(true, true);
    try {
      const { status, output } = runGuard(dir, 'mainline');
      expect(output).toContain('no surviving silent reverts');
      expect(status).toBe(0);
    } finally {
      cleanup(dir);
    }
  });

  it('still blocks an identity-field revert when the generated entry was not renamed', () => {
    const { dir, git, write } = makeRepo();
    const entryPath = 'public/assets/generated/entries/stable-var-0.json';
    const entry = (assetPath: string): string =>
      `${JSON.stringify(
        {
          briefId: 'stable',
          spriteName: 'stable-var-0',
          assetPath,
          variantIndex: 0,
          contentHash: 'stable-hash',
          anchor: { x: 1, y: 2 },
        },
        null,
        2,
      )}\n`;
    try {
      write(entryPath, entry('generated/WRONG.png'));
      git('add', '.');
      git('commit', '-qm', 'base');
      const base = git('rev-parse', 'HEAD');

      write(entryPath, entry('generated/stable-var-0.png'));
      git('commit', '-qam', 'main: fix asset path');
      const mainSha = git('rev-parse', 'HEAD');
      git('branch', '-f', 'mainline', mainSha);

      git('checkout', '-q', '-b', 'pr', base);
      write('mine.txt', 'mine\n');
      git('add', '.');
      git('commit', '-qm', 'pr work');
      git('merge', '-s', 'ours', '--no-edit', '-q', mainSha);

      const { status, output } = runGuard(dir, 'mainline');
      expect(output).toMatch(/\[ERROR][^\n]*stable-var-0\.json/);
      expect(status).toBe(1);
    } finally {
      cleanup(dir);
    }
  });

  it('fails closed on an octopus merge rather than skipping it', () => {
    const { dir, git, write } = makeRepo();
    try {
      write('f.txt', 'base\n');
      git('add', '.');
      git('commit', '-qm', 'base');
      const base = git('rev-parse', 'HEAD');

      git('checkout', '-q', '-b', 'x', base);
      write('x.txt', 'x\n');
      git('add', '.');
      git('commit', '-qm', 'x');

      git('checkout', '-q', '-b', 'y', base);
      write('y.txt', 'y\n');
      git('add', '.');
      git('commit', '-qm', 'y');

      git('checkout', '-q', 'main');
      git('branch', '-f', 'mainline', base);
      // --no-ff: without it git fast-forwards to `x` first and produces an
      // ordinary two-parent merge, so the fixture would not exercise octopus.
      git('merge', '--no-edit', '--no-ff', '-q', 'x', 'y');
      expect(git('rev-list', '--parents', '-n', '1', 'HEAD').split(/\s+/).length).toBe(4);

      const { status, output } = runGuard(dir, 'mainline');
      expect(output).toContain('octopus');
      expect(status).toBe(1);
    } finally {
      cleanup(dir);
    }
  });

  it('fails closed when the base ref cannot be resolved', () => {
    const { dir, git, write } = makeRepo();
    try {
      write('f.txt', 'x\n');
      git('add', '.');
      git('commit', '-qm', 'base');
      const { status, output } = runGuard(dir, 'refs/heads/does-not-exist');
      expect(output).toContain('could not be resolved');
      expect(status).toBe(1);
    } finally {
      cleanup(dir);
    }
  });

  /**
   * Unrelated-histories shape: a merge whose parents share no common ancestor
   * (e.g. `--allow-unrelated-histories`). `-s ours` on such a merge silently
   * discards EVERY file from the other side. The guard must fail closed rather
   * than skip, because skipping is the exact hole it exists to close.
   */
  it('fails closed on a merge with no merge base (unrelated histories)', () => {
    const { dir, git, write } = makeRepo();
    try {
      write('file-a.txt', 'from a\n');
      git('add', '.');
      git('commit', '-qm', 'initial');
      git('branch', '-f', 'mainline', 'HEAD');

      // Create a second root commit with no shared ancestor.
      git('checkout', '--orphan', 'orphan');
      git('rm', '-qrf', '.');
      write('file-b.txt', 'from b\n');
      git('add', '.');
      git('commit', '-qm', 'orphan initial');

      git('checkout', '-q', 'main');
      // `-s ours` discards everything from orphan; the guard must flag this.
      git('merge', '--allow-unrelated-histories', '-s', 'ours', '--no-edit', '-q', 'orphan');

      const { status, output } = runGuard(dir, 'mainline');
      expect(output).toContain('no merge base');
      expect(status).toBe(1);
    } finally {
      cleanup(dir);
    }
  });

  /**
   * Provenance shape: the colleague branch merges an OLDER main revision and
   * then EDITS the file further. After main advances in an unrelated file, the
   * colleague tip is neither an ancestor nor a descendant of the mainline tip,
   * and the colleague's blob differs from mainBlob (so the direct-content check
   * cannot fire). Only the provenance check can detect this: the colleague's
   * merge-base with mainline held mainBlob, confirming the colleague built on
   * top of it. Verified by design: without the `sideMainBase` check this shape
   * graded `warn` and CI exited 0.
   */
  it('grades a discard blocking via provenance when colleague built on still-current mainline content', () => {
    const { dir, git, write } = makeRepo();
    try {
      write('shared.ts', 'export const V = 1;\n');
      write('unrelated.ts', 'a\n');
      git('add', '.');
      git('commit', '-qm', 'base');
      const base = git('rev-parse', 'HEAD');

      // M1: add a mainline fix to shared.ts.
      write('shared.ts', 'export const V = 2; // M1 FIX\n');
      git('commit', '-qam', 'main: M1 fix');
      const m1 = git('rev-parse', 'HEAD');
      // M2: advance mainline in an unrelated file, so M1's content is still current.
      write('unrelated.ts', 'b\n');
      git('commit', '-qam', 'main: M2 unrelated');
      git('branch', '-f', 'mainline', git('rev-parse', 'HEAD'));

      // Colleague merges M1 (NOT M2), then edits shared.ts further.
      // After the edit: side !== mainBlob, so direct-content check cannot fire.
      git('checkout', '-q', '-b', 'feature-x', base);
      write('other.ts', 'x\n');
      git('add', '.');
      git('commit', '-qm', 'feature-x work');
      git('merge', '--no-edit', '-q', m1);
      write('shared.ts', 'export const V = 3; // M1 FIX + fx edit\n');
      git('commit', '-qam', 'feature-x: edit on top of fix');

      git('checkout', '-q', '-b', 'pr', base);
      write('mine.ts', 'm\n');
      git('add', '.');
      git('commit', '-qm', 'pr work');
      git('merge', '-s', 'ours', '--no-edit', '-q', 'feature-x');

      // Neither ancestry direction holds — the provenance check is the only path.
      expect(() => git('merge-base', '--is-ancestor', 'feature-x', 'mainline')).toThrow();
      expect(() => git('merge-base', '--is-ancestor', 'mainline', 'feature-x')).toThrow();
      // Confirm the direct-content check cannot fire: side !== mainBlob.
      expect(git('show', 'feature-x:shared.ts')).not.toBe(git('show', 'mainline:shared.ts'));
      // Main still holds the M1 fix the discard silently threw away.
      expect(git('show', 'mainline:shared.ts')).toContain('M1 FIX');

      const { status, output } = runGuard(dir, 'mainline');
      expect(status).toBe(1);
      // The mainline-derived content loss is blocking.
      expect(output).toMatch(/\[ERROR][^\n]*shared\.ts/);
      // Genuinely branch-local content (other.ts) stays a non-blocking warning.
      expect(output).toMatch(/\[WARN][^\n]*other\.ts/);
    } finally {
      cleanup(dir);
    }
  });

  it('does not report a side whose change is already present in the kept parent', () => {
    const { dir, git, write } = makeRepo();
    try {
      write('shared.txt', 'top\nmid1\nmid2\nbottom\n');
      git('add', '.');
      git('commit', '-qm', 'base');
      const base = git('rev-parse', 'HEAD');

      git('checkout', '-q', '-b', 'mainline');
      write('shared.txt', 'top\nshared\nmid1\nmid2\nbottom\n');
      git('commit', '-qam', 'main: add shared line');

      git('checkout', '-q', '-b', 'pr', base);
      write('shared.txt', 'top\nshared\nmid1\nmid2\nbottom\nextra\n');
      git('commit', '-qam', 'pr: add shared and extra line');

      git('merge', '--no-edit', '-q', 'mainline');

      const { status, output } = runGuard(dir, 'mainline');
      expect(output).toContain('no surviving silent reverts');
      expect(status).toBe(0);
    } finally {
      cleanup(dir);
    }
  });
});
