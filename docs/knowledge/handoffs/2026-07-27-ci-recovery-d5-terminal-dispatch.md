# 2026-07-27 — CI Recovery: D5 terminal dispatch table (clean-room replacement for #1923/#2044)

## Systems touched: ci-policy

## Summary

Emergency clean-room implementation of issue #1858's D5 gate, delegated via
cross-session message from a Producer-persona parent session diagnosing a
proven, automation-incapable conflict cluster between PR #1923 (broad, stale,
4 unresolved review findings) and PR #2044 (canonical conflict leader, but its
branch is polluted with unrelated merged gameplay/perf commits and only adds
an unwired terminal table). Both PRs were repeatedly skipped as
`ci-conflict-order-wait`. Per explicit instruction, neither PR branch was
rebased, cherry-picked, merged, or modified — this is a from-`main` clean-room
replacement.

Investigation confirmed current `main` already has the **early** decision
table (R03–R11, `buildEarlyDecisionTable`/`selectEarlyAction`) fully wired via
PR #2004 (merged), which also already fixed 3 of PR #1923's 4 findings. The
one remaining gap was the **terminal** dispatch table (R26–R34 + the
GC-\* rows) — it existed only as test-only scaffolding/design reference in
PR #2044, not wired into the runtime driver.

This PR adds `buildTerminalDecisionTable()` / `selectTerminalAction(ctx)` /
`assertTerminalTableInvariant(rows)` to
`.github/scripts/ci-recovery/dispatch-table.mjs`, and replaces the entire
~450-line inline terminal cascade in `reconcile.mjs` with a single
table-driven call site, bounded to `MAX_TERMINAL_PASSES = 2` passes with a
safety-net throw if a row still doesn't converge.

## Required prior findings — resolution

1. **R05 stale-owner cleanup must precede every owner-blind exit** (PR #1923
   finding: `ci-recovery-opt-out` and `train-conflict-predecessor-pending`
   could strand stale ownership). This is in the **early** table (R03–R11),
   which was already fixed by PR #2004 on `main` before this session started.
   Verified unchanged/intact: `router.test.mjs` (97/97 pass, whitespace-only
   diff in that region of `reconcile.mjs`), and the early-table invariant
   (`assertEarlyTableInvariant`) is untouched by this PR.
2. **Reconcile-level coverage proving conflict-episode recording happens
   before rebase dispatch and later drives `conflict-resolved`** — this is
   R08 in the early table; its dedicated test in `reconcile.test.mjs` is
   present and unmodified. Confirmed via the full focused suite.
3. **Wire `selectTerminalAction` into the runtime driver, remove/supersede
   the duplicated inline terminal cascade** — done. `reconcile.mjs`'s
   ~450-line inline if/else-if terminal cascade was replaced by a single
   table-driven loop. A static wiring-strength test in `reconcile.test.mjs`
   asserts `selectTerminalAction(` appears exactly once as an invocation in
   `reconcile.mjs`'s source (not counting the import line), so no parallel/
   duplicate cascade can silently reappear.
4. **The structural invariant must include R09/R10 owner-blind terminal
   waits, not merely a subset** — `assertTerminalTableInvariant` validates
   the full terminal table shape: exactly one non-terminal row (R33), the
   has-blockers sub-path in required dependency order, R28 (unconditional
   no-blockers catch-all) strictly after R26/R27 (own-status-guarded waits)
   AND after the has-blockers sub-path, and DISPATCH as the final row. This
   was strengthened during code review (see below) after a valid finding
   that the original check didn't verify R28's position relative to R26/R27
   specifically.
5. **Preserve throttles, exact metadata/head fences, review/repair wake
   separation, and existing lifecycle semantics** — verified via manual
   row-by-row trace against the original inline cascade, and independently
   re-verified by a background code-review agent (see below), which
   confirmed the if/else-if branch bodies were moved verbatim into table row
   `action` handlers with no semantic changes, and that `now = new Date()`
   is captured once at script start and reused across both loop passes (no
   `Date.now()`/`Math.random()` introduced).

## Terminal row → evidence matrix

| Row                                | Unit test (`dispatch-table.test.mjs`)       | Reconcile-level test (`reconcile.test.mjs`) | Dry-run (32 open PRs)                         |
| ---------------------------------- | ------------------------------------------- | ------------------------------------------- | --------------------------------------------- |
| R26 `WAIT_ADMISSION`               | ✅                                          | —                                           | not naturally exercised by current population |
| R27 `QUEUE_MERGE_TRAIN`            | ✅                                          | —                                           | not naturally exercised by current population |
| R28 `ARM_AUTO_MERGE`               | ✅ (+ R26/R27-precedes-R28 regression test) | ✅                                          | ✅ (multiple PRs)                             |
| GC-EXHAUSTED-SKIP                  | ✅                                          | —                                           | not naturally exercised                       |
| R34 (blocked/train-wait terminal)  | ✅                                          | —                                           | not naturally exercised                       |
| GC-DUPLICATE-WAIT                  | ✅                                          | —                                           | not naturally exercised                       |
| R33 (non-terminal / retry loop)    | ✅ (guard-narrowing tests)                  | ✅ (loop-bound / wiring tests)              | ✅ (observed in dry-run)                      |
| GC-COPILOT-PROGRESS                | ✅                                          | —                                           | not naturally exercised                       |
| DISPATCH (final row / fallthrough) | ✅ (2 "must be final row" tests)            | —                                           | ✅ (majority of dry-run PRs)                  |

