/**
 * health/silent-reverts-lib.ts — pure classification logic for the
 * silent-revert guard. No git I/O lives here so the rules stay unit-testable;
 * `silent-reverts.ts` does the git plumbing and feeds this module.
 *
 * ## The bug class
 *
 * A merge commit can discard changes that came from the incoming side. The
 * blunt instrument is `git merge -s ours origin/main`, which keeps our tree
 * wholesale; the subtle one is a conflict resolution that takes "ours" for a
 * file the incoming side legitimately changed.
 *
 * What makes it dangerous is not the loss itself but the *silence*: the merge
 * records the incoming commit as an ANCESTOR, so
 *   - git will never raise a conflict on those paths again, and
 *   - `git diff origin/main..HEAD` renders the result as an intentional edit.
 *
 * Confirmed instances in this repo — see issue #2282:
 *   - #1972  `opaqueBounds` stripped from 462/464 manifest entries (caught by
 *            luck, via an unrelated geometry test).
 *   - #2010/#2022  `boss-abilities.floor2.status.json` row reverted
 *            verified -> not-started; required a manual recovery session
 *            (handoff 2026-07-29-pr2022-main-merge-silent-revert-recovery).
 *   - #2286  used `-s ours` against origin/main. Audited clean, but only
 *            because main had moved by 2 files in that window; a busier window
 *            would have reverted every one of them undetectably.
 *
 * ## Detection rule
 *
 * For a merge M with merge-base `base`, an incoming side S, and the opposing
 * parent O, S's change was discarded when:
 *
 *   discarded  <=>  blob(S,f) !== blob(base,f)          // S changed f
 *              &&   blob(M,f) !== blob(S,f)             // M did not take it
 *              &&   ( blob(M,f) === blob(O,f)           // M took the other parent
 *                  || blob(M,f) === blob(base,f) )      // ...or reset to base
 *
 * The `blob(M) === blob(O)` arm is the load-bearing one and it is easy to get
 * wrong. An earlier draft of this guard tested only `blob(M) === blob(base)`,
 * which detects "reset to the ancestor" — NOT "took our side". Those coincide
 * only when our side left the file untouched. `git merge -s ours` produces
 * `blob(M) === blob(A)`, so whenever BOTH sides edited the same file the
 * base-only predicate silently passes.
 *
 * That is not hypothetical: it is precisely the shape of the confirmed
 * #2010/#2022 incident, where the PR edited its own row in
 * `boss-abilities.floor2.status.json` while main edited the `don-paco` row.
 * The base-only predicate would have missed the one case this guard exists to
 * catch. Proven with a synthetic repro before the rule was changed.
 *
 * ## Known limitation (deliberate, v1)
 *
 * Whole-blob comparison cannot see PARTIAL hunk loss: a hand resolution that
 * keeps most of S but drops one conflicting hunk yields a result equal to
 * neither parent nor the base, so no whole-file predicate fires. v1 covers
 * whole-tree `ours` merges, whole-file parent selection, and reset-to-base.
 * Partial-hunk detection needs merge replay (`git merge-tree`) and is out of
 * scope; file-specific structural validators are the better answer there.
 *
 * ## Why a survival filter is mandatory
 *
 * Per-merge detection ALONE produces false positives, and we have a real one:
 * on PR #2286 merge 7cc14eb91 discarded 5 files, but a later commit
 * deliberately deleted the surrounding machinery, so the end state was correct.
 * Failing that PR would have been wrong.
 *
 * So a discard is only reported when it SURVIVES to the PR head — i.e. the head
 * still carries the pre-merge content and nothing re-applied or superseded it:
 *
 *   survived  <=>  blob(HEAD,f) === blob(base,f)
 *
 * That combination is strictly more precise than either check alone: per-merge
 * alone over-reports superseded discards, and an end-state-only check cannot
 * distinguish "reverted by the merge" from "edited on purpose after merging",
 * because after the merge the incoming commit is an ancestor either way.
 */

