# Session Handoff: Raise review-harness code-review floor to 3🍎

## Date

2026-07-02

## Persona(s) adopted

**Producer** (primary) — this is a governance/policy change that coordinates one
source-of-truth code edit with broad cross-doc consistency (policies, skill,
personas, ADR) and a self-run review harness. Applied a **DevOps-engineer** lens for
the guard/CLI/test mechanics (`requiredStagesForApples`, `pr-review-ledger` guard,
`test:guards`).

## Routing verdict

✅ right persona — Producer's cross-cutting-consistency focus is exactly what a
policy-threshold change needs; the DevOps mechanics were a sub-task, not a separate
routing.

## Apples

Estimated: 🍎 x 3 <!-- declared before work began -->
Actual: 🍎 x 3
Verdict: 🎯 Exact — tiny, well-tested logic change, but the ADR + cross-doc sync +
running the 3🍎 harness on itself keep it firmly above a 2 and well below a 4 (single
system, no dual-plan/multi-model stage).

Hello kitties: 3/5 = 0.60 🎀

## Review Harness

Ledger: `docs/knowledge/review-ledgers/2026-07-02-raise-code-review-floor.review-ledger.json`
Stages (3🍎 tier under the NEW matrix this change introduces): plan_review ✅ · code_review ✅

- **plan_review**: separate model (rubber-duck, gpt-5.4). 3 items (0 blocking); all
  resolved honestly — stale "Use on every change" operator line scoped to ≥3🍎; ADR
  rule-#12 misattribution repointed to complexity-policy.md "Deflation"; CLI-init nit
  resolved with rationale (surface already directly unit-tested; `LEDGER_DIR` is
  hardcoded and drives the guard, so an env-override test would be scope creep).
- **code_review**: loop via code-review (claude-sonnet-4.6). Round 1 → 1 should-fix
  (ADR said "nightly" calibration report; the workflow cron `0 9 * * 1` is weekly →
  fixed). Round 2 → CLEAN.

`npm run review:ledger -- validate <path>` → **pass (exit 0)**. No self-exemption: the
branch already carries the new matrix, so at 3🍎 both stages were still required.

## What Was Done

Raised the review-harness **code-review loop** floor from "every tier (1🍎+)" to
**3🍎+**. Unchanged: plan_review (2🍎+), dual_plan_synthesis + multi_model_review
(4🍎+). 1🍎/2🍎 changes still commit a lightweight ledger (the guard reads the tier
from it).

- **Source of truth**: `scripts/agent/review/ledger.mjs` `requiredStagesForApples()`
  body + JSDoc → `[]` / `['plan_review']` / `['plan_review','code_review']` /
  all-four for tiers 1/2/3/4–5.
- **Tests**: `scripts/agent/review/ledger.test.mjs` — matrix expectations updated;
  `tier1()` fixture now `stages:{}`; added `tier2()` (plan_review only); replaced the
  old tier-1 test with three (tier-1 empty-stages valid, tier-2 plan_review-only
  valid, code_review required at 3🍎). `npm run test:guards` → **215 pass**.
- **Guard help text**: `.github/extensions/copilot-guards/guards/pr-review-ledger.mjs`.
- **Docs synced** (no stale refs — grepped `(all changes)` / `2–3🍎` → none):
  `complexity-policy.md`, `review-harness-policy.md`, `SKILL.md`,
  `code-review-loop.md`, `ledger-recipes.md`, `.github/copilot-instructions.md`,
  `AGENTS.md` (rule #14), and all **13 persona docs**.
- **ADR**: `docs/knowledge/adr/0036-raise-code-review-floor.md` (0035 taken by an
  in-flight branch) — decision, rationale, enforced change, consequences (incl. the
  under-declaration loophole, repointed to complexity-policy.md "Deflation").
- **Ledger / apples / this handoff** created.

## What's Next

- Merge is armed via `gh pr merge --auto --squash`; confirm `state=MERGED` with a
  non-null merge commit and that review threads are resolved, then idle.
- No follow-up work required; the matrix is pinned by `test:guards` so prose can't
  drift silently.

## Blockers

None.

## Branch State

- Branch: `nalfeo-verbose-waddle`
- All tests passing: yes (`test:guards` 215 pass; full `npm run verify` run before PR)
- PR created: yes (auto-merge armed; link reported to creator session)

## Agent-OS Telemetry

Guard telemetry captured via: none — `files/guard-telemetry.jsonl` did not exist this
session (checked both the repo `files/` and the session-state `files/`).

## Test Results

- `npm run test:guards` → 215 passed.
- `npm run verify:fast` → pass (no TS files changed; `.mjs`/`.md` only).
- `npm run verify` → run before PR (see PR checks).

## Key Decisions Made

- **Code-review floor → 3🍎; plan review stays 2🍎** (sanctioned, human-decided).
  Rationale: local code-review agents cost ~5–6 min/round and add marginal value on
  1–2🍎 trivial/small changes where typecheck+lint+CI already backstop. Documented in
  ADR 0036.
- **Kept the `LEDGER_DIR`/`LEDGER_PATH_RE` hardcoding** rather than adding an
  env-override for a CLI-init test — the guard relies on that path validation, so the
  tier→stages surface is covered by the direct `requiredStagesForApples` unit test
  instead.

## Retrospective

### Lessons Learned

- `requiredStagesForApples()` is the true single source of truth: the guard, the CLI
  scaffolder (`cmdInit`), and `validateLedger` all consume it, and the guard tests
  (`pr-review-ledger.test.mjs`, `pr-prereq-check.test.mjs`) inject their validators,
  so they're matrix-independent — no test churn there.
- A ledger with **extra** valid stages still validates; only the _required_ set is
  enforced as present. So a 1🍎/2🍎 ledger that includes a filled code_review is fine.
- PowerShell has no `head`; use `Select-Object -First/-Last`. A grep with a literal
  `→` arrow tripped a transient policy-hook block once — plain-ASCII patterns avoid it.

### Mistakes Made

- The ADR initially (a) misattributed the apple-honesty mitigation to "rule #12"
  (which is about not weakening explicit requirements, not apple deflation) and (b)
  called the calibration report "nightly" when the cron is weekly. Both were caught by
  the self-harness (plan review + code review round 1) and fixed — early signal for a
  future agent: verify every factual claim in an ADR against the actual workflow/source
  before writing it, don't paraphrase from memory.

### Opportunities for Future Improvement

- Consider a tiny direct CLI test for `init --apples 1/2` scaffolding if `LEDGER_DIR`
  ever becomes injectable (e.g., via an explicit `--out-dir` that still validates
  against `LEDGER_PATH_RE`). Out of scope here to avoid touching guard path logic.
- The ≥3🍎 threshold now lives in prose across ~20 files; `test:guards` pins the
  _behavior_, but a lightweight doc-lint that greps for known-stale phrases
  (`(all changes)` next to "code review") could pin the _prose_ too.
