# Session Handoff: Streamline verify/CI — dedup local verify, scope headless gate, PR-title-only commit-lint

## Date

2026-07-02

## Persona(s) adopted

**DevOps Engineer** (CI/guard infrastructure) with **Producer** framing for the
up-front cross-session audit. The task began as a deep audit of guard/CI
duplication and narrowed into three concrete plumbing fixes, which is squarely
DevOps.

## Routing verdict

✅ right persona — the change is CI workflow + local verify + guard-adjacent
tooling, no gameplay/ECS surface.

## Apples

Estimated: 🍎 x 3 <!-- declared before work began -->
Actual: 🍎 x 3
Verdict: 🎯 Exact — Medium CI/shell change: a new scope classifier with real
fail-open subtlety (caught in review), a folded CI `if:` expression, and a
commit-lint retarget, plus tests + ADR + docs.

Hello kitties: 3/5 = 0.60 🎀

## Review Harness

Ledger: `docs/knowledge/review-ledgers/2026-07-02-streamline-verify-ci-gates.review-ledger.json`
Stages (3🍎 tier): plan_review ✅ (gpt-5.4, rejected→revised, 5/5 resolved) ·
code_review ✅ (gpt-5.4, 2 rounds; round 1 found 1 Medium fail-open bug, round 2
clean). `npm run review:ledger -- validate <path>` → pass (exit 0).

## What Was Done

Three guard/CI streamlining fixes, all evidence-driven from a 3-day
session/PR + guard-telemetry audit (we were effectively running the headless
suite ~4× per change: local `verify` + PR CI + merge-gate + main-push):

1. **Dedup local `verify`** — `scripts/agent/verify.sh` now defers _only_ the
   headless gate behind `VERIFY_FULL=1` (mirrors the existing `VERIFY_COVERAGE=1`
   pattern). Typecheck/lint/format/unit/integration/pr-prereqs/build still run
   every time; integration + build stay local because they cover gaps the CI
   headless skip does not. The ~306s headless long-pole no longer runs before
   every commit — CI remains the enforcing gate.
2. **Scope the CI headless gate** — `scripts/agent/ci/detect-art-only.sh` now
   also emits a `gameplay_safe` scope flag (allowlist: `src/engine/**`,
   `src/labs/**`, `tests/e2e/**`, `docs/**`, `public/**`, root `*.md`/`*.txt`).
   `ci.yml`'s `test-headless` skips on `gameplay_safe` **pull requests only** —
   push-to-`main` always runs the headless backstop, and the merge-gate already
   treats a skipped headless as PASS (`allow_skipped=true`). A new
   `SCOPE_FILES_OVERRIDE` test hook makes the classifier unit-testable; it
   fail-closes (all-false) when set-but-empty.
3. **Commit-lint targets the PR title** — `commit-lint.yml` now lints the PR
   title (via `PR_TITLE` env → `printf` → `commitlint --config
commitlint.title.config.cjs`) instead of every WIP commit that squash-merge
   discards. New `commitlint.title.config.cjs` sets `ignores: []` to close the
   `(#n)` title bypass.

New/changed files: `scripts/agent/verify.sh`, `scripts/agent/ci/detect-art-only.sh`,
`.github/workflows/ci.yml`, `.github/workflows/commit-lint.yml`,
`commitlint.title.config.cjs` (new), `tests/unit/detect-change-scope.test.ts`
(new, 18 cases), `docs/knowledge/adr/0035-scope-headless-gate-and-dedup-verify.md`
(new), `.github/copilot-instructions.md`, `AGENTS.md`, and the review ledger.

## What's Next

- **Follow-up session (separate branch): raise the review-harness code-review
  floor to 3🍎.** Decided with the human this session: the local code-review loop
  currently runs for _all_ tiers incl. 1🍎, costing ~5–6 min/round for marginal
  value on trivial changes. A dedicated session ("Raise code-review floor to
  3🍎") is implementing it as its own 3🍎 PR (code review required ≥3🍎; plan
  review stays ≥2🍎). It edits `ledger.mjs` + tests + guard help text + policy
  docs + 13 personas + root docs + ADR 0036 — do **not** duplicate that here.
- **Guard-telemetry repair** is in flight in another session
  (`nalfeo-guard-telemetry-repair`), fixing read/write contamination + adding
  `npm run telemetry:capture`. Both follow-ups touch `AGENTS.md` +
  `.github/copilot-instructions.md` in _different_ sections — expect trivial,
  auto-mergeable conflicts; rebase before merge.

## Blockers

None.

## Branch State

- Branch: `nalfeo-fluffy-couscous`
- All tests passing: yes (verify:fast green; new unit test 18/18; ledger valid)
- PR created: pending (this handoff is a pr-preflight prerequisite)

## Agent-OS Telemetry

N/A — `files/guard-telemetry.jsonl` does not exist in this worktree.

## Test Results

`npm run verify:fast` → green. `npx vitest run --project unit
tests/unit/detect-change-scope.test.ts` → 18/18. `detect-art-only.sh` verified
against 14 synthetic diffs + fail-safe (no base / empty / whitespace override) →
all correct. Full `npm run verify` run at end of session (see PR).

## Key Decisions Made

- **Defer only headless locally, not the whole CI suite.** Plan review flagged
  that deferring integration+build would create a local/CI coverage gap; narrowed
  to headless-only.
- **PR-only `gameplay_safe` headless skip.** Keeps the push-to-`main` headless
  backstop so a mis-scoped PR can't ship a gameplay regression unobserved.
- **Title-specific commitlint config (`ignores: []`).** The base config ignores
  `(#n)`-suffixed messages; reusing it for the title would let untyped titles
  pass. A separate config closes that.
- **Guard _removal_ and review-harness policy were explicitly OUT of scope** for
  this PR (documented in ADR 0035) — the review-floor change is a separate PR.

## Retrospective

### Lessons Learned

- The `pr-review-ledger` CLI `--json` flag is unusable from PowerShell (quoting
  gets mangled); edit the ledger JSON file directly instead.
- `node_modules` is absent in a fresh worktree — run `npm ci` before any
  vitest/commitlint work or the harness tools fail cryptically.
- A folded CI `if:` (`>-`) scalar is easy to get subtly wrong; parse it with
  js-yaml and reason about each branch (push-to-main / PR-gameplay_safe /
  art_only) before trusting it.

### Mistakes Made

- First cut of the `SCOPE_FILES_OVERRIDE` hook used `-n "$VAR"`, so a
  _set-but-empty_ override fell through to real git diffing (nondeterministic in
  a test). Code-review round 1 caught it; fixed with presence detection
  (`${VAR+x}`) + an empty-string test case. Early signal: any env-driven test
  hook must distinguish unset from set-but-empty.

### Opportunities for Future Improvement

- Consider consolidating the redundant cron/health workflows surfaced by the
  audit (out of scope here).
- The 3-day audit showed ~4.7 CI runs/branch; after this change, re-measure to
  confirm the headless-skip actually reduced the long-pole in practice.