/** A single file's blob identity across the commits that decide the verdict. */
export interface FileTriple {
  readonly path: string;
  /** Blob at the merge base. `null` when the file does not exist there. */
  readonly base: string | null;
  /** Blob on the incoming side being evaluated. */
  readonly side: string | null;
  /** Blob on the OPPOSING parent — the side the merge may have kept instead. */
  readonly other: string | null;
  /** Blob at the merge commit itself (the resolution that was chosen). */
  readonly result: string | null;
  /** Blob at the PR head, used for the survival filter. */
  readonly head: string | null;
  /**
   * True when HEAD preserves the incoming blob at a renamed path, including a
   * generated-entry collision merged into an existing canonical target.
   */
  readonly sideContentPreservedAtHead?: boolean;
  /**
   * True when a clean three-way merge of `base`, `other`, and `side` would
   * still produce `other` at this path. In that case `result === other` does
   * NOT mean the incoming side was discarded — the opposing side already
   * contained the incoming change and merely had extra edits of its own.
   */
  readonly sideAlreadyPresentInOther?: boolean;
  /**
   * Blob at the CURRENT mainline tip. When the discarded side's blob equals
   * this, the discard drops content main still holds — a genuine mainline loss
   * regardless of which branch delivered it. `undefined` when not supplied
   * (older callers/tests); only `=== side` upgrades severity, never downgrades.
   */
  readonly mainBlob?: string | null;
  /**
   * Blob at the path in the merge-base of `(side, mainRef)`. When this equals
   * `mainBlob`, the side had incorporated the current mainline content at this
   * path and then built further on it (so `side !== mainBlob`). If the merge
   * result also lacks `mainBlob`, the discard drops mainline-derived content
   * even though `side !== mainBlob`. `undefined` when not computed (e.g. the
   * side is already classified as mainline, where ancestry grading already
   * handles it).
   */
  readonly sideMainBase?: string | null;
}

/** One merge commit on the PR branch, already reduced to candidate files. */
export interface MergeInput {
  readonly sha: string;
  readonly subject: string;
  /** The incoming parent being evaluated (short sha or ref, for messages). */
  readonly sideRef: string;
  /**
   * True when the incoming side is reachable from `origin/main`. Discarding
   * mainline work is an ERROR; discarding the branch's own work is a WARN,
   * because that is the author's to lose.
   */
  readonly sideIsMainline: boolean;
  /** Paths acknowledged via a `Merge-Discard-Ack:` trailer on this merge. */
  readonly ackedPaths: ReadonlySet<string>;
  /** Only files where the incoming side differs from the base need checking. */
  readonly files: readonly FileTriple[];
  /**
   * How many candidate merge bases this (merge, side) pair has. Criss-cross
   * history yields more than one, and the verdict can differ depending on which
   * is chosen, so a finding only counts when it holds under EVERY candidate.
   * Defaults to 1 for the ordinary single-base case.
   */
  readonly baseCount?: number;
}

export interface SilentRevert {
  readonly mergeSha: string;
  readonly mergeSubject: string;
  readonly sideRef: string;
  readonly path: string;
  readonly severity: 'error' | 'warn';
  /** How many merges discarded this path; set by `dedupeByPath`. */
  readonly mergeCount?: number;
  /**
   * All merge SHAs (oldest-first within the deduped entry) that discarded this
   * path, set by `dedupeByPath`. Only populated when `mergeCount > 1`, so
   * remediation messages can tell the user which merge commits each need an
   * acknowledgement trailer — not just the most recent one.
   */
  readonly allMergeShas?: readonly string[];
}

/**
 * Commit-message trailer acknowledging an INTENTIONAL discard, scoped to the
 * exact merge commit it appears on.
 *
 * There is deliberately NO global path allowlist. Discard legitimacy is
 * merge-specific, not path-specific: the files most likely to be listed on a
 * standing allowlist — generated aggregates like
 * `public/assets/generated/manifest.json` — are exactly the confirmed victims
 * (#1972). A permanent path exemption would disable the guard precisely where
 * it is load-bearing, which is the mute-button failure AGENTS.md rule #11
 * forbids. An ack costs one trailer line and expires with its merge.
 */
export const ACK_TRAILER = 'Merge-Discard-Ack';

/**
 * Parse `Merge-Discard-Ack: <path>` trailers out of a commit message. Multiple
 * trailers are allowed; a single trailer may list comma-separated paths. Any
 * text after ` -- ` or ` — ` on the line is treated as the reason and ignored
 * for matching.
 *
 * Only lines in the Git trailer block are considered. The trailer block is the
 * final paragraph of the commit message (lines after the last blank line)
 * provided every non-empty line in that paragraph is a valid trailer
 * (`Token: value`). If the entire message consists only of trailer-shaped lines
 * and contains no blank line, the whole message is the trailer block. Any body
 * text that happens to contain `Merge-Discard-Ack:` (e.g. documentation) is
 * ignored because prose body paragraphs almost never consist entirely of
 * trailer-shaped lines.
 */

