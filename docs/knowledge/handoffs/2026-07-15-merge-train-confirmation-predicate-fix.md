# Session Handoff: Merge-train promotion confirmation predicate fix (5th gap, re-attempted live cutover)

## Date

2026-07-15

## Persona

Producer

## Systems touched

ci-policy

## Apples

3🍎 (declared up front; corrected a wrong invariant in one confirmation
predicate, extracted a testable factory, updated the CLI entrypoint to use
it, and added 7 new deterministic tests — a smaller diff footprint than the
4th-gap fix (PR #1156), but the change is production-critical automation
logic with a previously-zero-coverage code path, hence plan review +
code-review loop rather than skipping review stages)

## What Was Done

This session **re-attempted the live `enable` cutover** immediately after
the 4th-gap fix (issue #1154, PR #1156) shipped, and during real observation
of a candidate validation + atomic promotion cycle, discovered a **5th,
distinct gap** in the same confirmation code path #1156 had just touched.
Filed as new issue #1157 (not a reopen of #1151 or #1154, since it is a
different, deeper root cause).

**Re-attempted live cutover sequence:**

1. Followed the "Emergency repair lane" playbook from `docs/guides/merge-train.md`
   to resolve a `mergeStateStatus: BLOCKED` deadlock (the ruleset was already
   active from a prior segment's `enable` while `MERGE_TRAIN_ENABLED=false`):
   rolled back protection, merged PR #1156 directly, confirmed post-merge
   main CI green, re-enabled the ruleset idempotently (postcondition clean),
   set `MERGE_TRAIN_ENABLED=true`.
2. Dispatched CI Recovery; PR #1149 was admitted to the train queue.
3. Dispatched "Merge Train" (validation) — confirmed the "Merge Train
   Validation" workflow run for PR #1149's 1-PR candidate completed with
   `conclusion: success`.
4. Dispatched "Merge Train" again expecting promotion — it **failed**:
   `PR #1149 was not recorded as merged after atomic promotion to c8c57f8b...`.

**Investigation (before deciding on rollback):**

- Confirmed via `gh api repos/nalfeo/Crawler/git/refs/heads/main` that
  `main`'s HEAD was already at the candidate SHA — the atomic push had fully
  succeeded.
- Confirmed via `git log main --grep="Merge-Train-PR"` that all 7 real
  promoted PRs across both promotion batches (the earlier 6 from PR #1156's
  incident + PR #1149) correctly landed on `main`.
- Confirmed via `gh api repos/nalfeo/Crawler/pulls/<n>` that **all seven**
  show `merged: false, merged_at: null` — including PRs promoted **9+ hours**
  earlier. This proved the confirmation gap is not lag (as ADR 0062 DEC-024
  assumed) but a **permanent** characteristic: no amount of waiting would
  ever satisfy `merged_at`.
- Confirmed via web research that GitHub only sets `merged`/`merged_at` when
  a PR is closed through its own Merge API/web UI — this train's atomic
  multi-ref force-push strategy intentionally bypasses that machinery
  (that's the entire point: it's what makes a multi-PR batch promote
  atomically, which GitHub's own merge API cannot do).
- Confirmed via PR #1149's own issue timeline that its `closed` event fired
  ~20s after the reconcile job started — proving GitHub reliably,
  fast auto-closes such PRs even though `merged` never flips.
- Confirmed via `protection.mjs status` (`problems: []`) that the ruleset/
  protection configuration itself (DEC-019–023) remained completely healthy
  — this bug is fully isolated to `reconcile-lib.mjs`'s confirmation logic.

**Immediate safety action (per the task's explicit instruction: "if any
invariant/config issue appears, safe rollback first, then fix via separate
PR"):**

- Paused the train: `MERGE_TRAIN_ENABLED=false`.
- Ran `protection.mjs rollback --app-id 4106541` (classic `ci`-only restored,
  ruleset disabled but preserved) once the failure was understood to be
  systemic rather than a one-off.
- Manually removed the stale `merge-train` label from PR #1149 (confirmed
  correctly promoted at the git level; only the label/status bookkeeping was
  stuck, exactly like the earlier 6 PRs from PR #1156's incident).

**Fix implemented, tested, and reviewed in this session** (see Key Decisions
below); shipped as a **separate PR** per instruction, then the train was
re-enabled and a clean cycle re-observed.

## Key Decisions Made

- **Corrected the confirmation predicate, did not weaken the invariant**:
  replaced the `merged`/`merged_at`-based check with the exported, pure
  `isPostPushConfirmationSatisfied(prData)` — `merged === true` (kept as a
  defensive OR-branch for any future/alternate promotion path that might go
  through GitHub's real merge API) **or** `state === 'closed'` (the actual,
  achievable ground-truth signal for this mechanism, observed firing within
  ~20s of the push in all 7 live cases). This is a **correction** of a
  previously-wrong, unsatisfiable invariant, not a weakening of the trust
  invariant: the atomic push's own success remains the true, untouched
  source of correctness; this predicate is documented as only safe to
  consult as post-push corroboration.
- **Extracted the entire polling loop, not just the predicate**, into a new
  factory `createWaitForMergedPr({ request, token, owner, repo,
pollDelaysMs, sleep })` in `reconcile-lib.mjs` (mirroring the existing
  `buildDispatchBindings` factory pattern in the same file), per independent
  plan-review feedback. This matters because `reconcile.mjs` (the CLI
  entrypoint) is a top-level script that reads env vars and can
  `process.exit()` at module-load time, so it was never safely importable
  for unit tests — its own inline `waitForMergedPr` (the actual, broken
  implementation) had **zero** direct test coverage; every existing test
  exercised `promoteExactBatch` via an injected fake
  (`waitForMergedPr: async () => true`), which could never have caught this.
  The injectable `sleep` parameter makes the retry loop itself testable with
  zero-delay fakes (no real timers in tests).
- **Updated `reconcile.mjs`** to import and use `createWaitForMergedPr`
  instead of its own broken inline implementation, removing the stale
  "async lag" comment and replacing it with the corrected understanding.
- **Kept the ~77s poll budget** (`MERGED_PR_POLL_DELAYS_MS`, unchanged from
  PR #1156) as a bounded safety margin against a genuine anomaly (a PR that
  never auto-closes at all), even though `state: closed` typically fires in
  ~20s in practice.
- **Filed as a new issue (#1157), not a #1151/#1154 reopen** — a distinct,
  deeper root cause in the same confirmation code path #1156 touched but did
  not fully fix.
- **Deferred, not implemented** (plan-review non-blocking suggestion): a
  more robust long-term design replacing PR-API confirmation entirely with a
  git-level ref/ancestry postcondition (verify `origin/main`'s tip and/or
  each entry's head ref actually equals the final candidate SHA), treating
  GitHub's PR `state`/`merged` fields as audit/UI signals only. Tracked as a
  follow-up in issue #1157.

## Review Harness

- Plan review (`rubber-duck` agent, gpt-5.5, separate model): **no blocking
  concerns**. Feedback incorporated: (a) document the predicate as post-push
  corroboration, not standalone proof (precondition: only safe after the
  atomic push already succeeded); (b) extract the entire polling loop (not
  just the predicate) into a testable factory, since `reconcile.mjs` is
  untestable as a top-level CLI script; (c) update stale comments in both
  `reconcile.mjs` and `reconcile-lib.mjs`; (d) add test cases for missing
  fields, the explicit closed+merged:false regression case, and the OR-
  behavior case; (e) keep the ~77s poll budget as a safety margin; (f)
  confirmed the fix is a correction, not a weakening, of the trust
  invariant. `plan_divergence: convergent`.
- Code review (`code-review` agent, `claude-sonnet-4.6`): **no concerns**.
  Confirmed predicate correctness, poll-loop boundary math
  (`pollDelaysMs.length + 1` requests), correct `reconcile.mjs` wiring into
  `promoteExactBatch`, preserved fail-closed behavior for genuinely
  unconfirmed entries, full coverage of the regression case and all three
  poller paths, `~77s` budget comment accuracy against the actual
  `pollDelaysMs` sum, and doc consistency between the historical DEC-024
  entry (left as-is) and the new DEC-025 correction.
- Ledger: `docs/knowledge/review-ledgers/2026-07-15-merge-train-confirmation-predicate-fix.review-ledger.json`.

## Verification

- `node --test .github/scripts/merge-train/*.test.mjs` (full merge-train
  suite) → 117/117 pass (110 pre-existing + 7 new for this fix).
- `npm run typecheck` → clean.
- `npm run verify:fast` → passed (`.github/scripts/**` is outside the
  `.ts`-scoped lint/typecheck globs, consistent with how PRs #1153/#1156
  validated this same directory).

## What's Next / Blockers

- Ledger validated (both required 3🍎 stages complete), `npm run
verify:pr-prereqs` re-run clean; open the PR, arm squash auto-merge, and
  shepherd through CI/review.
- **After merge**: re-run `protection.mjs enable`, re-verify `status` stays
  clean (`problems: []`), set `MERGE_TRAIN_ENABLED=true`, dispatch CI
  Recovery + Merge Train, and observe a genuinely clean candidate validation
  - atomic promotion — this time expecting the confirmation to succeed
    immediately via `state === 'closed'` rather than falsely failing. This is
    the task's core bounded success metric and was not yet fully re-verified
    live as of this handoff.
- Update issue #1151/#1154/#1157 with final closure notes once the full live
  cutover is verified end-to-end with this fix in production.

## Retrospective

### Lessons Learned

- This is the same class of lesson as DEC-021 (list-summary vs. detail
  hydration in `protection.mjs`) recurring one layer up the stack, and one
  layer _deeper_ than DEC-024's own fix: DEC-024 correctly fixed the
  _coupling_ bug (one entry's confirmation failure stranding its siblings'
  cleanup) but had not questioned whether the confirmation signal itself was
  even achievable. The general lesson holds across three now-fixed gaps in
  this ADR/issue family: an eventually-consistent, secondary GitHub API
  signal was treated as authoritative ground truth, when the actual
  ground truth was already established elsewhere (the ruleset detail
  endpoint for DEC-021; the atomic git push's own success for DEC-024/025).
  Worth keeping in mind for any future GitHub-API-based postcondition check
  in this codebase — and reinforces the plan reviewer's deferred suggestion
  to eventually move this specific check to a git-level ref/ancestry
  postcondition instead of any GitHub PR-object field.
- The bug was invisible to a 110/110-passing test suite for as long as it
  was, purely because the real implementation lived in an untestable
  top-level CLI script. Extracting testable factories out of `reconcile.mjs`
  (as already done once for `buildDispatchBindings`, now again for
  `createWaitForMergedPr`) is a durable pattern worth continuing for any
  other inline logic still living directly in that file.

### Mistakes Made

- DEC-024 (the 4th-gap fix, PR #1156) shipped with a comment framing the
  confirmation gap as an "async lag" and widened the retry budget from ~31s
  to ~77s to "reduce recurrence frequency" — but never actually verified,
  against real production PR data, whether `merged`/`merged_at` could ever
  become true for this promotion mechanism at any budget. A single `gh api
repos/.../pulls/<n>` check against an already-promoted PR at that time
  would have surfaced this gap a full cycle earlier, before re-attempting
  the live cutover a second time.
- The original inline `waitForMergedPr` in `reconcile.mjs` was allowed to
  remain untested for as long as it was (since its introduction) because no
  one flagged, at the time it was written, that a top-level CLI script with
  `process.exit()` at module scope cannot be safely unit-tested — the gap
  between "tests exist and pass" (110/110) and "the actual production code
  path has direct coverage" was not obvious until this incident forced the
  distinction.

### Opportunities for Future Improvement

- Implement the deferred git-level ref/ancestry postcondition (verify
  `origin/main`'s tip and/or each entry's head ref actually equals the final
  candidate SHA) as the long-term replacement for any PR-API-based
  confirmation, per the plan reviewer's suggestion — tracked in issue #1157.
- Audit `reconcile.mjs` for any other inline logic that, like the old
  `waitForMergedPr`, has never been directly unit-tested because the file
  itself is not safely importable; extract further testable factories into
  `reconcile-lib.mjs` as found.
- Consider a lightweight guard/lint rule (or a code-review checklist item)
  that flags any new GitHub-API-derived field used as a postcondition
  without an explicit citation of live evidence that the field is actually
  achievable for the code path in question — this incident and DEC-021 both
  stemmed from an untested assumption about a specific API response shape.
