# Session Handoff: Build-Expiry Merge Train

## Date

2026-07-14

## Persona

Producer -> DevOps Engineer

## Systems touched

ci-policy

## Apples

4 apples estimated, 4 apples actual

## What Was Done

- Replaced independent PR competition with an oldest-first six-slot recovery
  scheduler and a six-PR repository-managed train.
- Bound readiness to immutable PR-head checks and review state without expiring
  that evidence whenever `main` advances.
- Limited rebases to real merge conflicts and returned conflict/validation
  failures to recovery instead of repeatedly rewriting clean branches.
- Added cumulative candidate construction, fast plus targeted-security
  validation, prefix bisection, maximal-green-prefix promotion, and exact-SHA
  provenance.
- Suppressed managed-comment feedback loops and post-promotion reruns using a
  successful exact-SHA check attestation rather than a spoofable commit footer.
- Moved broad functional health validation to hourly `main` CI while preserving
  PR-head validation and preventing scheduled CI from deploying.
- Preserved all legacy auto-merge and blanket-rebase behavior while
  `MERGE_TRAIN_ENABLED=false`.
- Leased conflict-only rebases to the exact expected PR head and added bounded
  retry/recovery when a rebase job fails without changing that head.
- Made cumulative-conflict blocks self-healing when their predecessor leaves
  the train, and routed already-applied/no-op PRs through an explicit recovery
  path instead of stranding them.
- Bound promotion suppression to both a SHA-256 train fingerprint and the
  repository App identity that produced the check run.
- Bound candidate-validation results to the exact candidate fingerprint and
  repository App identity, with App-authenticated publication isolated from
  the job that executes candidate code.
- Moved auto-rebase PR triggers to trusted `pull_request_target` workflow code
  with an explicit default-branch checkout so PR-authored workflow changes
  cannot access the repository App key.
- Added flag-off label cleanup, trusted-promotion-only `main` CI suppression, a
  red-hourly-CI promotion circuit breaker, final pre-push reattestation, and a
  bounded post-promotion assertion that GitHub recorded every included PR as
  merged.

## Key Decisions Made

- `MERGE_TRAIN_ENABLED` is the only rollout switch for the coordinated behavior.
- Six active recovery owners count against the repair window; ready PRs leave
  that window and enter the train.
- Candidate validation runs `verify:fast` and `security:check`, not headless,
  E2E, coverage, or the full verification gauntlet.
- Non-monotonic prefix results advance from the longest validated prefix, and
  promotion moves every included PR head plus `main` in one atomic push.
- Only the PR represented by a synchronize event receives that trigger; other
  PRs admitted by the same sweep receive a neutral sweep trigger.

## Validation

- Automation harness (`.github/scripts/ci-recovery/*.test.mjs` +
  `.github/scripts/merge-train/*.test.mjs`): as of the fifth-wave pass below,
  120 tests total; 99 passed and up to 21 explicitly skipped for the known
  Windows `UV_HANDLE_CLOSING` subprocess shutdown assertion (skip count
  varies per run since the underlying libuv race is non-deterministic); 0
  failed. Linux CI executes every subprocess assertion strictly, since the
  skip is gated on `process.platform === 'win32'`. This is the authoritative,
  most-recent count; see the wave-by-wave notes below for how it evolved
  (91/77/14 -> 110/92/18 -> 114/95/19 -> 120/99/21) as each review pass added
  regression coverage — do not cite an earlier figure as current.
- `npm run verify:fast` passed.
- The 4-apple adversarial plan review, two-round code-review loop, and
  two-round multi-model review completed with all valid findings resolved.

## Third-wave Copilot review pass (independent-model validation)

An independent (non-primary-model) validation pass addressed the third wave
of 12 unresolved Copilot review threads:

- **Rollback completeness**: the rollback doc now requires removing
  `merge-train` from `main`'s required status checks (with a `gh api` example)
  before/alongside flipping `MERGE_TRAIN_ENABLED=false`, and clarifies that
  CI-recovery/auto-rebase resumption of freshness ownership is already
  automatic once the flag flips.