/** Matches a valid Git trailer token: starts with a letter, followed by
 *  letters/digits/hyphens, then a colon. No spaces in the token. */
const GIT_TRAILER_TOKEN_RE = /^[A-Za-z][A-Za-z0-9-]*:/;

export function parseAckTrailers(commitMessage: string): Set<string> {
  const acked = new Set<string>();
  const lines = commitMessage.split(/\r?\n/);

  // Find the last blank line to identify the potential trailer block.
  let lastBlankIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if ((lines[i] ?? '').trim() === '') {
      lastBlankIdx = i;
      break;
    }
  }

  // Candidate trailer lines: after the last blank line (or the whole message
  // when there is no blank line, which Git treats as a trailers-only message).
  const candidateLines = lines
    .slice(lastBlankIdx + 1)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (candidateLines.length === 0) return acked;

  // Every line in the final paragraph must look like a trailer (Token: value).
  // If any line is prose, this is a body paragraph, not a trailer block.
  if (!candidateLines.every((l) => GIT_TRAILER_TOKEN_RE.test(l))) return acked;

  const prefix = `${ACK_TRAILER}:`;
  for (const line of candidateLines) {
    if (!line.toLowerCase().startsWith(prefix.toLowerCase())) continue;
    const payload = line.slice(prefix.length).split(/\s+--\s+|\s+—\s+/)[0] ?? '';
    for (const part of payload.split(',')) {
      const p = part.trim();
      if (p) acked.add(p);
    }
  }
  return acked;
}

/**
 * Split a unified `git diff` for a single path into its added and removed
 * content lines (file-header lines excluded).
 *
 * Used by `sideAdditionsSubsumedByOther` to detect a subsumed conflict
 * resolution — a genuine textual conflict (so `git merge-tree` cannot
 * auto-resolve it) where the human/agent resolution still keeps every line
 * the incoming side added, just alongside more of its own edits. That shape
 * is common for growing tables/lists where both sides append a row.
 */
export function parseDiffLineChanges(diffText: string): {
  added: readonly string[];
  removed: readonly string[];
} {
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (line.startsWith('+')) added.push(line.slice(1));
    else if (line.startsWith('-')) removed.push(line.slice(1));
  }
  return { added, removed };
}

/**
 * Collapse a line's whitespace runs to a single space and trim. Markdown
 * tables (and similarly padded lists) get re-justified whenever a column's
 * widest cell changes, which changes inter-cell padding without changing any
 * cell's content — that padding churn must not defeat the subsumption check
 * below.
 */
function normalizeForComparison(line: string): string {
  return line.replace(/\s+/g, ' ').trim();
}

/**
 * True when every non-blank line the incoming side ADDED (relative to the
 * merge base) also appears as an added line in the opposing side's resolution
 * — i.e. the incoming side's content is not lost, only reformatted alongside
 * more content. Comparison ignores whitespace-run differences (e.g. markdown
 * table column re-justification); see `normalizeForComparison`.
 *
 * Deliberately conservative: any line the incoming side REMOVED is not
 * verified this way (deletions are easy to silently drop and hard to confirm
 * by line-presence alone), so this returns `false` whenever `sideRemoved` is
 * non-empty — those cases still get the ordinary discard treatment. This
 * complements (does not replace) the `git merge-tree`-based check in
 * `silent-reverts.ts`, which only fires when the two sides' edits do not
 * textually conflict; this heuristic instead handles the shape where they DO
 * conflict (e.g. two PRs both append a row to the same markdown table) but
 * the chosen resolution still carries every line the incoming side added.
 */
export function sideAdditionsSubsumedByOther(
  sideAdded: readonly string[],
  sideRemoved: readonly string[],
  otherAdded: readonly string[],
): boolean {
  const meaningfulAdded = sideAdded.map(normalizeForComparison).filter((line) => line.length > 0);
  if (meaningfulAdded.length === 0) return false; // nothing to subsume
  if (sideRemoved.some((line) => normalizeForComparison(line).length > 0)) return false;
  const otherAddedSet = new Set(
    otherAdded.map(normalizeForComparison).filter((line) => line.length > 0),
  );
  return meaningfulAdded.every((line) => otherAddedSet.has(line));
}

/**
 * True when the merge dropped a change the incoming side made — either by
 * taking the opposing parent's version wholesale, or by resetting to the base.
 *
 * The `result === other` arm is what catches `git merge -s ours`; testing only
 * `result === base` misses every file that BOTH sides edited. See the module
 * header for the incident that proves it.
 */
