# Session Handoff: E2E-harden the issue → sprite pipeline (asset-request follow-up to #714)

## Date

2026-07-03

## Persona(s) adopted

**Producer** (shepherding PR #727 end-to-end), with a **DevOps/QA** lens for the
CI workflow + asset-request controller logic. Producer fit because the work spans
a GitHub Actions workflow, sidecar controller logic, and the review/merge gates.

## Routing verdict

✅ right persona — the task was PR-shepherding a multi-surface CI/controller change
to a clean squash-merge, which is exactly the Producer's remit.

## Apples

Estimated: 🍎 x 3 <!-- declared before work began -->
Actual: 🍎 x 3
Verdict: 🎯 Exact — the shepherd found two real regressions in the follow-up, but
each was a small, well-scoped fix with focused unit tests; ledger + harness fit
the 3🍎 tier as declared.

Hello kitties: 3/5 = 0.60 🎀

## Systems touched

quests

## Review Harness

Ledger: `docs/knowledge/review-ledgers/2026-07-03-asset-request-e2e-fixes.review-ledger.json`
Stages (3🍎): plan_review ✅ (gpt-5.5, 3 concerns, 3 resolved) · code_review ✅
(gpt-5.5, 2 rounds — round 1: 1 major concern; round 2: clean).
`npm run review:ledger -- validate <path>` → pass.

## What Was Done

Shepherded PR #727 (follow-up to just-merged #714). The PR's 5 E2E-hardening fixes
were sound, but the apple-scaled review harness (gpt-5.5 plan + code review)
surfaced **two real regressions** that I fixed on the branch before arming merge:

1. **Comment failure was fatal to the drain (MAJOR).** The enqueue-completion
   comment loop set `lastError` on a `gh issue comment` failure. `exitCodeForStatus`
   returns 1 whenever `lastError` is set, so the ingest step would exit 1 and the
   drain worker step (default `if: success()`) would be **skipped** — contradicting
   the PR's own "comment posting is best-effort" intent. **Fix:** comment failures
   now increment a dedicated `enqueueCommentErrors` counter and set
   `lastEnqueueCommentError` (diagnostic), and no longer touch `lastError`.

2. **Batched state save could orphan claims → duplicate Azure spend (MAJOR).** The
   poll loop did one `if (dirty) saveState` after the loop; a mid-loop
   `queue.enqueue` throw rejected the state-lock callback and skipped the save
   entirely, so an earlier issue's already-sent queue message lost its claim and was
   re-enqueued next poll (duplicate sprite generation; no already-completed entry
   guard exists). **Fix:** `saveState` now runs per-issue immediately after each
   successful enqueue+claim. The stale-claim reclaim delete is only persisted by
   that same per-issue save, so a throw discards the in-memory delete on reload
   (never a delete without a matching re-enqueue).

3. Dropping the `opened` issues trigger (MINOR) was reviewed and **accepted
   as-designed** (issue-form template auto-applies the label → `labeled` fires;
   manual-label entrypoint also fires `labeled`; `opened` double-fired). Documented
   in the ledger; no code change.

New/updated fields (`enqueueCommentErrors`, `lastEnqueueCommentError` on
`IssueIngesterStatus`) propagated to the CLI completion log and all status fixtures.

## Runtime / real-artifact observation

N/A for the game runtime — this change is the **asset-request CI pipeline** (GitHub
Actions + sidecar controller), not a game ECS system. The real artifact is the
pipeline's own behavior, exercised in CI/Azure. Deterministic evidence recorded
locally at the observable boundaries the bugs live at:

- **Concern 1 (before/after):** `exitCodeForStatus` unit test — a status with
  `enqueueCommentErrors=1` and `lastError=null` now returns **0** (drain runs);
  previously the controller set `lastError` on comment failure → would have been 1
  (drain skipped). Controller test renamed to assert `lastError` is null and
  `enqueueCommentErrors=1` after a comment throw.
- **Concern 2 (before/after):** new `per-issue state durability` controller test —
  two issues, the second `enqueue` throws; the first issue's claim is persisted
  (`listRequests('claimed')` = [100]) and is **not** re-enqueued on the next poll
  (`skippedDuplicate ≥ 1`, no duplicate message). Under the old batched save this
  test fails (100 re-enqueued → duplicate).

## What's Next

- Confirm the next **real** asset-request workflow run against a labeled issue
  (e.g. #724) posts the 🎬 Queued comment, enqueues once, and drains — the true E2E
  proof. Cite that run in a follow-up note if a human triggers it.
- Consider an idempotency entry-guard in `issue-pipeline.ts` (skip issues already in
  `completed` status) as defense-in-depth against duplicate generation — out of
  scope here but noted by the reviewer.

## Blockers

None. CI required checks are only aggregate `ci` + `commit-lint`; no human review
required; `required_conversation_resolution` is on (0 open threads at merge-arming).

## Branch State

- Branch: `ci/asset-request-e2e-fixes`
- All tests passing: yes (see Test Results)
- PR created: yes — https://github.com/nalfeo/Crawler/pull/727

## Agent-OS Telemetry

Guard telemetry captured via: none (no `files/guard-telemetry.jsonl` this session).

## Test Results

- `npx vitest run` (sprites suite: issue-ingester-controller, ingest-once-cli,
  sidecar-server) → **136 passed**.
- `npm run verify:fast` (typecheck + lint + changed unit tests) → **173 passed**, ✅.
- `npm run verify` (full) → see session; all stages green with the ledger + handoff
  in place.

## Key Decisions Made

- Made `enqueueCommentErrors` / `lastEnqueueCommentError` **required** fields on
  `IssueIngesterStatus` (mirrors the parent PR making `reclaimedStale` /
  `enqueueCommentsPosted` required) and updated all ~6 fixture sites, rather than
  optional — keeps the status shape honest (a status always has a comment-error
  count) at the cost of mechanical fixture churn.
- Kept the descriptive comment-failure message (`lastEnqueueCommentError`) rather
  than a count only, so a 403 vs. a network blip stays debuggable in CI logs
  without being fatal.

## Retrospective

### Lessons Learned

- A green PR body describing an intended behavior ("comment posting is best-effort")
  is not proof the code implements it — the harness caught that the code path
  actually made it fatal. Always trace the stated intent to the exit-code boundary.
- On Windows PowerShell, pass `--title` values with special chars carefully to the
  ledger CLI; `->` survived here, but prefer editing the ledger JSON directly for
  long multi-sentence `notes` to avoid shell-quoting corruption.

### Mistakes Made

- None material. Initial instinct was to minimize churn by making the new status
  fields optional; corrected to required for shape-honesty and consistency with the
  parent PR, accepting the small fixture-update cost.

### Opportunities for Future Improvement

- The 4 near-identical `IssueIngesterStatus` mocks in `sidecar-server.test.ts` are a
  churn magnet on every status-field addition — a shared `makeIngesterStatus()`
  test helper would collapse them to one edit site.
- Add the `issue-pipeline.ts` already-completed entry-guard as true idempotency
  defense-in-depth (see What's Next).