- **Flag-off cleanup starvation**: `router.mjs` now prioritizes PRs still
  carrying a train-owned label (`merge-train`, `merge-train-blocked`,
  `merge-train-noop`, `merge-train-validation-failed`) ahead of the
  `maxDispatchPerRun` cap during flag-off schedule sweeps, alongside any
  directly-triggered PR, so the flag-off cleanup sweep cannot strand an older
  labeled PR behind a backlog of newly-updated ones.
- **Stale handoff/PR metadata**: confirmed the authoritative local run
  (91 total / 77 pass / 14 skipped on Windows) matches this document and the
  PR description; no drift.
- **Main-health circuit breaker (current-SHA + fail-closed)**:
  `mainHealthAllowsPromotion()` now fetches the current `main` SHA explicitly,
  considers both scheduled and push-triggered CI runs (bounded lookback for
  push), excludes attested merge-train fast-path pushes, and fails closed
  (pauses promotion) whenever no full-CI evidence exists yet for the _current_
  `main` SHA, or that evidence is still pending — not just when a genuine
  failure is found.
- **Incident auto-close vs. train fast-path pushes**: `incident.mjs` fetches
  check-runs once per run and does not auto-close a real full-health incident
  on a train-promoted push success; it only closes on independently-verified
  non-fast-path CI success.
- **Bounded auto-rebase-failure retry/backoff**: an explicit
  `auto-rebase-failure` trigger for the still-current head now retries with
  exponential backoff (`60s * 2^(attempt-1)`, capped at 10 minutes, up to
  `REBASE_FAILURE_MAX_ATTEMPTS = 3`) instead of sitting idle until
  `REBASE_PENDING_TIMEOUT_MS` or escalating immediately.
- **Promotion-check shortcut gating**: the `ci.yml` and
  `security-review.yml` promotion-attestation shortcuts now require the exact
  string `vars.MERGE_TRAIN_ENABLED == 'true'`, so flipping the flag to false
  restores full CI/security-review execution on every PR instead of leaving a
  latent shortcut active.
- **Bisection reattestation before mutation**: the bisection-failure path in
  `merge-train/reconcile.mjs` now re-fetches the live `main` SHA and the live
  failing PR immediately before calling `blockEntry()`, and reuses the
  existing `promotionStaleReason()` check to detect staleness (main moved,
  head changed, no longer open, etc.) — including when `greenPrefixLength`
  is `0` — so a stale bisection result cannot mutate/label a PR that no
  longer matches the attested evidence; the next sweep rebuilds instead.
- **Concurrent-session reconciliation**: this pass discovered that another
  session (primary model) had independently pushed
  `cfc71f6cab3d1aa8b96d6709c8cd676c7e80fdb3` addressing the same threads
  (flag-off cleanup, rebase backoff, and a partial main-health fix) while this
  validation was in progress. Rather than force-pushing over it, the two were
  reconciled: the primary session's simpler/equivalent flag-off-cleanup fix
  and its exponential-backoff rebase-retry fix were kept as-is (verified
  correct and adopted); its main-health fix was completed, because it did not
  match current-`main`-SHA evidence and still failed _open_ on missing
  evidence, both required by the review thread.
- Automation harness after reconciliation: 110 tests total, 92 passed, 0
  failed, 18 skipped (same known Windows-only libuv teardown flake pattern).
  `npm run verify:fast` passed again after reconciliation.