export function isDiscarded(f: FileTriple): boolean {
  if (f.side === f.base) return false; // incoming did not change it
  if (f.result === f.side) return false; // merge took the incoming version
  if (f.result === f.other) return f.sideAlreadyPresentInOther !== true;
  return f.result === f.base;
}

/**
 * True when the discarded state is still exactly what the PR head carries —
 * nothing re-applied the incoming change and nothing rewrote the file since.
 *
 * Comparing against `result` (not `base`) is what makes this correct for both
 * discard arms: after a `-s ours` merge the surviving state is OUR blob, not
 * the ancestor's. If a later commit touched the file at all, the finding is
 * superseded and visible as an ordinary reviewable change in the PR diff.
 */
export function survivesToHead(f: FileTriple): boolean {
  if (f.sideContentPreservedAtHead === true) return false;
  return f.head === f.result;
}

const GENERATED_ENTRY_IDENTITY_FIELDS = new Set([
  'briefId',
  'spriteName',
  'assetPath',
  'variantIndex',
]);

export function generatedEntryRenamePreservesContent(
  sourcePath: string,
  targetPath: string,
  sourceContent: string,
  targetContent: string,
): boolean {
  const entryPrefix = 'public/assets/generated/entries/';
  if (
    !sourcePath.startsWith(entryPrefix) ||
    !targetPath.startsWith(entryPrefix) ||
    !sourcePath.endsWith('.json') ||
    !targetPath.endsWith('.json')
  ) {
    return false;
  }

  try {
    const source = JSON.parse(sourceContent) as Record<string, unknown>;
    const target = JSON.parse(targetContent) as Record<string, unknown>;
    const substantive = (entry: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(
        Object.entries(entry).filter(([key]) => !GENERATED_ENTRY_IDENTITY_FIELDS.has(key)),
      );
    return JSON.stringify(substantive(source)) === JSON.stringify(substantive(target));
  } catch {
    return false;
  }
}

/**
 * Grade a surviving discard.
 *
 * Ancestry alone is not sufficient. `sideIsMainline` asks "is this PARENT on
 * (or does it contain) the mainline", which misses a colleague branch that
 * merged an OLDER main tip: it is neither an ancestor of current main nor a
 * descendant of it, yet the content it carries may be exactly what main still
 * holds. Verified by repro — a `-s ours` discard of such a branch dropped a
 * still-current main fix and graded `warn`, exiting 0.
 *
 * So we also grade on CONTENT: if the discarded side's blob is byte-identical
 * to what mainline currently has at that path, the discard loses content main
 * holds today, whoever delivered it. That is the direct definition of a
 * mainline loss and is independent of topology.
 *
 * Content can only UPGRADE warn -> error; it never downgrades an
 * ancestry-established mainline loss.
 *
 * PROVENANCE: a further gap exists when the colleague merged an older main tip
 * and then EDITED the file. After the edit, `side !== mainBlob` so the direct
 * content check misses it, yet side's blob was built on top of mainBlob. If the
 * discard result also lacks mainBlob, the discard has lost the mainline content
 * the colleague had incorporated. Detected via `sideMainBase`: if the
 * merge-base of `(side, mainRef)` held `mainBlob` at this path, the colleague
 * had incorporated it, and `result !== mainBlob` confirms it is no longer in
 * the merge result.
 */
export function gradeSeverity(merge: MergeInput, file: FileTriple): 'error' | 'warn' {
  if (merge.sideIsMainline) return 'error';
  // Direct content match: the discarded blob IS main's current blob.
  if (file.mainBlob !== undefined && file.mainBlob === file.side) {
    return 'error';
  }
  // Provenance match: side's merge-base with main held mainBlob, meaning side
  // incorporated it and then built further on top (so side !== mainBlob). If
  // the result also lacks mainBlob, the discard dropped mainline-derived content.
  // Guard mainBlob !== null so null === null (both deleted) falls to the direct
  // check above rather than silently upgrading an unrelated null match.
  if (
    file.mainBlob !== undefined &&
    file.mainBlob !== null &&
    file.sideMainBase !== undefined &&
    file.sideMainBase === file.mainBlob &&
    file.result !== file.mainBlob
  ) {
    return 'error';
  }
  return 'warn';
}

/**
 * Apply the per-merge acks + discard + survival rules.
 *
 * When a (merge, side) pair has several candidate merge bases (criss-cross
 * history), the caller supplies one `MergeInput` per base and a matching
 * `baseCount`. A finding is only emitted if it holds under EVERY candidate,
 * so an ambiguous base choice can never manufacture a false positive. This is
 * deliberately preferred over hard-failing on criss-cross history: repeated
 * main-merges produce that shape routinely, and "re-do the merge" is not an
 * actionable remedy for a merge that already landed.
 */
export function findSilentReverts(merges: readonly MergeInput[]): SilentRevert[] {
  const hits = new Map<string, { revert: SilentRevert; count: number; needed: number }>();

  for (const merge of merges) {
    for (const file of merge.files) {
      if (merge.ackedPaths.has(file.path)) continue;
      if (!isDiscarded(file)) continue;
      if (!survivesToHead(file)) continue;

      const key = `${merge.sha}\u0000${merge.sideRef}\u0000${file.path}`;
      const existing = hits.get(key);
      if (existing) {
        existing.count += 1;
        continue;
      }
      hits.set(key, {
        count: 1,
        needed: merge.baseCount ?? 1,
        revert: {
          mergeSha: merge.sha,
          mergeSubject: merge.subject,
          sideRef: merge.sideRef,
          path: file.path,
          severity: gradeSeverity(merge, file),
        },
      });
    }
  }

  return [...hits.values()].filter((h) => h.count >= h.needed).map((h) => h.revert);
}

/**
 * Collapse findings to one per path, keeping the most recent merge that
 * discarded it and preferring `error` over `warn`.
 *
 * Successive main-merges into a long-lived branch each re-discard the same
 * path, so an undeduped report lists one file three or four times. Every copy
 * describes the SAME current state of that file at head and has the SAME
 * remedy (re-apply the missing changes and re-check `git diff <base> -- path`),
 * so the duplicates are pure noise — and a guard people scroll past is a guard
 * people route around.
 *
 * Expects `findings` in newest-first order, which is what `git rev-list`
 * produces.
 *
 * Sets `allMergeShas` when more than one merge discarded the path so that
 * remediation messages can list EVERY merge that needs an acknowledgement
 * trailer — not only the most recent one.
 */
export function dedupeByPath(findings: readonly SilentRevert[]): SilentRevert[] {
  const byPath = new Map<
    string,
    { finding: SilentRevert; mergeCount: number; mergeShas: string[] }
  >();
  for (const f of findings) {
    const seen = byPath.get(f.path);
    if (!seen) {
      byPath.set(f.path, { finding: f, mergeCount: 1, mergeShas: [f.mergeSha] });
      continue;
    }
    seen.mergeCount += 1;
    if (!seen.mergeShas.includes(f.mergeSha)) {
      seen.mergeShas.push(f.mergeSha);
    }
    // A mainline loss outranks a branch-local one for the same file.
    if (seen.finding.severity === 'warn' && f.severity === 'error') {
      seen.finding = f;
    }
  }
  return [...byPath.values()].map(({ finding, mergeCount, mergeShas }) => ({
    ...finding,
    mergeCount,
    allMergeShas: mergeShas.length > 1 ? (mergeShas as readonly string[]) : undefined,
  }));
}

/**
 * Acks that matched no actual discard on their merge. A stale ack is a silent
 * hole: it looks like the path is covered while the guard is in fact inert for
 * it, so it fails rather than being ignored.
 *
 * Grouped by merge SHA because a single merge contributes one `MergeInput` per
 * PARENT. An ack is attached to the merge commit, not to a side, so checking
 * each side independently would flag every legitimate ack as unused on the
 * opposing side — which would have made acks unusable and turned the guard
 * into something people route around.
 */
export function findUnusedAcks(
  merges: readonly MergeInput[],
): Array<{ mergeSha: string; path: string }> {
  const bySha = new Map<string, { acked: Set<string>; discarded: Set<string> }>();
  for (const merge of merges) {
    let agg = bySha.get(merge.sha);
    if (!agg) {
      agg = { acked: new Set(), discarded: new Set() };
      bySha.set(merge.sha, agg);
    }
    for (const p of merge.ackedPaths) agg.acked.add(p);
    for (const f of merge.files) if (isDiscarded(f)) agg.discarded.add(f.path);
  }

  const unused: Array<{ mergeSha: string; path: string }> = [];
  for (const [mergeSha, { acked, discarded }] of bySha) {
    for (const path of acked) {
      if (!discarded.has(path)) unused.push({ mergeSha, path });
    }
  }
  return unused;
}
