# Silent merge-revert CI guard (#2282)

**Date:** 2026-07-29
**Apples:** 3🍎 (estimated) / 3🍎 (actual) — tooling-only cap applies
**Branch:** `silent-revert-guard`

## Systems touched

agent-tooling, ci

## What shipped

A deterministic CI guard that fails a PR when one of its merge commits
**silently discarded** changes another side made.

- `scripts/agent/health/silent-reverts-lib.ts` — pure classification
- `scripts/agent/health/silent-reverts.ts` — CLI + git plumbing
- `tests/unit/silent-reverts-guard.test.ts` — 32 tests incl. real-git fixtures
- `check-silent-reverts` job in `.github/workflows/ci.yml` + merge-gate wiring
- `npm run check:silent-reverts`

## The bug class

A merge resolves a conflict by keeping one side wholesale. The other side's
changes vanish with **no diff hunk anyone reviews** and **no future conflict**,
because git records the discarded commit as an ancestor. Three confirmed
instances (`manifest.json`, `sprite-catalog.json`,
`boss-abilities.floor2.status.json`) and one already-spent manual recovery
session (`2026-07-29-pr2022-main-merge-silent-revert-recovery`).

The `boss-abilities` ledger is the worst of the three because **agents read it
to decide what is already done**, so a silent revert misinforms future sessions
rather than merely losing data.

## The one thing worth remembering

**My first predicate was fatally wrong, and only an independent plan review plus
a synthetic repro caught it.**

```
BROKEN:    side !== base && result === base
CORRECTED: side !== base && result !== side && (result === other || result === base)
```

The broken form detects _reset-to-ancestor_, not _took-our-side_. After
`git merge -s ours` the result equals **our** blob, which only equals the base
when our side happened not to touch the file too. In the real
`boss-abilities` shape — main flips one row, the PR edits a different row of the
same file — both sides changed it, so the broken predicate returned **false**
and the guard would have shipped reporting "no surviving silent reverts" on a
merge that provably lost data.

I did not take the reviewer's word for it either. I built the exact history in a
throwaway repo and ran both predicates:

| predicate        | verdict                                               |
| ---------------- | ----------------------------------------------------- |
| mine (base-only) | **missed it** — exit 0, "no surviving silent reverts" |
| corrected        | exit 1, correct file, correct severity                |

That repro is now the test `detects taking the opposing side wholesale when BOTH
sides edited it`, and it is **mutation-proven**: reverting the predicate turns
exactly that test red while the other 31 stay green.

## Second real bug, found by the tests

`findUnusedAcks` originally checked each `MergeInput` independently. But
`collectMergeInputs` emits **one entry per parent**, and an ack lives on the
merge commit, not on a side — so every _legitimate_ ack was flagged unused on
the opposing side. That would have made acks unusable and pressured people to
route around the guard. Now aggregated per merge SHA, pinned by a test.

## Design decisions

- **No global path allowlist**, only per-merge `Merge-Discard-Ack: <path>`
  trailers. The paths most likely to end up on a standing allowlist (generated
  aggregates) are exactly the confirmed victims, so a permanent exemption would
  disable the guard precisely where it is load-bearing. Unused acks fail.
- **Criss-cross history** is evaluated against _all_ candidate merge bases; a
  finding must hold under every one. Hard-failing was the reviewer's suggestion,
  but "re-do the merge" is not actionable for a merge that already landed, and
  repeated main-merges produce that shape routinely.
- **Octopus merges fail closed** with an explicit finding — skipping would be a
  silent hole in a guard whose whole purpose is catching silence.
- **Not `DOCS_ONLY`-gated.** A merge can silently revert an ADR or a policy doc
  just as easily as source.
- **Own CI job**, not a step in `check-lightweight`, because it needs
  `fetch-depth: 0` and that cost should not land on the fast job. It checks out
  `github.event.pull_request.head.sha`, since the default `pull_request`
  checkout is GitHub's synthetic merge commit — which would itself be walked as
  a merge and can never carry an ack trailer.
- **Severity grading:** discarding mainline work is an `error`; discarding the
  branch's own work is a `warn` (the author's to lose).
- **Partial-hunk loss is undetectable** by any whole-blob predicate. Documented
  as a deliberate v1 limitation; would need `git merge-tree` replay.

## Observed against real history

Not just fixtures — run against the real `#2286` branch
(`SILENT_REVERT_BASE_REF=4f6e0eb9e^`):

- 22 findings before dedupe → **13 after**, 8 blocking.
- The criss-cross merge `7cc14eb91` is now analysed rather than refused, and
  correctly grades its losses as branch-local `warn`s.

I verified the guard was not lying. On merge `208dbdeb8`, main's
`sprite-catalog.json` really did go from 4865 lines to the branch's 471-line
version, dropping three `generated:tile-door-*` rows. Those rows are
_legitimately_ superseded (now derived from shards), which is exactly what the
ack trailer is for — a true positive needing an ack, not a false positive.

