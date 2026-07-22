# Handoff: Merge-train admission deadlock (two independent staleness bugs)

## Date

2026-07-22

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 3🍎, actual 3🍎.

## Summary

The speculative merge train had admitted nothing for hours: every open PR's `eligible()`
check in `.github/scripts/merge-train/reconcile.mjs` rejected with `"CI recovery admission
evidence is stale"`, so every reconcile pass ended `"No admitted PR is ready for candidate
construction."` Root-caused (in investigation session, branch `nalfeo-super-invention`) to
**two fully independent** staleness bugs, in two different scripts. Both are now fixed with
deterministic regression tests, verified red (fail against the pre-fix code with the exact
documented symptom) then green.

## What changed

### Vector A — reviewed-then-rebased TOCTOU-guard deadlock (`ci-recovery/reconcile.mjs`)

In the already-reviewed bootstrap path, when a PR had a `reason:'ready'` review decision on a
non-initial-event trigger, the code set `markerHeadSha` to the **old** commit Copilot's review
was submitted against (correct — needed so the head-based dedup marker doesn't falsely treat a
rebased head as "not yet reviewed"), then aliased that same old value into
`reviewDecisionHeadSha` and passed it as the **expected head** to the TOCTOU guard
`assertPrHeadUnchangedOrThrow` at both the `review-request-marker` and
`copilot-review-request` call sites. The guard re-fetches the live head and throws on any
mismatch; the catch logs `reason=head-sha-changed-before-mutation` and aborts the whole
reconcile **before** the admission/`merge-train`-label block. Once a PR was reviewed at commit
X and later advanced past X (rebase / merge-main), the guard mismatched **forever** — this
script could never re-converge that PR again. Canonical case: PR #1769, reviewed at `8bb55f9`,
head advanced by a merge-main commit; three recovery dispatches all aborted with
`expected=8bb55f9 actual=<live>`.

**Fix:** pass `pr.head.sha` — the reconcile's one true operating head, fetched once near the
top of the script and never reassigned — to the guard at both call sites instead of the stale
reviewed-commit value. `markerHeadSha` and the marker body construction (which still correctly
records the old reviewed commit for dedup) are untouched. Deleted the now-dead
`reviewDecisionHeadSha` variable.

**Likely origin:** this bug was almost certainly introduced by the same-day
[`2026-07-22-reconciler-review-gating.md`](2026-07-22-reconciler-review-gating.md) change,
which moved Copilot re-review requests under reconciler control and introduced the
already-reviewed bootstrap path this guard call lives in.

**Known, deliberate scope note:** the `copilot-review-request` call site's guard was fixed for
consistency/defense-in-depth, but `shouldRequestReview` (`review-request.mjs`) currently
hardcodes `requestReviewer:false` on every branch that returns `reason:'ready'`, so that
specific callback is provably unreachable with today's inputs whenever the bootstrap
already-reviewed path is taken. Only the `review-request-marker` call site has a real
regression test that proves the bug and the fix; the second site's fix is intentionally
untested defensive code, not a fabricated test.

### Vector B — admission fingerprint drift (`merge-train/state.mjs`)

`admissionFingerprint` hashed, per required check, the raw, ever-incrementing GitHub check-run
`id` alongside `{name, status, conclusion}`, plus full review-thread content (thread ids,
comment bodies, comment authors). Any benign check-run churn (a re-run producing a new run id
with the same conclusion, or a brand-new unrelated check-run appearing) or a new reply on an
already-resolved thread changed the fingerprint even though nothing admission-relevant had
changed — so `eligible()`'s final gate
(`state.headSha !== pr.head.sha || state.fingerprint !== fingerprint`) would reject a
converged, green, thread-clean PR as stale and its `merge-train` label got auto-stripped.
Proven case: PR #1557 — `idle`/`converged`, head matched, both required checks SUCCESS, 0
unresolved threads — enqueued then rejected purely from fingerprint drift. (Admin-merged
manually during investigation to unjam that one PR; the whole class stayed blocked until this
fix.)

**Fix (Option 1 from the plan review, chosen over refactoring `eligible()` itself — see the
review ledger for the rejected alternative):** made the fingerprint semantic instead of
identity-based — dropped `id` from the required-check digest (kept only
`{name, status, conclusion}`), and collapsed `reviewThreads` to a single `unresolvedThreadCount`
scalar instead of full thread objects. `headSha`/`title`/`baseRef` are unchanged, so admission
is still bound to a specific commit/PR.

**Why lossless:** both callers of `admissionFingerprint` (ci-recovery's own persistence call,
gated on zero blockers; `eligible()` itself, whose unresolved-thread rejection at line 209 runs
before the fingerprint is computed at line 233) are structurally guaranteed to see zero
unresolved threads at the moment they compute the fingerprint — any unresolved thread is
already rejected upstream as its own distinct blocker. Collapsing `reviewThreads` to a count
cannot discard real discriminating signal for either caller. No migration needed: writer and
reader both import the same function from `state.mjs`, so a PR with a stale pre-fix
fingerprint self-heals on ci-recovery's very next reconcile pass.

## Verification

- New regression tests added in `.github/scripts/ci-recovery/reconcile.test.mjs` (Vector A, 2
  tests) and `.github/scripts/merge-train/state.test.mjs` (Vector B, 4 tests).
- Red→green discipline: used `git stash push --keep-index -- <file>` to temporarily revert
  only the source fix (keeping the new tests), confirmed each fix-dependent test genuinely
  fails against the pre-fix code with the exact documented symptom
  (`reason=head-sha-changed-before-mutation` for Vector A; differing SHA-256 fingerprints for
  Vector B's churn/thread-content tests), then restored the fix and confirmed green.
- `node --test .github/scripts/ci-recovery/reconcile.test.mjs .github/scripts/merge-train/state.test.mjs`:
  136/148 passing, 0 failing, 12 skipped (pre-existing Windows-only `UV_HANDLE_CLOSING` libuv
  flakes, irrelevant to Linux CI).
- `npm run test:guards` (full): 1536/1564 passing, 0 failing, 28 skipped (same class of known
  flakes).
- `npm run verify:fast`: green.
- Review harness (3🍎 tier): separate-model plan review (gpt-5.4, `approved_with_changes` — 2
  blocking concerns resolved, 3 suggestions adopted) + one code-review round (clean, 0 valid
  concerns) — both recorded in
  `docs/knowledge/review-ledgers/2026-07-22-merge-train-admission-deadlock.review-ledger.json`,
  validated via `npm run review:ledger -- validate`.

## Rollout / meta-trap

This fix lands in the same `ci-recovery/` + `merge-train/` files that are part of the
currently-jammed cluster, so the fix PR itself likely **cannot be admitted by the train it
fixes** (chicken-and-egg). The PR is opened ready (not draft) with `gh pr merge --auto --squash`
armed, but will likely need an **admin-merge** to actually land. Once merged, every other PR
stuck on either staleness vector should self-heal on ci-recovery's next scheduled reconcile
pass — no backfill/migration step is required.

## Out of scope

Issue #1785 (`MERGE_TRAIN_MODE` variable cleanup) — explicitly excluded from this fix per the
kickoff instructions; unrelated to either staleness vector.
