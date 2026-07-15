# Session Handoff: Merge-train real GitHub squash-merge promotion (MERGED completion semantics)

## Date

2026-07-15

## Persona

Producer / DevOps

## Systems touched

ci-policy

## Apples

5🍎 declared for the review-ledger tier (actual ~6🍎: the change grew from a
pure promotion swap to promotion rewrite + fail-closed post-merge proof +
idempotent crash recovery + downstream durable mapping + an ADR amendment,
after the adversarial plan review proved "replace only promotion" unsound).

## What Was Done

Replaced the merge train's **atomic multi-ref force-push** promotion with
**sequential GitHub squash-merges** so every future landed train PR ends GitHub
`state = MERGED` with a real, non-null merge commit — the maintainer's hard
gate. Root cause: ADR 0060 DEC-006/POS-003 falsely assumed force-pushing the
candidate onto `main` + PR head refs would keep GitHub's merged-PR semantics; it
never does (GitHub only sets `merged`/`merged_at` when the PR closes through its
own merge machinery). Verified live: 7 train-promoted PRs (#1087, #1092, #1099,
#1140, #1141, #1147, #1149) all `merged:false, merged_at:null` while their
commits are on `main`. The most recent merge-train PR (#1159) had _cemented_
`state==='closed'` as "success" — this change retires that.

Core (`.github/scripts/merge-train/`):

- **reconcile-lib.mjs** — rewrote `promoteExactBatch`'s promotion phase to a
  sequential loop: per entry, base-CAS (`main == expectedParent`) → auto-merge
  fence → `mergePullRequest` (GitHub squash) → **fail-closed post-merge proof**
  (`landedCommitProofError`: `merged:true` + `main==sha` + single parent ==
  expected base + `tree(landed)==tree(candidate prefix)` + `merged_at`) → only
  then the durable landed label/comment. Added `createMergePullRequest`
  (bounded mergeability poll; `PUT /pulls/{n}/merge` squash with head-`sha`
  pin + `Merge-Train-PR` trailer; 405/409 retryable, 403/422/5xx and
  `merged!=true` return a non-retryable `{ok:false}` result so the caller
  publishes the postcondition check and fails loudly — never throwing past that
  fail-closed publish), `landedCommitProofError`, `MergeTrainPromotionError`.
  Removed the retired `isPostPushConfirmationSatisfied`/`createWaitForMergedPr`
  (the forbidden `state===closed` predicate).
- **reconcile.mjs** — wired `createMergePullRequest`, `fetchCommit`,
  `publishPostconditionCheck` (posts the distinct
  `merge-train-promotion-postcondition`, never `merge-train`), idempotent
  `postLandedComment`, `disableAutoMerge` (GraphQL), and `reconcileLandedSignals`
  (crash-after-merge recovery: real merged-state is the durable journal). Removed
  the pre-push `merge-train` success check. Auto-merge disabled on admission.
- **state.mjs** — `LANDED_LABEL`, `LANDED_MARKER`,
  `PROMOTION_POSTCONDITION_CHECK_NAME`, shared `squashCommitTitle/Message`
  (buildCandidate now uses them), `parseMergeTrainPrNumber`, `renderLandedComment`.
- **resolve-landed-pr.mjs** (new) — trailer-first PR resolver, falls back to
  `commits/$SHA/pulls`.
- **backfill-historical-landed.mjs** (new) — adds the landed label + a truthful
  comment to historical force-pushed PRs (#1149) and verifies their GitHub state
  stays `closed`/`merged:false` (never falsified).

Downstream: `deploy.yml` (baseline commenter) and `manual-preview.yml` now
resolve the origin PR trailer-first via the shared resolver; the preview's
`state==open` filter (which missed real-merged PRs) is gone. The "released"
labeler (`gh pr list --state merged`) is fixed automatically now that train PRs
are truly merged.

Docs: **ADR 0063** (new) amends ADR 0060 DEC-005/006 (exact-SHA + atomicity →
validated-tree-equivalence) and ADR 0062 DEC-025 (retires the closed-predicate);
`docs/guides/merge-train.md` updated (new promotion model + required two-PR
canary pre-enable step).

## Key Decisions Made

- **Kept the speculative batch (option B), not one-PR-per-cycle (option A).**
  Per the maintainer's architectural decision: proceed with option B **but never
  expose an unvalidated prefix** — every cumulative prefix T1..Tn is validated
  (in parallel) before any merge, and `promoteExactBatch` re-confirms each
  prefix's evidence immediately before merging that PR. This gives batch
  admission/throughput while every tree that reaches `main` (including
  intermediates) has deterministic validation evidence.
- **Real merged-state is the durable transaction journal** — no separate store
  needed; `reconcileLandedSignals` backfills crashed landings idempotently.
- **Retired the binary-search bisect**: with every prefix validated, the earliest
  failing prefix's last-added PR is the culprit directly.
- **Do not post a `merge-train` check on landed commits** (would trigger the
  ci.yml fast-path); landed commits earn full push-CI, which is stronger evidence.

## Review Harness

- **Adversarial plan review** (rubber-duck, `gpt-5.6-terra`, separate model from
  the Opus implementer): verdict "replace-only-promotion is UNSOUND"; enumerated
  4 alternatives + 7 blocking findings, ALL folded into the shipped design.
  `plan_divergence: major_fork`.
- **Multi-model code review** (`gpt-5.6-terra` + `gemini-3.1-pro-preview`,
  adjudicated): see the review ledger for round outcomes.
- Ledger:
  `docs/knowledge/review-ledgers/2026-07-15-fix-merge-train-completion-semantics.review-ledger.json`.

## Verification

- `node --test .github/scripts/merge-train/*.test.mjs` → 160/160 pass (new
  `reconcile-promotion.test.mjs` covers the merge loop, proof, createMergePullRequest,
  and every task-listed deterministic case; `state.test.mjs` covers the trailer
  helpers; `reconcile.test.mjs` trimmed of the retired force-push tests;
  additional coverage for proof-polling, disambiguation, per-merge admission
  recheck, extracted `planLandedRecovery` decision, final-guard polling
  behaviour, and the `hasLandedLabel` proof-complete marker gate added in
  subsequent review-fix passes).
- `npm run test:guards` (the CI gate) → 887 tests, 866 pass / 0 fail / 21 skipped
  (the 21 skips are pre-existing intentional `describe.skip`/`test.skip` in
  unrelated guard suites, not failures).
- `npm run verify:fast` → passed. `npm run scope` → `gameplay_safe=true` (no
  headless/sweep needed; `.mjs` scripts are outside the TS lint/typecheck globs,
  covered by the node test suite instead).
- Workflow YAML (deploy/manual-preview/merge-train/validate) parse-checked.

## What's Next / Blockers

- **Post-merge (operational):** run
  `node .github/scripts/merge-train/backfill-historical-landed.mjs 1149=c8c57f8b`
  with a write token to backfill #1149's landed label + truthful comment, and
  confirm its state stays `closed`/`merged:false`.
- **Before re-enabling the live train:** run the required disposable **two-PR
  sequential-merge canary** under the live ruleset (confirms the App bypass
  covers a behind-PR squash for PR 2+), per the guide.
- **Coordination:** the parent paused `MERGE_TRAIN_ENABLED` to stop the live
  force-push path from creating more forbidden CLOSED/null PRs; the ruleset stays
  active. This change is code-only and takes effect on merge. No dependency
  conflict observed with the #1151/#1157 protection work (protection untouched).

## Retrospective

### Lessons Learned

- An eventually-consistent secondary GitHub signal (`state===closed`) was
  mistaken for ground truth across ADR 0062 DEC-024/025; the real completion
  signal is GitHub's own `merged:true`, obtainable only by using GitHub's merge
  machinery. When the requirement is "GitHub records it merged," you must let
  GitHub do the merge — you cannot force-push the tree AND get merged-semantics
  (mutually exclusive; once force-push closes the PR, nothing is left to merge).
- The adversarial plan review earned its keep: it caught that "replace only the
  push" silently drops exact-SHA validation and cross-PR atomicity, and that the
  merge API has no base-CAS — both material, both fixed before any code shipped.

### Mistakes Made

- Initial plan under-scoped the change as a pure promotion swap; the review
  reset it to a hardened redesign (proof + recovery + fencing + ADR amendment).
  Apple estimate corrected 5→~6 mid-session.

### Opportunities for Future Improvement

- If the parallel prefix-validation CI cost (up to 6 `verify:fast` runs per full
  batch) proves too heavy in practice, fall back to option A (one-PR-per-cycle)
  — the FIFO alternative retained in ADR 0063 ALT-001/002.
- Tighten `deploy.yml`'s "released" labeler to label only PRs represented by the
  deployed SHA range (currently labels all merged-but-unreleased PRs) — pre-existing
  imprecision, left in scope-focus.