## Severity grading: three holes found in review, all repro-proven

Review found **three** independent ways a genuine mainline loss graded `warn`
(non-blocking, exit 0) — one per round, from three different models. All were
reproduced with synthetic git repos before fixing and mutation-proven after, and
none was hypothetical.

**Hole 1 — mainline loss arriving via a non-mainline parent.** Grading asked
only "is this parent an ancestor of main". A PR that merges a colleague branch
(never merged to main) which had _itself_ merged main discards main's work, but
the parent is not an ancestor of main → `warn`, exit 0. Fixed by also treating
the side as mainline when main is reachable **from** it.

**Hole 2 — colleague merged an OLDER main tip.** If main then advances in an
unrelated file, the colleague tip is _neither_ an ancestor nor a descendant of
current main, so **no ancestry test can see it** — yet the content it carries is
still exactly what main holds today. Fixed by grading on **content**:
`gradeSeverity` marks `error` when the discarded blob is byte-identical to
main's current blob at that path. That is the direct definition of a mainline
loss and is topology-independent.

The content rule can only **upgrade** `warn → error`, never downgrade. It is
precise rather than blanket: in the hole-2 repro `shared.ts` (still current on
main) blocks while `other.ts` (genuinely branch-local) stays a warning.

**Hole 3 — discarded mainline DELETION.** An over-defensive `mainBlob !== null`
guard (my comment claimed matching nulls would fire spuriously — it can't,
because `isDiscarded` already requires `side !== base`) meant that discarding a
branch that carried main's _deletion_ graded `warn`, silently resurrecting a
file main had deleted. Fixed by dropping the null guard.

> **Test-quality note.** TWO of the regression tests initially supplied were
> **tautological** — they passed with their own fix reverted, so they looked like
> coverage without being coverage. Both were caught by mutation testing, not by
> reading them:
>
> - The hole-3 test had the colleague merge main's _tip_, so ancestry clause (b)
>   fired and the content rule was never exercised.
> - The hole-1 test had the same shape, so the _content_ rule graded it `error`
>   and ancestry clause (b) was never exercised.
>
> Both fixtures were rebuilt to isolate exactly one grading path. **All three
> severity regression tests are now individually mutation-proven**: each fails
> with its own fix reverted and passes with it restored.
>
> Generalizable lesson: a passing test proves nothing until you have seen it go
> red. Mutation-test any regression test that guards a subtle predicate.

**Round 4 declared the grading logic clean** via a systematic case table over
`side`/`mainBlob` null-ness and both ancestry directions: no fourth shape where a
current-mainline loss grades `warn`, and no false-`error` path (a coincidental
`mainBlob === side` still means main's current content is being dropped, and the
ack path exists for intentional cases).

**Neither fix inflates blocking counts on real data.** Re-measured against PR
#2286's real merge chain (`243eb7aae..208dbdeb8`): **13 findings / 8 blocking**
both before and after both fixes. The holes were closed at zero added friction.

## Relationship to the row-ownership guard (already on main)

While this branch was in review, main shipped `check-aggregate-row-ownership`
(job `check-aggregate-rows`) — the row-ownership approach I originally proposed
for #2282 and then re-scoped away from. **The two are complementary, not
redundant**, and I checked this rather than assuming:

|                                           | row-ownership (on main) | this guard                  |
| ----------------------------------------- | ----------------------- | --------------------------- |
| granularity                               | row / field inside JSON | whole blob                  |
| scope                                     | 2 registered JSON files | **every** file              |
| compares                                  | PR head vs main vs base | per-merge-commit resolution |
| stale JSON row / stripped field           | ✅                      | ❌                          |
| `-s ours` discarding `.ts`, tests, CI yml | ❌                      | ✅                          |

The `-s ours` audit that motivated this guard found discarded files including
`scripts/sprites/checkin-runtime.ts`, `scripts/sprites/queue-commit.ts`,
`tests/unit/npc-sprite-map.test.ts` and `src/shared/data/set-pieces.json` — the
row guard's registry covers **none** of those. Conversely the row guard catches
sub-file stale rows, which no whole-blob predicate can see.

They overlap only on `manifest.json` and `boss-abilities.floor2.status.json`,
and at different granularities, so a real problem there is reported twice rather
than missed once. That is the correct trade.

## Known limitations

- Partial-hunk loss within a file (see above).
- Whole-repo `-s ours` against a heavily-advanced main produces one finding per
  affected path. That is proportionate — but it means a supersession-heavy PR
  pays a real ack cost.

## Follow-ups not owned here

- **#2284** needs a human semantic decision (opt-out wins vs. blocked always
  counts); it is a decision, not a patch.
- **#2275** has an auto-opened PR #2276, unreviewed.
- #2010 / #2022 / #2126 / #2130 have posted resolutions but are unmerged.
