# 2026-07-16 — Merge train wake-up gaps (fail-closed dispatch + scheduled-CI wake)

## Systems touched

merge-automation, ci-infra

## Summary

Focused follow-up fix on top of already-merged PR #1165 ("fix(merge-train): add
reliable reconciliation wake-ups"). #1165 shipped the core idea (explicit
`workflow_dispatch` of `merge-train.yml` from `merge-train-validate.yml`'s
`publish` job, plus a CI-completion wake-up with a push/default-branch storm
guard) but had two remaining gaps versus the original task's explicit
requirements. This PR closes both:

1. **Fail-closed dispatch regression**: `merge-train-validate.yml`'s "Wake
   merge-train reconciliation" step had **no `if:` condition**, which GitHub
   Actions defaults to implicit `success()`. That meant the wake-up dispatch
   was silently skipped whenever the prior "Publish immutable candidate
   result" step itself failed (e.g. a transient `checks.create` API error) —
   directly violating the task requirement that dispatch happen for
   success/failure/cancelled publication so `reconcile` can consume, retry, or
   bisect. Fixed by adding `if: always()` (matching the sibling `publish` job's
   own `if: always()`).

   **Follow-up fix from code review**: `if: always()` alone made the wake
   _dispatch_ fire on a failed publish step, but did not make the wake
   _effective_. The fingerprinted check stayed whatever the original
   `dispatchValidation()` (reconcile.mjs) posted — `in_progress` — and
   `trainCheckState()` (state.mjs) only demotes a stuck in_progress check to
   retryable (`missing`) after `CANDIDATE_VALIDATION_STALE_MS` (40 minutes);
   before that it reports `pending`, which `planPrefixPromotion()` maps to the
   `wait` action. So the immediate wake would just see `pending` and do
   nothing — no better than the unreliable schedule fallback it exists to
   replace. Added a new "Mark candidate check retryable if publishing failed"
   step (`if: failure()`, runs after the publish step and before the wake
   dispatch) that posts a `cancelled` conclusion for the fingerprinted check —
   mirroring `reconcile.mjs`'s own `dispatchValidation` catch block — so the
   woken reconciliation redispatches validation immediately instead of waiting
   on staleness.

   **Second follow-up fix**: the retryable-check step initially reused
   `steps.app-token.outputs.token` (the original mint step's output). If the
   ROOT failure was that original "Generate repository app token" step itself
   (e.g. a transient GitHub Apps auth error), that output is empty, and
   `checks.create` requires a token from the trusted App identity —
   `trainCheckState()` filters check runs by `app.id`, so a
   `GITHUB_TOKEN`-authored check would never be recognized as authoritative
   anyway. Added a dedicated "Generate recovery app token" step
   (`if: failure()`, mints independently via
   `actions/create-github-app-token@v1`) between the publish step and the
   retryable-check step, and rewired the retryable-check step to use this
   recovery token instead. Since the recovery mint also runs on `failure()`,
   it gets an independent chance to succeed even when the original mint step
   is what failed — closing the gap rather than just falling back to the
   40-minute staleness bound for that failure mode.

   The terminal-check publication itself now retries transient Checks API
   failures up to three times (immediately, then after 1 second and 2 seconds)
   before failing closed. This prevents a momentary failure of the recovery
   call from recreating the 40-minute stall the fallback is intended to avoid.

2. **Scheduled-CI wake-up gap**: `merge-train.yml`'s `reconcile` job guard for
   `workflow_run` events named `'CI'` only allowed
   `event == 'push' && head_branch == default_branch`. But
   `mainHealthReason()` (`.github/scripts/merge-train/reconcile-lib.mjs`)
   treats whichever CI run for the current main SHA is newest by `created_at`
   as authoritative, regardless of push vs. schedule trigger. Production
   evidence (manual reconcile run 29461261403) showed a real pause citing an
   in-progress full-CI run for main; once that run completes, nothing
   previously re-woke `reconcile` unless it happened to be push-triggered —
   falling back to the empirically-unreliable ~hourly cron. Fixed by adding
   `|| (github.event.workflow_run.event == 'schedule' && vars.MERGE_TRAIN_ENABLED == 'true')`,
   an exact structural mirror of the already-shipped, already-proven identical
   carve-out in `.github/workflows/ci-recovery-incidents.yml` (~lines 38-42).
   PR-triggered CI completions remain rejected regardless (no storm
   regression); fails closed when the var is unset/false.

## Context: why this is a _second_ PR, not the original one

The coordinating session's original two-part request was implemented in full
on branch `nalfeo-fix-merge-train-dispatch-trigger` (PR #1166): both wake-ups,
plus a schedule/`MERGE_TRAIN_ENABLED` carve-out, fully reviewed (plan review +
3 code-review rounds) and tested (16+12 tests). While that PR's automated
review threads were being resolved, an independent concurrent effort merged
**PR #1165** into main with an overlapping-but-subtly-different implementation
of the _same two wake-ups_ in the _same two files_, making #1166 conflicting
and redundant. #1166 was closed as superseded (with an explanatory comment)
rather than resolving extensive merge conflicts for duplicate content. This PR
rebuilds only the two genuine gaps left open by #1165's version, off current
main.

## Files touched

- `.github/workflows/merge-train-validate.yml` — added `if: always()` to the
  "Wake merge-train reconciliation" step, plus a new "Generate recovery app
  token" step and "Mark candidate check retryable if publishing failed" step.
  Both are gated on `(failure() || cancelled()) && (steps.app-token.outcome ==
'failure' || steps.app-token.outcome == 'cancelled' || steps.publish.outcome
== 'failure' || steps.publish.outcome == 'cancelled')` — the
  `failure() || cancelled()` prefix is required to avoid an implicit-`success()`
  dead-code trap, verified empirically for `failure()`/`success()`; see the
  fourth- and fifth-round follow-ups below. The downstream "Mark candidate
  check retryable" step **additionally** requires
  `steps.recovery-app-token.outcome == 'success'` (the recovery-mint step
  itself cannot gate on its own outcome), so a failed recovery mint doesn't
  waste an attempt calling `checks.create` with no valid App token. It also
  queries existing checks via `checks.listForRef` before creating the
  cancellation, skipping as a no-op if a genuine terminal success/failure
  check already exists for the fingerprint (see the seventh-round follow-up
  below). It posts a `cancelled` conclusion for the fingerprinted check before
  the wake dispatches, with bounded retry for transient Checks API failures.
  "Publish immutable candidate result" has an explicit `id: publish` so the
  fallback conditions can check its own outcome.
- `.github/workflows/merge-train.yml` — added the schedule/`MERGE_TRAIN_ENABLED`
  carve-out to the `reconcile` job's `if:` guard, with an explanatory comment
  describing the `mainHealthReason()` race scenario it closes.
- `tests/unit/merge-train-validate-publish.test.ts` — added:
  - a step-ordering assertion (wake step must run after the publish step)
  - an `if: always()` assertion on the wake step
  - a `describe` block covering the new retryable-check fallback step: its
    final `(failure() || cancelled()) && steps.recovery-app-token.outcome ==
'success' && (...)` condition and App-token wiring, its ordering (after
    publish, before the wake dispatch), its bounded retry behavior, and that
    its script actually posts a `cancelled` conclusion with the right
    `head_sha`/`external_id`
- `tests/unit/merge-train-workflow-wakeups.test.ts` — parameterized the
  existing `evaluatesReconcileCondition()` YAML-condition-evaluator helper with
  a `mergeTrainEnabled` substitution, and added:
  - schedule+enabled=true → wakes reconcile
  - schedule+enabled=false → fails closed
  - PR-triggered CI even with enabled=true → still rejected (storm-guard lock)
  - non-CI `workflow_run` names (e.g. `'Merge Train Validation'`) unaffected
    regardless of event/enabled state

## Verification

- `npm run typecheck` — clean
- `npm run lint` — clean
- Targeted tests: `npx vitest run tests/unit/merge-train-validate-publish.test.ts tests/unit/merge-train-workflow-wakeups.test.ts` — **29/29 passed** (24 + 5) — this line is kept current at each round; treat a fresh test run as authoritative over any inline count in an older round section below
- Both modified workflow YAML files parse cleanly via the `yaml` package (same
  parser the tests use) — confirmed no syntax breakage.
- `npm run verify:fast` — passed (typecheck + lint + changed unit tests +
  physics-defs/size/weight coverage checks)
- `npm run verify:pr-prereqs` — passed after this handoff + ledger + telemetry
  capture were added

## Review harness (3🍎)

- Plan review (separate model, `gpt-5.4`): verdict **convergent**, no blocking
  concerns. Two non-blocking suggestions (a test locking in that non-CI
  `workflow_run` names still pass through, and a wake-step-ordering
  regression test) were incorporated as new tests before implementation was
  considered final.
- Code review (separate model, `gemini-3.1-pro-preview`): **no significant
  issues found** — verified GitHub Actions expression precedence/semantics,
  storm-guard non-regression, safety of `if: always()` given the `publish`
  job's own `actions: write` permission and `if: always()`, and correctness of
  the test helper's string-substitution approach.
- Ledger: `docs/knowledge/review-ledgers/2026-07-16-merge-train-wakeup-gaps.review-ledger.json`
  (valid 3-apple ledger).

## Apple estimate

3🍎 (production-critical merge automation change touching two workflow files
plus their guard logic; consistent with the original task's criticality
assessment). Recorded via `apples:record`:
`docs/knowledge/metrics/apples/2026-07-16-merge-train-wakeup-gaps.json`
(3🍎 estimated → 3🍎 actual, exact).

## Unresolved issues / recommended next steps

- None outstanding for this fix's scope. `workflow_run`/schedule triggers are
  intentionally retained as defense-in-depth per the original task instruction
  (evidence shows they're unreliable as a _primary_ trigger, not that they
  never fire).
- **Process note for the coordinator**: two independent sessions implemented
  overlapping fixes for the same request concurrently (#1165 and the now-closed
  #1166), wasting one session's review/implementation effort. Worth
  deduplicating future multi-session dispatches for the same production
  incident/request, or having sessions check for in-flight PRs touching the
  same files before starting significant implementation work.
- Follow-up idea (raised in code review, non-blocking, not implemented here):
  bounded retry/backoff around the `actions.createWorkflowDispatch` call itself,
  in case the dispatch API call transiently fails. Left as a future
  enhancement since it wasn't part of the original task's explicit scope.

## Shepherd-round follow-up (post-PR review)

Three `copilot-pull-request-reviewer` findings on the opened PR were validated
and fixed:

1. The wake-dispatch-ineffective-on-publish-failure gap described above (added
   the "Mark candidate check retryable if publishing failed" step + 3 new
   regression tests).
2. This handoff's apple-estimate section incorrectly claimed `apples:record`
   was skipped because actual == estimated — the policy
   (`docs/agent-os/policies/complexity-policy.md`) requires it for every
   ≥3🍎 session regardless of delta. Recorded:
   `docs/knowledge/metrics/apples/2026-07-16-merge-train-wakeup-gaps.json`.
3. The stated test counts (8+9=17) were wrong; the actual counts were
   12+5=17 (now 17+5=22 after the fallback, recovery-token, and retry tests).
   Corrected above.

## Second shepherd-round follow-up (recovery-token gap)

Two more `copilot-pull-request-reviewer` findings on the fallback step landed
by the first shepherd round were validated and fixed:

1. **Recovery step reused the possibly-failed original App token**: the "Mark
   candidate check retryable if publishing failed" step used
   `steps.app-token.outputs.token`. If the ROOT failure was the "Generate
   repository app token" step itself (transient GitHub Apps auth error), that
   output is empty/unusable, and the fallback's `checks.create` call would
   fail before posting the `cancelled` conclusion — `trainCheckState()`
   filters check runs by trusted `app.id`, so a `GITHUB_TOKEN`-authored check
   is not a substitute. Fixed by adding a dedicated "Generate recovery app
   token" step (`if: failure()`, mints independently via
   `actions/create-github-app-token@v1`) and rewiring the fallback step to use
   `steps.recovery-app-token.outputs.token` instead. Since this new mint step
   also runs on `failure()`, it gets an independent chance to succeed even
   when the original mint step is what failed. Added 2 new regression tests
   asserting the fallback step's token wiring and the recovery-token step's
   existence/ordering/condition.
2. **PR description staleness**: updated to describe all three operational
   behaviors now shipped (fail-closed `if: always()` dispatch, retryable-check
   fallback with independently-minted recovery token, scheduled-CI wake-up
   carve-out) and the corrected test count.

**Note on a superseded alternative**: a separate autonomous commit
(`b7c1fab7`) proposed gating the retryable-check step on
`steps.app-token.outcome == 'success'` instead of adding a recovery mint —
i.e., accepting the app-token-mint-failure gap and just not attempting a
doomed call. That approach was superseded when reconciling this branch: the
recovery-app-token fix above actually _closes_ the gap (the retryable-check
step gets a real, independent chance to post its cancelled conclusion even
when the original mint failed) rather than accepting it as a residual
limitation, so the outcome-gating condition was removed in favor of the
recovery-token wiring.

## Third shepherd-round follow-up (ancestor-job `failure()` correctness bug)

One more `copilot-pull-request-reviewer` finding — the highest-severity of the
shepherd rounds — was validated and fixed on top of the recovery-token and
bounded-retry fixes above:

1. **Bare `failure()` also fires on an ancestor job's failure, not just this
   job's own steps**: both the "Generate recovery app token" and "Mark
   candidate check retryable if publishing failed" steps were gated on bare
   `if: failure()`. Per GitHub Actions semantics, step-level `failure()`
   returns true whenever **any job it `needs:`** fails — not only when a
   preceding step in the _same_ job fails. The `publish` job has
   `if: always()` and `needs: [verify]`. So when `verify` fails because of a
   genuine candidate defect, `publish`'s own steps ("Generate repository app
   token", "Publish immutable candidate result") both still run and succeed —
   "Publish immutable candidate result" correctly posts a `failure`
   conclusion for the fingerprinted check. But because the _ancestor_ `verify`
   job failed, `failure()` still evaluated `true` for every later step in
   `publish`, so the two fallback steps fired anyway and **overwrote the
   correct `failure` conclusion with `cancelled`** — causing `reconcile` to
   treat a genuinely broken candidate as merely retryable forever instead of
   bisecting the queue, silently masking real regressions.

   Fixed by giving "Publish immutable candidate result" an explicit
   `id: publish` and changing both fallback steps' conditions from bare
   `failure()` to
   `steps.app-token.outcome == 'failure' || steps.publish.outcome == 'failure'`
   — scoped to those two steps' own outcomes rather than the job-wide/ancestor
   -aggregate `failure()` function. This still fires for a genuine app-token
   -mint failure or a publish-step failure, but no longer fires merely because
   an upstream `verify` job failed while this job's own steps succeeded.
   Updated the large explanatory comment block above these steps to document
   the pitfall. Added 3 new regression tests: a real-condition-string
   assertion, an `id: publish` assertion, and a semantic test that evaluates
   the actual `if:` expression (via the same `new Function()` substitution
   technique used in `merge-train-workflow-wakeups.test.ts`) against
   `{app-token: success, publish: success}` (must NOT fire — this is exactly
   the ancestor-failure scenario) vs. `{app-token: failure}` /
   `{publish: failure}` (must fire).

Test counts after this round: **24 = 19 + 5** (was 22 = 17 + 5).

## Fourth round follow-up (empirical verification of the third round's fix, and a regression caught in it)

The third round's fix (scoping the fallback conditions to
`steps.app-token.outcome == 'failure' || steps.publish.outcome == 'failure'`,
without a `failure()`/`always()` wrapper) was itself never independently
verified against real GitHub Actions runtime semantics — it was implemented
directly off the reviewer's suggested condition text. Two things needed
checking: (a) was the reviewer's original ancestor-`failure()` claim actually
correct in this exact job shape, and (b) is a bare `outcome ==` condition (no
status-check function) actually reachable at all.

**Empirical method**: rather than trust ambiguous phrasing in GitHub's docs
("If you have a chain of dependent jobs, `failure()` returns `true` if any
ancestor job fails"), two real throwaway workflow runs were pushed to this
branch and inspected via the Checks API (`gh api
repos/nalfeo/Crawler/actions/runs/<id>/jobs`):

1. **Run 29467076748**: a `downstream` job (`if: always()`, `needs: [upstream]`
   where `upstream` deliberately fails) containing an implicit-condition step,
   an `if: failure()` step, and an `if: success()` step. Result: the
   implicit-condition step **ran** (success), the `if: failure()` step was
   **skipped**, the `if: success()` step **ran**. This empirically refutes the
   reviewer's claim for this job shape: step-level `failure()`/`success()`
   inside an already-running (`if: always()`) job reflects only **same-job**
   step outcomes, not an ancestor `needs:` job's result. Cross-checked with a
   separate-model rubber-duck review (`gpt-5.4`): verdict **AGREE**, finding
   not applicable, no fix needed for that specific concern.
2. **Run 29467286711**: a step with a bare
   `if: steps.fail_step.outcome == 'failure'` condition (the exact shape the
   third round's fix used, minus a wrapper) where `fail_step` genuinely
   failed. Result: the bare-outcome step was **skipped** — because GitHub
   Actions implicitly ANDs `success()` into any `if:` that contains no
   explicit status-check function, and `success()` (no prior step failed)
   directly contradicts an outcome check that requires a prior step to have
   failed. A sibling step with `if: failure() && steps.fail_step.outcome ==
'failure'` **ran** correctly. This proves the bare-outcome condition
   introduced by the third round (and by an independent autonomous commit
   `973e9476` that landed the same suggested fix) is **permanently
   unreachable dead code** — the two fallback steps (recovery-app-token mint,
   retryable-check) would never fire under any real circumstance, silently
   reintroducing the original 40-minute-staleness stall for every publish or
   app-token-mint failure.

**Fix**: both fallback steps' conditions changed from the bare
`steps.app-token.outcome == 'failure' || steps.publish.outcome == 'failure'`
to `failure() && (steps.app-token.outcome == 'failure' ||
steps.publish.outcome == 'failure')`. The `failure() &&` prefix is required
(not decorative) to suppress the implicit `success()` AND-ing and make the
condition reachable; the step-local outcome checks are retained as
defense-in-depth against `failure()`'s ancestor-job semantics in job-chain
shapes other than this one, even though finding (1) shows they are
currently redundant with bare `failure()` for this exact job. Rewrote the
comment block above the fallback steps to document both run IDs and the
rationale.

The cancellation publisher additionally requires
`steps.recovery-app-token.outcome == 'success'`, so a failed recovery mint
cannot invoke the Checks API with an empty token.

Updated `tests/unit/merge-train-validate-publish.test.ts`:

- Both `if:` string assertions (recovery-app-token step, retryable-check
  step) updated to the new `failure() && (...)` string.
- The semantic eval test now injects a mock `failure()` function into the
  `new Function()` scope and covers four cases: ancestor-only failure with
  same-job steps succeeding (`failure()` false) → must not fire; a
  hypothetical `failure()` true but both outcomes `success` → must still not
  fire (validates the outcome-check layer is independently load-bearing, not
  just `failure()`); app-token step itself failed → must fire; publish step
  itself failed → must fire.
- The same evaluator proves a failed recovery-token mint suppresses the
  cancellation publisher.

Test counts unchanged (24 = 19 + 5) — this round modified existing test
bodies/assertions rather than adding new tests, since the third round's tests
already covered the right _scenarios_, just against the wrong (dead-code)
condition string.

Also deleted two scratch/throwaway probe workflow files
(`zz-scratch-failure-semantics-probe.yml`,
`zz-scratch-bare-outcome-probe.yml`) used only for this empirical
verification — neither ships in the final PR.

**Process note for the coordinator**: the autonomous "agent-merge" automation
attached to this PR independently pushed 5 competing fix commits across this
session in response to evolving `copilot-pull-request-reviewer` findings.
Most were reconciled without incident, but one (`973e9476`) implemented
exactly the reviewer's suggested condition text and, absent empirical
verification, would have shipped a fallback mechanism that could never
execute. This is a concrete argument for treating reviewer-bot-suggested
literal code snippets (and any autonomous auto-fix that adopts them
verbatim) as requiring the same runtime verification as hand-written fixes,
especially for GitHub Actions expression semantics, which are easy to get
subtly wrong from documentation alone.

## Fifth round follow-up (cancelled-publication gap)

A further `copilot-pull-request-reviewer` finding on the fallback conditions:
bare `failure()` is false when a step is cancelled rather than failed, so if
"Publish immutable candidate result" is itself cancelled mid-flight (e.g. a
human manually cancels a stuck validation run via the UI/API) before its
`checks.create` call completes, neither fallback step fires — leaving the
original fingerprinted check `in_progress` and reconcile waiting out the full
40-minute staleness bound purely because of how this fallback recovers, not
because of any candidate defect.

This workflow has no `concurrency:` block, so the only realistic trigger for
a mid-flight cancellation is a manual UI/API cancellation — rare, but real,
and directly analogous to the failure() gap already fixed. Extended both
fallback steps' conditions from `failure() && (...)` to
`(failure() || cancelled()) && (steps.app-token.outcome == 'failure' ||
steps.app-token.outcome == 'cancelled' || steps.publish.outcome == 'failure'
|| steps.publish.outcome == 'cancelled')`. `always()`/`cancelled()`-gated
steps are documented by GitHub Actions to still execute after a run
cancellation (that is the entire purpose of those functions), so this
follows the same design as the already-shipped `if: always()` wake-dispatch
step.

**Verification caveat, stated explicitly rather than glossed over**: the
`cancelled()` extension was **not** independently re-verified with a live
throwaway-workflow probe the way `failure()`/`success()` were in the fourth
round. It follows by GitHub's documented design (the stated purpose of
`always()`/`cancelled()` is to run following steps despite cancellation) and
by analogy with `failure()`/`success()`'s already-verified same-job-only
scoping (all three are the same category of job/step-status function). This
is noted in the workflow comment and should be re-verified with a real probe
run if this fallback's cancellation-handling behavior is ever specifically
in question — the two `failure()`/`success()` empirical probes (run IDs
29467076748, 29467286711) already demonstrate that "GitHub's docs" alone are
an insufficient basis for these expressions' exact semantics.

Updated `tests/unit/merge-train-validate-publish.test.ts`:

- Both `if:` string assertions (recovery-app-token step, retryable-check
  step) updated to the new `(failure() || cancelled()) && (...)` string.
- The semantic eval test now injects a mock `cancelled()` function alongside
  `failure()` and covers two additional cases: same-job cancellation of
  app-token or publish → must fire; hypothetical `cancelled()` true with
  both outcomes still `success` → must still not fire (same
  defense-in-depth principle as the `failure()`-true/both-`success` case).

Test counts unchanged (24 = 19 + 5) — extended existing test bodies, no new
test cases added.

## Sixth round follow-up (reconciling an independent recovery-mint guard)

While pushing the fifth-round fix, an independently-landed autonomous
agent-merge commit (`fad5097f`) added a `steps.recovery-app-token.outcome ==
'success'` clause to the retryable-check fallback step's condition: if the
recovery-mint step itself fails (e.g. the same transient GitHub Apps auth
error that hit the original mint also hits the recovery attempt), there is no
valid App-authored token to call `checks.create` with, so attempting the
retryable-check step would just waste an attempt and produce a confusing
secondary failure instead of a clean, diagnosable no-op.

Reconciled this with the fifth round's `cancelled()` work (the two changes
had landed on divergent commits). **Final condition on the downstream
"Mark candidate check retryable" step** (the recovery-mint step's own
condition, shown further down, omits the self-referential
`recovery-app-token.outcome` clause since it cannot check its own outcome):

```
(failure() || cancelled()) && steps.recovery-app-token.outcome == 'success'
  && (steps.app-token.outcome == 'failure'
      || steps.app-token.outcome == 'cancelled'
      || steps.publish.outcome == 'failure'
      || steps.publish.outcome == 'cancelled')
```

Note: the "Generate recovery app token" step itself is **not** gated on its
own outcome (it can't be — nothing mints its replacement), only the
downstream "Mark candidate check retryable" step is. Verified the guard
remains reachable after a genuine app-token/publish failure or cancellation
(the recovery mint independently succeeds in the common case), correctly
suppresses the retryable-check step when the recovery mint itself fails or is
cancelled, and does not reinstate the fourth round's implicit-`success()`
dead-code trap (the guard is ANDed alongside the already-verified
`failure() || cancelled()` prefix, not in place of it). Added one new
semantic-eval test case (recovery-mint failure with a genuine app-token
failure → fallback must not fire). Test counts: 24 (19 + 5), same file counts
as the fifth round — one existing test body extended, no new `it()` blocks.

**Correcting earlier round narratives above**: the "Follow-up fix" /
"Second follow-up fix" prose in the Summary (originally written after the
first shepherd round) and the "Second shepherd-round follow-up" section both
describe the retryable-check and recovery-token-mint steps as gated on plain
`if: failure()`. That was accurate for the commit each section documents at
the time, but is now stale relative to the shipped workflow. The actual,
final conditions are: "Generate recovery app token" (the recovery-mint step)
uses `(failure() || cancelled()) && (steps.app-token.outcome == 'failure' ||
steps.app-token.outcome == 'cancelled' || steps.publish.outcome == 'failure'
|| steps.publish.outcome == 'cancelled')`; the downstream "Mark candidate
check retryable" step uses that **same** expression **plus** an additional
`steps.recovery-app-token.outcome == 'success'` clause (it cannot self-gate,
so only the downstream step adds it), arrived at across the
third/fourth/fifth/sixth rounds. Treat this section, "Files touched", and the
workflow's own inline comments as the
authoritative current state; earlier round sections are a historical record
of how the condition evolved, not the shipped behavior.

## Seventh round follow-up (accepted-but-response-lost check-masking guard)

A `copilot-pull-request-reviewer` finding on the retryable-check fallback:
"Publish immutable candidate result"'s `checks.create` call can succeed
server-side (a genuine terminal `success`/`failure` check is durably
persisted) while the step itself still reports `failure`/`cancelled` to the
runner — e.g. the HTTP response confirming the create was lost to a
transient network error, or the job was cancelled in the narrow window
between the request completing and the step returning. Since
`trainCheckState()` (`.github/scripts/merge-train/state.mjs`,
`latestChecksByName`) always selects the **highest-ID** check run matching
name + `external_id` + trusted app id, the retryable-check fallback blindly
creating a _second_, newer `cancelled` check with the same fingerprint would
mask the already-persisted, genuinely correct terminal result — causing
reconcile to redispatch validation on a candidate that had actually already
finished (success or failure), instead of correctly bisecting a real
failure.

Fix: before creating the `cancelled` check, the fallback script now calls
`github.rest.checks.listForRef` (filtered by `ref: CANDIDATE_SHA`,
`check_name: 'merge-train-candidate'`) and checks whether any returned run
already matches this fingerprint (`external_id === FINGERPRINT`), is from the
trusted app (`Number(run.app?.id) === Number(APP_ID)`), and is
`status: 'completed'` with a genuine terminal `conclusion` (`success` or
`failure`). If so, the script returns early as a no-op instead of creating a
new check — the real terminal result is left untouched. This check runs on
every retry attempt (inside the existing `[0, 1000, 2000]`ms retry loop), not
just once, so it also self-heals if the real check only becomes visible via
the API on a later attempt. Added `APP_ID: ${{ secrets.APP_ID }}` to the
step's `env:` so the trusted-app-id comparison has something to compare
against (the same secret already used to mint both App tokens in this job).

Updated `tests/unit/merge-train-validate-publish.test.ts`:

- Both existing script-execution tests (`posts a cancelled conclusion...`,
  `retries transient check publication failures...`) now mock
  `github.rest.checks.listForRef` returning an empty `check_runs` array (no
  existing check), and set `process.env.APP_ID` so the added lookup path
  doesn't change their existing pass/fail behavior.
- New test: **does not overwrite an already-persisted terminal check
  (accepted-but-response-lost race)** — mocks `listForRef` returning a
  `status: 'completed'`, `conclusion: 'success'` run matching the fingerprint
  and app id, and asserts `checks.create` is never called.
- New test: **does create the cancelled check when an existing check for the
  fingerprint is not yet terminal (still in_progress)** — mocks `listForRef`
  returning a `status: 'in_progress'` run for the same fingerprint, and
  asserts `checks.create` **is** still called (an in-progress check is not a
  reason to skip — only a genuine completed success/failure result is).

Test counts: 26 (24 + 2 new `it()` blocks). Ran
`npx vitest run tests/unit/merge-train-validate-publish.test.ts
tests/unit/merge-train-workflow-wakeups.test.ts` — 26/26 passed.

Also fixed a minor doc-accuracy nit flagged in the same review round: this
handoff previously implied (in the "Third shepherd-round follow-up" and
"Fourth round" sections' prose, before the sixth round's correction above)
that both fallback steps require `steps.recovery-app-token.outcome ==
'success'`. The sixth round's correction already clarifies this is only true
of the "Mark candidate check retryable" step, not "Generate recovery app
token" itself (which cannot gate on its own outcome) — no further edit
needed here beyond confirming that correction is present and accurate.

## Eighth round follow-up (diagnostic wording + repeated "both steps" phrasing)

A further `copilot-pull-request-reviewer` pass on the seventh-round push
caught two more accuracy issues, both fixed here:

1. **Workflow diagnostic wording** (`merge-train-validate.yml`, the
   `checks.create` call in "Mark candidate check retryable"): the posted
   check's `output.title`/`summary` said "publish step failed", but when the
   original App-token mint itself fails/is cancelled, the `publish` step is
   **skipped** (via its `needs`/`if` chain), not failed — so that wording
   misdescribes the actual trigger in the token-mint-failure path. Reworded
   to "token mint or result publication failed" / "Either the App-token mint
   or the 'Publish immutable candidate result' step failed/was cancelled…" to
   cover both real trigger paths accurately. No test asserted the exact
   previous string, so no test changes were needed.
2. **Repeated "both fallback steps" phrasing**: three more spots (the
   "Files touched" entry for `merge-train-validate.yml`, the sixth round's
   "Final condition on both fallback steps" heading, and its "Correcting
   earlier round narratives" closing paragraph) all stated or implied that
   the combined `(failure() || cancelled()) && steps.recovery-app-token.outcome
== 'success' && (...)` expression applies to **both** the recovery-mint
   step and the downstream retryable-check step. As already established in
   the sixth round's own correction (just not consistently carried through
   to these three other spots), only the downstream "Mark candidate check
   retryable" step has the `recovery-app-token.outcome == 'success'` clause —
   the recovery-mint step itself cannot self-gate. Reworded all three spots
   to state the two steps' conditions separately rather than imply a single
   shared combined condition.

No code/test changes for finding 2 (doc-only). Re-ran
`npm run review:ledger -- validate` and `npm run verify:fast` after both
fixes — both green.

## Ninth round follow-up (TOCTOU race in the seventh round's check-masking guard)

A further `copilot-pull-request-reviewer` pass on the eighth-round push found
a genuine remaining race in the seventh round's `listForRef`-based
check-masking guard: the lookup only narrows the window, it does not close
it. The original "Publish immutable candidate result" `checks.create` request
can still be in flight when the lookup runs (finding no terminal check yet),
and can land — persisting its genuine terminal result — _after_ the lookup
returns but _before_ this fallback step's own write. If that write were
another `checks.create` call (as the seventh round's fix used), it would
always mint a fresher/higher-ID check than whatever the in-flight request
persists next, so `trainCheckState()`'s highest-ID-wins selection would still
pick the wrong (fallback) check and mask the real result — exactly the bug
the seventh round set out to fix, just via a narrower path.

Fix (matching the reviewer's suggested design): when the `listForRef` lookup
finds an existing (non-terminal) check run matching this fingerprint + app,
the fallback step now **updates that same check run in place**
(`github.rest.checks.update({ check_run_id: existingRun.id, ... })`) instead
of creating a new one — preserving its original, older ID. If the in-flight
original request then lands afterwards, its `checks.create` call mints a
genuinely new, higher-ID check, which correctly wins over this in-place
`cancelled` update under `trainCheckState()`'s selection rule. Only when no
matching check run exists at all (the very first check for this candidate
somehow hasn't been created yet) does the step fall back to `checks.create`
— there is nothing to update in that edge case, and this narrower residual
window is called out honestly in the workflow comment rather than claimed as
fully closed, since the Checks API has no atomic create-if-absent primitive.

Updated `tests/unit/merge-train-validate-publish.test.ts`:

- The existing "does not overwrite an already-persisted terminal check" test
  now also mocks `checks.update` and asserts it is **not** called (in
  addition to `checks.create` not being called) when a terminal check already
  exists.
- Renamed/rewrote the in-progress-check test to **updates the existing
  in_progress check run in place (preserving its ID) instead of creating a
  new one** — mocks `listForRef` returning an `in_progress` run with `id:
777`, and asserts `checks.update` is called with `check_run_id: 777` and
  `conclusion: 'cancelled'`, while `checks.create` is **not** called.

Test counts unchanged at 26 (21 + 5) — this round changed existing test
bodies/assertions to match the update-in-place behavior; no new `it()` blocks
were added. Ran `npx vitest run tests/unit/merge-train-validate-publish.test.ts
tests/unit/merge-train-workflow-wakeups.test.ts` — 26/26 passed.

Also corrected a separate stale-metadata finding from the same review round:
this "Verification" section previously said "24/24 passed (19 + 5)" from an
earlier round; updated to the current accurate "26/26 passed (21 + 5)". The
PR description had the same stale numbers and round count; resynced
separately alongside this handoff update.

The ninth round's fix left one edge case of its own change untested, and a
further `copilot-pull-request-reviewer` pass found two more issues on top of
that:

1. **`PRRT_kwDOSvo2Ms6RUGDX`** (residual race in the terminal-result guard):
   even with the ninth round's update-in-place fix, the narrow "no matching
   check run found at all" branch still calls `checks.create` after only a
   single `listForRef` read. If that read races a genuine terminal check that
   has _just_ been persisted server-side but is not yet visible to this read
   (a read-after-write visibility-lag scenario, distinct from the original
   in-flight-request race the ninth round closed), this step could still fall
   to `checks.create` unnecessarily. In practice this branch should be nearly
   unreachable -- the very first `in_progress` check for a candidate is always
   created by `reconcile.mjs` before this workflow is even dispatched, so
   `listForRef` should essentially always find at least that check to update
   -- but the reviewer's point that "no match on the first read" should be
   treated as provisional, not conclusive, is valid hardening. Fixed by
   factoring the lookup into a `findMatch()` helper and, when the first read
   finds no matching check at all (not even a non-terminal one to update),
   waiting 500ms and re-listing once more before finalizing the decision to
   `create`. This shrinks (but, as documented in the workflow comment, cannot
   fully eliminate -- the Checks API has no atomic create-if-absent primitive)
   this last, much narrower residual window.
2. **`PRRT_kwDOSvo2Ms6RUGDo`** (PR description Files list incomplete): the
   description's Files section only listed the files this session directly
   touched, omitting several files the coordinator's concurrent automation
   had added to the same branch -- `docs/knowledge/handoffs/2026-07-16-tighten-wake-token-assert.md`,
   `docs/knowledge/review-ledgers/2026-07-16-pr1168-final-thread-recovery.review-ledger.json`,
   `docs/knowledge/review-ledgers/2026-07-16-tighten-wake-token-assert.review-ledger.json`,
   and `docs/knowledge/metrics/guard-telemetry/2026-07-16-merge-train-wakeup-gaps.json`.
   Resynced the PR description's Files list to the full `git diff --name-only`
   output against the merge base, and added a short "Follow-up" bullet to the
   Summary describing the concurrently-landed wake-token assertion tightening
   so the description accurately represents the whole diff, not just this
   session's edits.
3. **Concurrent test-coverage gap** (found and fixed independently, before the
   `findMatch()` re-list hardening above landed): the `checks.update`-in-place
   logic added in the ninth round only fires when `listForRef` finds an
   existing non-terminal matching check run; the "no match at all" `create`
   fallback path itself had no test asserting it still fires when
   `listForRef` returns an empty `check_runs` array on every read.

Also confirmed (`PRRT_kwDOSvo2Ms6RUBDO`, same diagnostic-wording complaint as
the eighth round's `3sH` finding) that the reworded `output.title`/`summary`
already landed in that round fully addresses this -- no further wording
change needed.

Updated `tests/unit/merge-train-validate-publish.test.ts` with 3 new tests
total (2 for the `findMatch()` re-list hardening, 1 for the always-empty
create-fallback coverage gap):

- **re-lists once after a short delay when no matching check is found on the
  first read, and updates in place if one appears** -- mocks `listForRef` to
  return an empty list on the first call and an `in_progress` match on the
  second, asserts `checks.update` is called with the right `check_run_id` and
  `checks.create` is not called.
- **re-lists once after a short delay and skips as a no-op if the genuine
  terminal check becomes visible on the second read** -- mocks `listForRef` to
  return empty first, then a `completed`/`failure` match second, asserts
  neither `checks.create` nor `checks.update` is called.
- **falls back to creating a new check only when no matching check-run
  exists at all yet, even after the residual-race re-list** -- mocks
  `listForRef` to always return an empty list (both reads), asserts
  `checks.create` is called exactly once and `checks.update` is not called.

Test counts: **29 (24 + 5, up from 26 = 21 + 5)**. Ran
`npx vitest run tests/unit/merge-train-validate-publish.test.ts
tests/unit/merge-train-workflow-wakeups.test.ts` -- 29/29 passed. Re-ran
`npm run verify:fast` -- passed.

## Eleventh round follow-up (complete and authoritative recovery lookup)

A final review of the update-in-place recovery found two coupled gaps:

1. `checks.listForRef` still used GitHub's default 30-result page. A matching
   trusted check beyond that page could be missed, incorrectly taking the
   `checks.create` fallback and reopening the masking race.
2. `findMatch()` returned `matching[0]`, but the API's array order is not the
   repository's authoritative selection rule. `trainCheckState()` resolves
   duplicate matching checks by highest check-run ID, so updating an older
   cancelled run could leave a newer in-progress run authoritative and keep
   reconciliation parked.

Fixed by requesting `per_page: 100` on every lookup (including the visibility-
lag re-list) and reducing trusted fingerprint matches to the highest numeric ID
before `checks.update`. Extended the existing update-in-place test without
adding a new test case: it returns older cancelled ID 700 before newer
in-progress ID 777, asserts ID 777 is updated, and asserts the lookup requests
100 results. The previous `matching[0]` implementation fails this regression.

Separate-model review (`claude-sonnet-4.6`) found no significant issues and
confirmed terminal success/failure preservation and the no-match create
fallback remain sound. Targeted tests remain **29/29 passed (24 + 5)**.

## Twelfth round follow-up (strip head_sha from the update call)

`copilot-pull-request-reviewer` (`PRRT_kwDOSvo2Ms6RUK5b`) found that the
update-in-place fallback still spread the _entire_ create-style `payload`
into `checks.update()`, including `head_sha`. Per the GitHub REST API
reference, `head_sha` is accepted only by `POST
/repos/{owner}/{repo}/check-runs` (create) -- it is **not** a documented body
parameter for `PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}`
(update). Sending it risked a 422 on every retry, which would leave the
original check stuck `in_progress` for the full stale-timeout window instead
of being corrected immediately -- silently defeating the very race-hardening
this step exists to provide.

Fixed by destructuring `head_sha` out of the shared payload before the
update call: `const { head_sha, ...updatePayload } = payload;` then
`checks.update({ ...updatePayload, check_run_id })`. The `checks.create()`
call in the `else` branch is untouched and still receives the full payload
(where `head_sha` is required).

Extended both existing update-path tests (direct-match and
visibility-lag-re-list) with assertions that `updateArgs.head_sha` is
`undefined` **and** that the key itself is absent from the update call's
arguments object (`Object.prototype.hasOwnProperty.call(updateArgs,
'head_sha')` is `false`) -- so a regression that re-adds `head_sha` to the
update path (even as an explicit `undefined`-valued key, which Octokit could
still serialize) fails deterministically rather than passing on a loose
`toBeUndefined()`-only check.

Ran `npx vitest run tests/unit/merge-train-validate-publish.test.ts
tests/unit/merge-train-workflow-wakeups.test.ts` -- 29/29 passed (test count
unchanged; two existing tests gained assertions rather than new tests being
added, since the same mock call site now covers both concerns). Re-ran
`npm run verify:fast` -- passed.
