# Session Handoff: Review-Harness Gate Tuning (PR 2 — hard-gate half)

## Date

2026-07-07

## Persona

Systems/DevOps (review-gate validator owner)

## Systems touched

ci-policy

## Apples

4🍎 estimated / 4🍎 actual (🎯 exact). Single system (`ci-policy`) but
repo-wide blast radius: this edits the review-ledger validator imported by the
`pr-review-ledger` copilot-guard, so it gates **every future PR**. Three
coupled validator changes + cli + tests + wide doc propagation + the full 4🍎
review harness justify the tier without spanning a second system (no ADR).

## What Was Done

PR 2 of a maintainer-approved, two-PR review-harness streamlining effort. PR 1
(#847, low-risk bundle, touched no hard gate) is already merged. PR 2 is the
hard-gate half: it tunes the enforcement in `scripts/agent/review/ledger.mjs`
(the single source of truth the guard imports). Three faithful,
maintainer-approved changes — no drift:

- **#3 — Raise the plan-review floor 2🍎 → 3🍎.** `requiredStagesForApples`
  drops the `apples >= 2 ⇒ ['plan_review']` branch. New matrix:
  **1🍎→[], 2🍎→[], 3🍎→[plan_review, code_review], 4–5🍎→all four.** This
  completes the floor move begun on **2026-07-02** when the _code-review_ floor
  moved to 3🍎 (handoff `2026-07-02-streamline-verify-ci-gates.md` / ADR 0036);
  plan review wasn't moved then. Docstring updated.
- **#2a — Cap the code-review / multi-model loop at 2 rounds, then escalate to
  a human.** Added an optional terminal `escalated_to_human` field to the
  `code_review` and `multi_model_review` schemas:
  `{ after_round: int >= 2, reason: non-empty string, unresolved_concerns: int >= 1 }`.
  A review stage is now COMPLETE iff **either** (a) last round `clean:true`
  (unchanged legacy path) **or** (b) a valid `escalated_to_human` is present
  **and ≥ 2 rounds** were genuinely attempted (each round lists models +
  concern counts). Escalation on round 1 is REJECTED; `clean` MUST be `false`
  when escalated (escalation is NOT clean — it is a recorded terminal state a
  human must act on). The discriminator is `escalated_to_human !== undefined`
  → escalation path, so a malformed escalation object can never silently pass
  through the clean path. New helpers `validateRoundShape` +
  `validateEscalationTerminal`; `validateLastRoundCommon` (clean path) unchanged.
- **#2b — Downward-only, diff-justified apple re-scoring.** Added optional
  top-level ledger fields `apples_rescored_from` (int 1..5) + `rescore_reason`
  (non-empty string). The validator REJECTS an upward/no-op re-score
  (`apples_rescored_from` must be **strictly greater than** `estimated_apples`)
  and rejects a lone `rescore_reason` with no `apples_rescored_from`. A
  downward re-score that drops the tier makes required stages follow the NEW
  lower tier. "Justified by the diff" is honor-system + policy text (documented,
  not mechanically provable).

Propagation (kept the whole ruleset consistent):

- `scripts/agent/review/cli.mjs` — `init` scaffold already derives from
  `requiredStagesForApples` (so it tracks the new matrix automatically);
  cosmetic `(none)` print for an empty required-stage list.
- `.github/extensions/copilot-guards/guards/pr-review-ledger.mjs` — tier string
  in the missing-ledger help message.
- Tests: `scripts/agent/review/ledger.test.mjs` (**49 pass** — tier matrix;
  escalation accept after ≥2 rounds; escalation-on-round-1 rejected;
  clean-when-escalated rejected; empty/wrong-typed `escalated_to_human`
  rejected; upward/no-op/lone-reason re-score rejected; downward accepted) and
  `.github/extensions/copilot-guards/tests/pr-review-ledger.test.mjs`
  (**283 pass** — incl. help-string lock-in). `npm run test:guards` green.
- Docs: `docs/agent-os/policies/review-harness-policy.md` (tier matrix +
  loop-cap/escalation rule + downward-only re-score + 2026-07-02 precedent),
  `docs/agent-os/policies/complexity-policy.md` (downward-only, diff-justified
  re-score guidance), `.github/skills/review-harness/SKILL.md` +
  `references/{ledger-recipes,plan-review,code-review-loop}.md`, `AGENTS.md`
  rule #14, `.github/copilot-instructions.md`, and all **13**
  `docs/agent-os/personas/*.md` (identical fragment: `plan review (≥3🍎)` +
  `code-review loop until no concerns _or_ a 2-round cap then human escalation
(≥3🍎)`).

## Observed (before/after, real artifacts)

Enforcement change demonstrated with the validator on crafted fixtures
(`files/observe-enforcement.mjs`, session artifact — **all observations PASS**):

- **(a) Floor raise 2→3:** a **2🍎 ledger with no stages** now
  `validateLedger().ok === true` (BEFORE: 2🍎 required `plan_review`, so an
  empty-stages 2🍎 ledger FAILED).
- **(b) Escalation terminal state:** a `code_review` with `escalated_to_human`
  **after 2 rounds** → `ok:true`; the **same escalation on round 1** →
  `ok:false` (`"never escalate on round 1"` + `after_round must equal the final
round index and be >= 2`); `escalated_to_human:null` → `ok:false` (no silent
  clean fallback); escalation **+ `clean:true`** → `ok:false`
  (`"escalation is NOT clean"`). BEFORE: no terminal state existed — an
  intractable concern had only an unbounded loop-until-clean.
- **(c) Downward-only re-score:** downward `4→2` → `ok:true`; upward `2→4` →
  `ok:false` (`"must be strictly greater ... downward-only"`); no-op `2→2` →
  `ok:false`; lone `rescore_reason` → `ok:false`
  (`"only valid alongside apples_rescored_from"`).
- **Backward-compat:** the clean path is byte-identical (only inspects the LAST
  round via `validateLastRoundCommon`; `validateRoundShape` runs ONLY on the
  escalation path). Both code-review and multi-model reviewers independently
  confirmed **all 124 committed ledgers still validate** (the
  `equipment-paperdoll-overhaul` ledger's `rounds[0].models:[]` on a clean
  multi_model_review would retroactively fail if per-round shape ran on the
  clean path — it does not).

## Key Decisions Made

- **Discriminator = `escalated_to_human !== undefined`, not truthiness.** A
  malformed escalation object (`null`, `{}`, wrong-typed `after_round`) routes
  to the escalation validator and FAILS there — it can never fall back to the
  clean path and pass silently. This is the single most important safety
  property of #2a.
- **Per-round shape validation scoped to the escalation path only.** Required to
  preserve the legacy clean path byte-for-byte (a committed clean ledger has an
  empty `rounds[0].models`). This was surfaced as a blocking concern in plan
  review and resolved by scoping.
- **Escalation must leave genuinely-unresolved concerns in the final round**
  (`resolved_count < concerns_count` for code_review, `< valid_count` for
  multi_model_review) — you cannot record a "clean but escalated" contradiction.
- **Re-score validation is downward-only + strictly-greater**, and a lone
  `rescore_reason` is rejected so the two fields can't drift apart. "Diff-
  justified" stays honor-system (documented in both policies).
- **Full 4🍎 harness run honestly, no stage weakened (rules #12/#14).**
  dual-plan synthesis (gpt-5.5 + gemini-3.1-pro-preview plans, claude-opus-4.8
  judge) → plan*review (gpt-5.4, 4 concerns all resolved by \_strengthening*) →
  code_review (claude-sonnet-4.6, 1 sub-threshold observation closed with 2
  added coverage tests, then clean) → multi_model_review (gpt-5.3-codex +
  gemini-3.1-pro-preview reviewers, both clean; gpt-5.4 adjudicator: CLEAN).

## What's Next / Blockers

- **No blockers.** Review ledger validates (exit 0, 4-apple, all four stages);
  `npm run verify` green (runs `verify:pr-prereqs`). This is a tooling/CI-policy
  change with no `src/core`/`src/game/ai`/balance impact, so the ~306s headless
  Floor-1 gate is deferred to its required CI job (win-rate unaffected).
- PR opened with a holistic title/description covering **both** #2
  (cap-then-escalate + downward re-score) and #3 (plan-review floor 2🍎→3🍎);
  `gh pr merge --auto --squash` armed.
- Future: a `rescore` CLI subcommand could set `apples_rescored_from` +
  `rescore_reason` (and re-scaffold to the lower tier) instead of hand-editing
  the ledger — deferred intentionally (out of the approved scope).

## Retrospective

### Lessons Learned

- **A discriminator on `!== undefined` (not truthiness) is what makes the
  escalation escape-hatch safe.** Routing any _present_ `escalated_to_human` to
  the strict escalation validator means a malformed value fails loudly instead
  of falling through to the permissive clean path — the difference between a
  safety win and a new silent bypass.
- **Backward-compat for a validator = "only touch the new path".** The clean
  path had to stay byte-identical because 124 committed ledgers (one with an
  empty `rounds[0].models`) are re-validated by nothing — but the PR's own
  fixtures and both reviewers re-checked all 124 to be sure.
- **The `init` scaffold deriving from `requiredStagesForApples` meant #3 needed
  no separate CLI edit** — the matrix is the single source of truth for both the
  guard and the scaffold.

### Mistakes Made

- The observe-before-done harness initially used `{ valid }` and omitted
  `completed:true` on `plan_review`; corrected to the real return shape
  (`{ ok, errors, ... }`) and the real stage schema before trusting its output.

### Opportunities for Future Improvement

- A `rescore` CLI subcommand (see What's Next) to make downward re-scoring a
  first-class, mechanically-scaffolded operation rather than a hand-edit.
- Consider a guard test that re-validates a snapshot of committed ledgers so a
  future validator change that breaks backward-compat fails in CI, not just in
  a reviewer's manual spot-check.
