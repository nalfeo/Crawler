# Session Handoff: Streamline validation pipeline — Bundle A (PR 1)

## Date

2026-07-07

## Persona

Producer → Systems/DevOps (producer-orchestrated INVESTIGATION → implementation slice)

## Systems touched

ci-policy

## Apples

3🍎 estimated, 3🍎 actual (exact) — implementation phase (was 2🍎 for the docs-only
investigation phase; re-scored upward once it became scripts + guards + a unit test).

## What Was Done

Producer-orchestrated slice to **cut wasted validation time**. Phase 1 audited the
review-harness + verify pipeline and delivered a ranked 7-item proposal (in
`plan.md`); the maintainer approved all 7 across 2 PRs. This PR is **Bundle A**
(items #1, #4, #5, #6, #7) — the low-risk subset that touches **no hard gate**:

- **#4 (biggest win) — `lab-gate-check.sh` refactor.** Replaced the
  O(systems×labs) inner loop (per-iteration `basename`/`sed`/`tr` subshell forks)
  with an O(systems+labs) precompute: lab base-names normalized once into a bash
  assoc-array via parameter expansion (`${x##*/}`, `${x%-lab}`, `${x,,}`), then
  O(1) lookup per system. **Observed in the real script on this repo: baseline run
  took >4 min (timed out through 300s+ of per-fork waits) → refactored run 0.18s,
  output proven BYTE-IDENTICAL** (`Compare-Object` against the captured baseline).
  Gate behavior unchanged; the separate CI `check-format-and-labs` job still enforces it.
- **#1 — `npm run scope`.** New `scripts/agent/ci/local-scope.sh` classifies the
  working-tree change set (committed branch diff + staged + unstaged + untracked,
  no `--diff-filter` so deletions/renames count) via the existing
  `detect-art-only.sh`. Powers a decision table in AGENTS.md: run headless / sweeps
  / visual review locally **only** when the change scope warrants it. CI still
  enforces the real gates on non-`gameplay_safe` PRs.
- **#5 — scope the `verify:fast` health checks.** `size-coverage` + `weight-coverage`
  (local-only, ~800-frame sims) are skipped when the scope is exactly
  `gameplay_safe=true` (and only when `[ -z "${CI:-}" ]`); `physics-defs-sync` stays
  unconditional. Defensive parse — any doubt/error runs all three (fail-safe).
  **Observed both branches: gameplay_safe diff → 2 checks skipped; core diff / parse
  error → all 3 run.**
- **#7 — local `knip` opt-in** behind `VERIFY_KNIP=1` in `verify.sh` (knip is
  advisory in CI regardless). **Observed: knip skipped in a full `npm run verify`.**
- **#6 — batch review-fix pushes** guidance under Merge Policy in AGENTS.md.

All 8 plan-review concerns (gpt-5.3-codex, APPROVE-WITH-CHANGES) were resolved in
the code: CRIT-1 (unresolved base ⇒ force `gameplay_safe=false`), CRIT-2 (no
`--diff-filter`), defensive `gameplay_safe=` parse gated on `[ -z "${CI:-}" ]`,
`BASH_SOURCE` anchor for the `detect-art-only.sh` call, honest local-only skip
message, and a deterministic `tests/unit/local-scope.test.ts` (8 cases, all pass).

Review harness (3🍎): `plan_review` + `code_review` recorded and validated in
`docs/knowledge/review-ledgers/2026-07-07-review-harness-efficiency.review-ledger.json`.
Code-review agent (gpt-5.3-codex, 428s) found no significant issues.

## Key Decisions Made

- **Items 1 & 5 share one primitive** (`local-scope.sh`) instead of duplicating
  git-scope logic — DRY and reuses the already unit-tested `detect-art-only.sh`.
- **Safe-skip is fail-closed:** a skip requires a RESOLVED merge base AND the full
  branch-diff+worktree set classified `gameplay_safe`. Working-tree-only data can
  never grant a skip (committed branch changes would be hidden), and any parse error
  runs the full set. This is why item 5 is safe: `gameplay_safe=true` ⇒ none of the
  sim's inputs (`src/core`, `src/game/ai`, balance data) changed ⇒ the 800-frame
  checks cannot newly fail.
- **HARD-gate items #2/#3 deliberately excluded from this PR** and delegated to a
  separate, heavily-reviewed 4🍎 child session so Bundle A ships fast and the
  meta-gate change gets its own focused review.

## What's Next / Blockers

- **PR 2 (#2 + #3, 4🍎)** — cap the review-harness code-review/multi-model loops at
  2 rounds THEN escalate to a human (terminal `escalated_to_human` state, never a
  silent skip); allow strictly-downward, diff-justified apple re-scoring after
  planning; raise the plan-review floor 2🍎→3🍎 (cite the 2026-07-02 code-review-floor
  precedent). Edits `ledger.mjs` validator + `test:guards` + review-harness-policy.md
  - complexity-policy.md + the review-harness skill + AGENTS.md rule #14. Runs the
    4🍎 harness (dual-plan synthesis + multi-model review). Delegated to a child session.
- No blockers for PR 1.

## Retrospective

### Lessons Learned

- **The lab-gate slowness rediscovered in ≥3 prior handoffs was fixable in-script,
  not just "run it on CI."** The dominant cost on Windows Git Bash was per-fork
  overhead in an O(n×m) loop; precomputing with bash parameter expansion collapsed a
  > 4-min run to 0.18s. Byte-identical output is easy to prove and worth capturing.
- **`local main` in a worktree can be stale at the merge-base** while the branch HEAD
  already equals `origin/main`. `git diff main...HEAD` then shows a huge phantom diff.
  Always fetch and diff against `origin/main` before reasoning about a PR's contents.
- **On Windows, `npm run review:ledger` hangs** (npm wrapper overhead); call
  `node scripts/agent/review/cli.mjs …` directly. Pass ledger JSON single-quoted
  WITHOUT backslash-escaping the inner quotes (PowerShell passes single-quoted
  strings literally; `\"` corrupts the JSON).

### Mistakes Made

- Initially read `git diff --stat main...HEAD` and briefly thought the branch
  contained dozens of unrelated files. The early signal I should have checked first:
  `git rev-parse main` vs `origin/main` — the local ref was stale. Fetch + diff
  against `origin/main` immediately when a worktree PR diff looks too large.
- First attempts recorded the ledger via `npm run …` and hung twice before switching
  to the direct `node cli.mjs` invocation.

### Opportunities for Future Improvement

- The two `verify:fast` coverage checks (`size-coverage`, `weight-coverage`) are
  **local-only** — they run in no CI workflow. Scoping them locally is safe, but the
  pre-existing gap is that a desync could reach `main` if an agent never runs
  `verify:fast`. Worth a follow-up to add them (unconditionally) to a CI job.
- `verify.sh` prettier-checks only `.ts` files, so `.sh` changes are never
  format-checked. A shell-formatter (shfmt) gate could catch shell drift.