R27/R34/GC-EXHAUSTED-SKIP/GC-DUPLICATE-WAIT/GC-COPILOT-PROGRESS are not
naturally triggered by the current 32-PR open population's real states, so
their only coverage is the unit-test level (deliberately constructed
`ctx` fixtures) — this is expected and was called out explicitly in the plan
review; the row invariant tests (ordering/uniqueness/final-row/dependency
checks) apply uniformly to all 9 rows regardless of which are exercised live.

## Verification run

- `dispatch-table.test.mjs`: 46/46 pass.
- Focused CI-recovery suite (`dispatch-table.test.mjs` + `reconcile.test.mjs`
  - `characterization.test.mjs` + `router.test.mjs`): 0 fail across every run
    this session (pass/skip counts fluctuated 251–265 pass / 27–43 skip due to
    a documented pre-existing Windows `UV_HANDLE_CLOSING` subprocess-teardown
    flake in the harness's own skip-detection helper — not related to this
    change).
- `npm run verify:fast`: ✅ passed.
- `npm run scope`: reviewed; change is tooling/CI-automation-scoped, not
  gameplay — no headless/weapon-sweep/visual-review escalation needed.
- **Dry-run reconcile artifact**: ran reconcile in dry-run mode against all 32
  currently-open PRs, once against pre-change `origin/main` and once against
  this branch. Result: **32/32 identical verdicts, 0 unexplained deltas.**
  This is the real-artifact observation required by issue #1858 (not a lab —
  the actual `reconcile.mjs` driver against the live open-PR population).
- D3/#2073 idle/no-owner repair-wake behavior: verified intact via
  `router.test.mjs` (97/97 pass, no changes to that code path).
- Review harness (3🍎 tier): plan review (gpt-5.4, `approved_with_changes`,
  `minor` divergence, 5/5 concerns resolved with hardening fixes — narrowed
  R33 guard, added `assertTerminalTableInvariant`, bounded the terminal loop
  to `MAX_TERMINAL_PASSES=2` with a safety-net throw, moved `stateProgressKey`
  inside the loop, added a static single-call-site wiring test) + one
  code-review round (clean after fix — added the R26/R27-precedes-R28
  invariant check plus a regression test reproducing the exact reorder
  scenario the reviewer identified). Ledger validated:
  `docs/knowledge/review-ledgers/2026-07-27-ci-recovery-d5-terminal-dispatch.review-ledger.json`
  — ✅ valid 3-apple ledger.
- `npm run apples:record`: 3🍎 estimated → 3🍎 actual (delta +0).
- `npm run telemetry:capture`: 238 events captured.
- `npm run sync:main`: rebased cleanly onto current `origin/main` (one
  unrelated intervening sprite check-in commit, no conflicts).

## Files touched

- `.github/scripts/ci-recovery/dispatch-table.mjs` — added
  `buildTerminalDecisionTable`, `selectTerminalAction`,
  `assertTerminalTableInvariant`, `RELEASE_STALE_AUTOMATION_RETRY`.
- `.github/scripts/ci-recovery/reconcile.mjs` — replaced the inline terminal
  cascade with a single table-driven, pass-bounded loop.
- `.github/scripts/ci-recovery/dispatch-table.test.mjs` — 46 tests (row
  ordering/uniqueness/invariant/regression coverage).
- `.github/scripts/ci-recovery/reconcile.test.mjs` — added a D5 wiring-proof
  test (single call site) and terminal-row exercise tests.
- `docs/knowledge/review-ledgers/2026-07-27-ci-recovery-d5-terminal-dispatch.review-ledger.json`
- `docs/knowledge/metrics/apples/2026-07-27-ci-recovery-d5-terminal-dispatch.json`
- `docs/knowledge/metrics/guard-telemetry/2026-07-27-ci-recovery-d5-terminal-dispatch.json`

## Unresolved issues / risks

- None outstanding. All required prior findings addressed, all review-harness
  stages complete and recorded, all tests green, dry-run shows zero verdict
  drift.
- PR #1923 and PR #2044 remain open; this PR supersedes both but does not
  close them (per instruction) — they should be closed once this replacement
  merges.

## Recommended next steps

- Merge this PR, then close PR #1923 and PR #2044 referencing it as the
  superseding clean-room implementation.
- No further D5-specific follow-up identified; the terminal dispatch table
  is now the single source of truth for terminal decisions, matching the
  early table's existing pattern.