- **Post-push typecheck fix**: the non-blocking `Advisory checks` CI job
  (`continue-on-error: true`, not in `merge-gate`'s required `needs`) surfaced
  a real `tsc --noEmit` failure that `verify:fast`'s lighter typecheck path
  did not catch: `tests/unit/merge-train-promotion-gate.test.ts` indexed a
  `Record<string, string>` with `match[1]`/`match[2]` from a regex match,
  which `noUncheckedIndexedAccess` types as `string | undefined` (TS2538).
  Fixed by destructuring into optional locals and guarding both are defined
  before assignment; no behavior change. Re-verified full `npm run typecheck`
  is clean, the test file's 5/5 tests still pass, and the ci-recovery/
  merge-train mjs suite is unchanged at 110/92 pass/0 fail/18 skipped.

## Fourth-wave Copilot review pass (independent-model validation)

Another independent (non-primary-model) validation pass, using yet a third
distinct model as reviewer, addressed the fourth wave of 5 unresolved
Copilot review threads:

- **Main-health deadlock emergency lane (design decision, no new code)**:
  the review asked whether a hourly main-health failure could deadlock
  PR-based repair, since promotion is paused (by design) whenever `main` is
  red, and repair itself lands through the paused train. Two options were
  weighed: (a) build a bounded in-train "recovery lane" that lets a repair
  candidate promote onto red `main` under some narrower validation, or (b) a
  purely documented flag-off fallback using the mechanisms that already
  exist. Option (a) was rejected: any in-train logic that decides "it's safe
  to promote onto red `main` anyway" is itself the unsafe bypass the task
  explicitly warned against — it would let arbitrary code merge while `main`
  is red, which is exactly the invariant `mainHealthAllowsPromotion()` exists
  to protect. Option (b) is sufficient because the legacy per-PR-gated
  auto-merge path is already the general rollback mechanism, is already
  fully automatic for freshness resumption once the flag flips (see the
  Rollback section above), and does not touch `main`-health evidence at all
  — it merges through the ordinary branch-protection path, not the train.
  `docs/guides/merge-train.md` gained a new "Emergency repair lane
  (main-health deadlock)" section spelling out the exact, ordered, complete
  steps: disable `MERGE_TRAIN_ENABLED`, remove `merge-train` from `main`'s
  required status checks (the same `gh api` step the Rollback section
  already documents), confirm CI-recovery/auto-rebase resume ordinary
  freshness (automatic, already true post-flip), let the repair PR merge via
  the ordinary legacy-gated path, confirm the resulting push-triggered full
  CI run on the new `main` is green, and only then re-add the required check
  and re-enable the flag. This does not weaken the normal health gate: the
  gate still fails closed for every other candidate the whole time; only the
  documented human-operated rollback sequence — already the repo's existing
  incident-response tool — is being used, exactly as designed.
- **Merge-train promotion provenance trust gate (incident.mjs:129)**:
  `incident.mjs`'s own promotion-provenance filter (surfaced in an incident
  issue body for `@copilot` to read) was a hand-rolled duplicate of the
  canonical `isTrustedTrainPromotionCheck()` gate that omitted the
  `status === 'completed' && conclusion === 'success'` requirement. An
  in-progress or failed check-run named `merge-train` from the trusted App
  with a valid fingerprint would have been accepted and its (possibly
  stale/misleading) `output.summary` text surfaced as if it were confirmed
  promotion evidence. Fixed by importing and reusing
  `isTrustedTrainPromotionCheck()` from `ci-recovery/state.mjs` instead of
  re-implementing the check inline, so the two call sites cannot drift again.
  New regression tests cover both an in-progress and a failed `merge-train`
  check being excluded from the "## Merge-train promotion provenance"
  section, alongside the existing genuine-provenance case.
