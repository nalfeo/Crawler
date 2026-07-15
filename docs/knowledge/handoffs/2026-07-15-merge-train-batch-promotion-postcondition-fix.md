# Session Handoff: Merge-train batch promotion postcondition/cleanup coupling fix (4th gap, live cutover)

## Date

2026-07-15

## Persona

Producer

## Systems touched

ci-policy

## Apples

3🍎 (declared up front; one core function restructured for a live-discovered
trust-invariant edge case in `reconcile-lib.mjs`, a retry-budget tuning change
in `reconcile.mjs`, and 5 new deterministic tests — smaller diff footprint than
the original 3-gap fix (#1151/#1153/ADR 0062 DEC-019–023), but consequential
production automation logic, hence plan review + code-review loop rather than
skipping review stages)

## What Was Done

This session performed the **actual live `enable` cutover** for issue #1151's
already-shipped fix (PR #1153, merged) and, during real observation of a
candidate validation + atomic promotion cycle, discovered a **4th, distinct
gap** beyond #1151's declared scope. Filed as new issue #1154 (not a reopen of
#1151, since it is a different bug in a different file/function).

**Live cutover sequence performed:**

1. `protection.mjs status` (live) → confirmed the #1151/#1153 hydration fix:
   `bypassActorId: 4106541`, only `enforcement: disabled` as expected
   pre-cutover, no more false empty ref/rules/bypass.
2. `protection.mjs enable --app-id 4106541` (live) → succeeded cleanly, no
   false rollback (the core #1151 proof-of-fix). Final state: classic checks
   disabled, ruleset `19000576` active, `bypassActorId: 4106541`,
   `problems: []`.
3. Confirmed idempotency (re-running `status` reused the same ruleset, no
   duplicate created).
4. Set `MERGE_TRAIN_ENABLED=true`; closed stale duplicate PR #1152.
5. Admitted a real PR (#1141) to the train to force a live cycle; discovered
   the repo's shared, highly concurrent automated activity had already queued
   5 PRs independently.
6. Observed multiple successful "Merge Train Validation" runs (candidate
   validation — `verify:fast` + security check).
7. Observed a real atomic promotion: `promoteExactBatch`'s single
   `git push --atomic ... --force-with-lease` fast-forwarded a 6-PR batch
   (#1087, #1092, #1099, #1140, #1141, #1147) into `main` — **verified fully
   successful via `git log origin/main`**: all 6 PRs' commits correctly
   present, each tagged with the right PR number.
8. The dispatched reconcile run then **threw**:
   `PR #1087 was not recorded as merged after atomic promotion to <sha>`.

**Investigation (before deciding on rollback):**

- Confirmed the atomic push had fully, correctly succeeded (git-verified, see
  above) — no data loss, no invariant violation in the actual promotion.
- Confirmed the ruleset/classic-protection layer (#1151/#1153's fix) remained
  completely healthy throughout (`protection.mjs status` → `problems: []`) —
  this new bug is fully isolated to `reconcile-lib.mjs`, not implicated with
  #1151's scope.
- Root cause: GitHub's own asynchronous "merged" detection (`merged` /
  `merged_at` fields — a _secondary_, laggy confirmation of a fact the atomic
  push already proved) lagged past the old ~31s retry budget
  (`waitForMergedPr` in `reconcile.mjs`) for PR #1087 specifically —
  `state: closed` flipped within ~34s (webhook-driven), but `merged_at` stayed
  `null` well past the budget, and remained `null` even minutes later.
- The old `promoteExactBatch` code aborted its **entire** post-push loop on
  the first unconfirmed entry — before the separate cleanup loop (remove
  `merge-train`/`merge-train-blocked` labels, update status) ever ran for
  **any** entry, including the 5 siblings that had already confirmed cleanly.
- Because `reconcile.mjs`'s queue-builder fetches `pulls?state=open`, and
  these PRs closed quickly, all 6 were left **permanently** stuck with a
  stale `merge-train` label — no future reconcile cycle would ever clean it
  up (closed PRs are invisible to the open-PR queue query).
- An existing, deliberate test (`reconcile.test.mjs`, "promoteExactCandidate
  publishes a separate failure when GitHub does not record the PR as
  merged") proved the original hard-fail-on-unconfirmed design was
  intentional, not accidental — constraining the fix to preserve that trust
  invariant for genuinely unconfirmed entries, not weaken it.

**Immediate safety action (per the task's explicit instruction: "if any
invariant/config issue appears, safe rollback first, then fix via separate
PR"):**

- Paused the train: `MERGE_TRAIN_ENABLED=false`.
- Manually removed the stale `merge-train` label from all 6 affected PRs
  (they were all correctly merged; only the label/status bookkeeping was
  stuck).

**Fix implemented, tested, and reviewed in this session** (see Key Decisions
below); ready to ship as a **separate PR** per instruction, then re-enable the
train and re-observe a clean cycle.

## Key Decisions Made

- **Collect-and-continue, not abort-on-first-failure, for the entire
  post-push phase** in `promoteExactBatch` (`reconcile-lib.mjs`): confirmation
  reads for every entry now run in **parallel** (`Promise.all`) with a
  per-entry `try/catch` (an API error is treated as "unconfirmed" with the
  error recorded, not an abort); publishing the `-promotion-postcondition`
  failure check is wrapped in its own `try/catch`; the cleanup loop
  (remove labels, update status) wraps each entry in its own `try/catch`. All
  collected failures (unconfirmed entries, cleanup failures,
  postcondition-check-publish failures) are aggregated into **one** thrown
  error only after cleanup has been attempted for every eligible entry. This
  was driven by a plan-review finding (see below) — the initial version only
  decoupled cleanup from a plain `false` return, not from any thrown
  exception in the same phase.
- **Trust invariant preserved, not weakened**: a genuinely unconfirmed entry
  still skips its own cleanup and the function still throws — the existing
  single-entry pre-existing test is unchanged and still passes.
- **Retry budget increased** (`reconcile.mjs`'s `waitForMergedPr`, ~31s →
  ~77s total via `MERGED_PR_POLL_DELAYS_MS`) to reduce recurrence frequency
  under load, while staying well inside the reconcile job's 15-minute
  timeout even for a full batch where every entry independently exhausts the
  budget. This is mitigation, not a full resolution of the underlying async
  lag — documented as such.
- **Filed as a new issue (#1154), not a #1151 reopen** — distinct bug,
  distinct file (`reconcile-lib.mjs`/`reconcile.mjs` vs. `protection.mjs`),
  discovered outside #1151's declared scope.
- **Deferred, not implemented**: a periodic sweep job to self-heal any
  future stale-labeled-but-actually-merged PRs (a plan-review non-blocking
  suggestion). The current fix already prevents the _coupling_ bug (siblings
  no longer get stranded by one entry's lag); a standalone repair sweep would
  be new, separately-scoped infrastructure and risks scope creep on an
  already-live incident fix. Recommended as a future follow-up in issue
  #1154 if stale labels recur for any other reason.
- **Not implemented**: switching `reconcile.mjs`'s queue-builder from
  `pulls?state=open` to `state=all` — a plan-review reviewer explicitly
  recommended against this as the primary fix (broadens an unrelated,
  higher-traffic code path for a narrow bookkeeping gap); a targeted sweep
  (if ever needed) is safer and narrower.

## Review Harness

- Plan review (gpt-5.4, separate model): found **one blocking concern** — the
  initial fix only decoupled cleanup from a plain `waitForMergedPr() === false`
  return, not from any _thrown_ exception elsewhere in the post-push phase
  (confirmation-read errors, postcondition-check-publish errors, per-entry
  cleanup errors) — any of those could still abort the tail and re-strand
  confirmed siblings. Resolved by the collect-and-continue restructuring
  above (parallelized polling + three separate `try/catch` layers).
  `plan_divergence: minor`.
- Code review (gpt-5.4): traced the actual diff (`Promise.all` block, the
  `unconfirmedEntries` Set, `positions[index]` alignment, the `failureParts`
  aggregation), manually verified all 5 new tests' assertions against the
  implementation, and confirmed `MERGED_PR_POLL_DELAYS_MS` has no off-by-one.
  Zero concerns.
- Ledger: `docs/knowledge/review-ledgers/2026-07-15-merge-train-batch-promotion-postcondition-fix.review-ledger.json`
  — validated (3🍎 tier: plan_review + code_review, no multi-model required).

## Verification

- `node --test .github/scripts/merge-train/reconcile.test.mjs` → 40/40 pass
  (includes 5 new tests for this fix).
- `node --test .github/scripts/merge-train/*.test.mjs` (full merge-train
  suite) → 110/110 pass.
- `npm run typecheck` → clean.

## What's Next / Blockers

- **Open and ship a separate PR for this fix** (per the task's explicit
  instruction), arm squash auto-merge, shepherd through CI/review.
- **After merge**: re-enable `MERGE_TRAIN_ENABLED=true`; re-verify
  `protection.mjs status` remains clean (`problems: []`).
- **Re-observe a live cycle with the fixed code**: watch for another real
  candidate validation + atomic promotion (the repo's concurrent PR pool
  should supply one) and confirm the postcondition no longer strands
  confirmed siblings if any entry's confirmation lags again.
- **Optional future follow-up** (not blocking, documented above): a periodic
  sweep for closed-but-still-labeled PRs, as defense in depth beyond the
  coupling fix. Track in issue #1154 if it recurs.

## Retrospective

- The GitHub Actions `schedule` cron and `workflow_run` triggers on
  `merge-train.yml` were observed running unreliably under heavy concurrent
  Actions load in this shared repo (real gaps of 1.5–2 hours vs. the
  configured 5-minute cron; `workflow_run` failing to fire after several
  validation completions). This is an operational observation, not something
  fixed in this session — worth a future look if it recurs, but out of scope
  for this bug fix.
- This incident is a strong, concrete instance of the general lesson from
  #1151/DEC-021 (list-summary vs. detail hydration) recurring one layer up
  the stack: an eventually-consistent, secondary GitHub API signal
  (`merged`/`merged_at`) was treated as synchronous and authoritative, and a
  lag in it was allowed to override/block already-established ground truth
  (the atomic git push). Worth keeping in mind for any future GitHub-API-based
  postcondition check in this codebase.