- **Scheduled CI cascade-skip gap (deploy.yml:38)**: `baseline-sweep` had
  `needs: deploy` and its own `if:` that only checked
  `workflow_run.conclusion == 'success'`. GitHub Actions does NOT
  cascade-skip a job with an explicit `if:` just because a `needs`
  dependency was skipped (that only happens for the default/unset condition,
  or an expression that itself checks `success()`/`needs.deploy.result`).
  Verified empirically against this repo's own run history (an all-skipped
  workflow run reports overall conclusion `skipped`, confirming the
  underlying premise) and against `git log` for the PR's own history (the
  push-only guard was added to `deploy` but never mirrored onto
  `baseline-sweep`). Net effect: an hourly `schedule`-triggered `CI` success
  would have run a real, costly (~2h) 100-seed baseline sweep, and because
  it was the only job that ran, the overall "Deploy to GitHub Pages" run
  would report `success` — which `ci-recovery-incidents.yml`/`incident.mjs`
  could misread as genuine deploy evidence and use to auto-close a real open
  deploy incident. Fixed by making `baseline-sweep`'s `if:` byte-identical to
  `deploy`'s (`workflow_dispatch` OR `(conclusion == 'success' && event ==
'push')`). A new `tests/unit/deploy-workflow-gating.test.ts` parses the
  real YAML and asserts the two conditions stay identical, so a future edit
  to one without the other is caught even if the wording changes.
- **Fast-path classifier ignoring the rollout flag (incident.mjs:66)**:
  `isTrainFastPathSuccess` only checked `run.event`, `run.name`, and the
  presence of a trusted `merge-train` check-run — never
  `MERGE_TRAIN_ENABLED`. Because check-runs persist on a commit forever, a
  SHA that once carried a genuine fast-path promotion still carries that
  check-run after a flag-off rollback. A later genuine full-CI rerun on that
  same SHA (e.g. a forced re-run after rollback) would have been
  misclassified as a fast-path shortcut and silently skipped auto-close,
  even though it is real, independently-verified full-CI evidence. Fixed by
  threading the exact-match `MERGE_TRAIN_ENABLED` flag (via the existing
  `parseEnabledFlag()` helper, already used by `ci.yml`/
  `security-review.yml`) into `incident.mjs` and requiring it to be `true`
  as the first condition of `isTrainFastPathSuccess`. `MERGE_TRAIN_ENABLED`
  was also added to the `ci-recovery-incidents.yml` step env so the flag is
  actually visible to the script. Because `parseEnabledFlag()` defaults an
  unset/empty value to `false` and rejects any non-exact `'true'`/`'false'`
  string outright (fail-fast, not silently coerced), this is safe even
  though the workflow previously never passed the variable at all. New
  regression tests cover: a stale trusted check with the flag unset must
  still allow the incident to auto-close normally (rollback scenario), and a
  malformed flag value (`'True'`) must fail fast rather than default
  silently.
- **Stale handoff/PR test counts (this file, line ~72)**: this document's
  top-level "## Validation" section still read the wave-1 figures
  (91 total / 77 pass / 14 skipped) even though the third-wave section
  further down already recorded 110/92/18 after reconciliation, and the PR
  description already carries the 110/92/18 figures. Reconciled: the
  "## Validation" section now cites the current authoritative count
  (114/95/0/19, see below) and explicitly notes the wave-by-wave progression
  so a future reader does not cite an outdated figure. No PR-body edit was
  needed for the stale-count part itself (already correct); the PR body's
  fourth-wave summary bullet was still added separately for this wave's
  changes.
- **Design-review note (thread 1, recorded per task instruction)**: the
  emergency-repair-lane rationale above was written into
  `docs/guides/merge-train.md` verbatim as the "Emergency repair lane" runbook
  section and is restated here for handoff-doc auditability; the independent
  reviewer's conclusion was that the documented flag-off fallback is
  sufficient and that adding autonomous in-train repair-promotion code would
  itself create the unsafe bypass the task warned against.
- Automation harness (ci-recovery + merge-train mjs suite) after this wave:
  114 tests total, 95 passed, 0 failed, 19 skipped (net +4 tests: the
  existing train-fast-path test now pins `MERGE_TRAIN_ENABLED: 'true'`
  explicitly, plus 3 new regression tests for the flag-rollback,
  malformed-flag, and provenance-exclusion scenarios above). Full
  `npm run typecheck` is clean (new `tests/unit/deploy-workflow-gating.test.ts`
  included). `npm run verify:fast` passed.

## Fifth-wave Copilot review pass (independent-model validation)

A fifth independent (non-primary-model) validation pass addressed the fifth
wave of 5 unresolved Copilot review threads:

- **Dead code (merge-train/reconcile.mjs:46)**: `FINGERPRINT_SHAPE` was
  declared and never referenced anywhere in the file (which has no exports).
  Removed outright; no behavior change, no test needed for a deletion of
  unreachable code.
- **Main-health TOCTOU at final promotion (merge-train/reconcile.mjs:421)**:
  `mainHealthAllowsPromotion()` was only checked once, at the top of
  `promotePrefix()`, before the sequential per-PR reads/eligibility checks
  that follow it. A scheduled or push-triggered CI run for `main` can start
  and go pending/red while those reads are in flight, so the initial guard
  alone could not prove `main` was still healthy at the moment the required
  check was published and the atomic push happened. Fixed by adding an
  optional `reattestHealth` callback to `promoteExactCandidate`/
  `promoteExactBatch` (`reconcile-lib.mjs`), invoked immediately after the
  final per-PR reattestation loop and immediately before publishing the
  required check / pushing — the same trusted, token-authenticated
  `mainHealthAllowsPromotion` function already used for the initial guard is
  wired in at the one real call site (`reconcile.mjs`'s `promotePrefix()`),
  so there is no new or unauthenticated shortcut. Three new
  `reconcile.test.mjs` unit tests cover: a health transition between the
  final PR read and the push blocking that push/check-publish (asserting
  call order: last `fetchCurrentPr` -> `reattestHealth` -> no push/check),
  a healthy re-attestation still proceeding, and the default (omitted
  callback) still behaving as healthy for existing call sites.
- **Auto-rebase backoff not honored by scheduled sweeps
  (ci-recovery/reconcile.mjs:447)**: the 60/120/240s exponential backoff
  (bounded at `REBASE_FAILURE_MAX_ATTEMPTS`) was only evaluated when
  `trigger === 'auto-rebase-failure'`. Any other trigger — in particular the
  10-minute `schedule` sweep — fell into a separate branch gated by a flat
  15-minute `REBASE_PENDING_TIMEOUT_MS`, so a scheduled sweep observing a
  pending retry ignored the intended short cadence, and (worse) once that
  15-minute window elapsed the dispatch branch for non-`auto-rebase-failure`
  triggers had no bound against `REBASE_FAILURE_MAX_ATTEMPTS` at all — an
  unbounded retry fan-out risk. Fixed by keying `rebaseFailureBackoffActive`
  purely off the persisted `state.attempt`/`state.updatedAt` (trigger-
  agnostic) and adding an explicit `rebaseRetryAttemptsExhausted` bound that
  gates the dispatch branch for every trigger, not just
  `auto-rebase-failure`. The now-dead `REBASE_PENDING_TIMEOUT_MS` constant
  and `rebaseDispatchTimedOut` variable were removed. Two new
  `reconcile.test.mjs` subprocess tests prove the 60s cadence is real for a
  `schedule` trigger (redispatches once elapsed instead of waiting for the
  old 15-minute mark; waits while still inside the window), and a third
  proves bounded attempts hold for `schedule` too (no redispatch — and no
  infinite fan-out — once `REBASE_FAILURE_MAX_ATTEMPTS` is reached, even
  though the persisted state is still well inside the old flat timeout).
- **Verify-result collapse in candidate publish
  (merge-train-validate.yml:62)**: the "Publish immutable candidate result"
  step computed `PASSED: needs.verify.result == 'success'` and mapped
  `passed ? 'success' : 'failure'`, collapsing `cancelled`/`skipped` (and a
  timed-out job, which GitHub Actions also reports as `cancelled`) into
  `'failure'`. `trainCheckState()` treats a `cancelled` conclusion as
  `'missing'`/retryable but any other non-success conclusion as a genuine
  candidate defect that triggers bisection — so an infrastructure
  cancellation or a superseded/skipped run would have wrongly kicked off
  bisection instead of a simple retry. Fixed by passing the raw
  `needs.verify.result` string and mapping it explicitly:
  `success` -> `success`, `failure` -> `failure`, anything else -> `cancelled`.
  The App-authenticated (`actions/create-github-app-token@v1`) publish step
  is unchanged. New `tests/unit/merge-train-validate-publish.test.ts` parses
  the real workflow YAML, extracts the actual `with.script` text (no
  reimplementation), and executes it with a stubbed
  `github.rest.checks.create`, asserting the mapping for `success`,
  `failure`, `cancelled`, `skipped`, and an unrecognized value (fail-safe to
  `cancelled`), plus that the `github-token` wiring stays App-authenticated.
- **Unsafe rollback ordering (docs/guides/merge-train.md:106)**: the
  Rollback section instructed removing `merge-train` from `main`'s required
  status checks _before_ disabling `MERGE_TRAIN_ENABLED` — a fail-open
  ordering: between the two steps the train is still enabled but no longer
  gated by branch protection, so a PR could merge before anything actually
  validated it. The Emergency repair lane section (added in the fourth wave)
  already had the correct order. Fixed by swapping the Rollback section's
  step order to match: disable the flag first (documented as fail-closed —
  nothing publishes the still-required `merge-train` check once the train
  stops, so every PR is safely blocked), then remove the required check to
  resume the legacy path. New
  `tests/unit/merge-train-doc-rollback-ordering.test.ts` parses the real doc
  text and asserts both the Rollback and Emergency repair lane sections
  disable the flag strictly before removing the required check, so a future
  edit that reintroduces the unsafe ordering in either section is caught.
- Automation harness (ci-recovery + merge-train mjs suite) after this wave:
  120 tests total, 99 passed, 0 failed, 21 skipped (net +6 tests: 3 new
  `reconcile.test.mjs` (merge-train) tests for `reattestHealth`, 3 new
  `reconcile.test.mjs` (ci-recovery) tests for schedule-sweep backoff/bound;
  2 of the 3 new ci-recovery tests are skipped on this Windows host under
  the same known `UV_HANDLE_CLOSING` subprocess-shutdown exemption already
  used by pre-existing `live`-mode subprocess tests in that file — Linux CI
  runs them strictly). New `tests/unit/merge-train-validate-publish.test.ts`
  (6 tests) and `tests/unit/merge-train-doc-rollback-ordering.test.ts`
  (3 tests) both pass under `vitest`. Full `npm run typecheck` and
  `npm run lint` (`src/ tests/ scripts/`) are clean. `npm run verify:fast`
  passed.

## What's Next / Blockers

- Merge this PR with `MERGE_TRAIN_ENABLED=false`.
- Confirm the repository App still has the existing exact-promotion branch
  bypass and that `merge-train` remains a required check.
- Set `MERGE_TRAIN_ENABLED=true`, dispatch the router/train once, and observe a
  bounded production window for repair-slot movement, candidate validation,
  promotion, conflicts, duplicate dispatches, and workflow failures.

## Retrospective

### Lessons Learned

- JavaScript function placement inside a nearby function can survive syntax
  checks while failing only on a rare state-machine branch; targeted lint and
  branch execution tests are required for workflow scripts.
- A commit-message footer is useful provenance for humans but is not a security
  attestation. Post-promotion suppression now requires a successful exact-SHA
  check run with an external fingerprint.

### Mistakes Made

A helper function was accidentally nested inside an outer function, bypassing
static analysis while silently breaking on a state-machine path that was not
covered by the existing test suite.

### Opportunities for Future Improvement

Build-expiry savings remain safe when heavy PR evidence is immutable and the
combined candidate receives a small integration plus security gate. Future
work should add branch-coverage tests for every state-machine path in merge
train workflow scripts to catch similar misplacements earlier.
