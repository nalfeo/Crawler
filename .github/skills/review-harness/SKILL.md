---
name: review-harness
description: >-
  Run the apple-scaled plan-review + multi-model code-review process before
  opening a PR in the Crawler repo, and record it in an auditable review ledger.
  Use when asked to "run the review harness", do a "plan review", "multi-model
  review", "review loop", "review ledger", or whenever a change is ">1 apple" /
  ">3 apples" and needs pre-PR review. Covers: deciding required stages from the
  apple estimate, reviewing the plan with a separate model (≥3🍎), generating two
  plans + synthesizing with a judge model (>3🍎), looping code-review agents until
  no concerns or a 2-round cap then human escalation (≥3🍎), multi-model
  code-review with adjudication (>3🍎), and
  writing/validating the review ledger that the `pr-review-ledger` guard enforces
  before `create_pull_request`.
---

# Review Harness

Scale the amount of review a change gets to its **apple complexity**, then prove
it happened with a committed **review ledger**. The `pr-review-ledger` guard
hard-denies `create_pull_request` for a code-touching branch that lacks a valid
ledger for its declared tier, so this skill is the path to a green PR.

> Stage-by-stage recipes with concrete `task`-tool calls and CLI commands live in
> [`references/plan-review.md`](references/plan-review.md),
> [`references/code-review-loop.md`](references/code-review-loop.md), and
> [`references/ledger-recipes.md`](references/ledger-recipes.md). Read the one for
> the stage you are on.

## When this is mandatory

For **any** code-touching change you intend to PR. "Code-touching" = anything
that is not purely docs (`docs/**`, root `*.md`/`*.txt`), art
(`public/assets/**`, `briefs/**`, `data/palettes/**`), or dependency lockfiles.
`src/**` is **always** code. If in doubt, you need a ledger.

The required review **stages** scale with the apple estimate you declared at the
start of the session (see `docs/agent-os/policies/complexity-policy.md`).

## Tier matrix (estimated apples → required ledger stages)

| apples | plan review | dual-plan synthesis | code review (loop) | multi-model review |
| ------ | ----------- | ------------------- | ------------------ | ------------------ |
| 1🍎    | —           | —                   | —                  | —                  |
| 2🍎    | —           | —                   | —                  | —                  |
| 3🍎    | ✅          | —                   | ✅                 | —                  |
| 4–5🍎  | ✅          | ✅                  | ✅                 | ✅                 |

- **plan review** (≥3🍎): before writing code, have a _separate model_ review the
  plan; address every concern. (Floor raised 2🍎 → 3🍎 on 2026-07-07 to match the
  code-review floor, which moved to 3🍎 on 2026-07-02 / ADR 0036. A 2🍎 change now
  requires **no** review stages — the ledger just records the tier.)
- **dual-plan synthesis** (>3🍎): generate **2** plans with **different** models,
  then a **3rd** reasoning model judges + synthesizes the final plan.
- **code review** (≥3🍎): run the appropriate code-review agent(s); address
  feedback; **loop until no concerns remain _or_ escalate to a human** (2-round
  cap, below).
- **multi-model review** (>3🍎): run each appropriate code-review agent with
  **multiple models**; a final reasoning model adjudicates which concerns are
  valid and the right remedy; **delegate** the fixes; **loop until clean _or_
  escalate to a human**.

### Bounded loop: cap at 2 rounds, then escalate

The `code_review` and `multi_model_review` loops are **not** unbounded. If after
**≥2 genuinely-attempted rounds** a concern is intractable, record a terminal
`escalated_to_human` state instead of looping forever:

- Valid **only after 2+ rounds** — never on round 1.
- **Not clean**: keep `clean:false`; the final round stays non-clean with genuine
  unresolved concerns; record `{ after_round, reason, unresolved_concerns }` with
  `after_round` = the final round index (nothing may follow the escalation).
- It is an explicit **recorded terminal state a human must act on** — never a
  silent skip. Escalating beats weakening a gate (rule #12). Exact schema:
  [`references/ledger-recipes.md`](references/ledger-recipes.md).

### Downward-only apple re-scoring

You may re-score your estimate **after** planning, but only **strictly downward**
and only when the **actual diff** justifies it. Record `apples_rescored_from` (the
original higher estimate) + `rescore_reason` at the ledger top level; the validator
rejects upward/no-op re-scores. A downward re-score lowers the required tier — so
**prune** any now-unrequired incomplete stages (the validator checks every present
stage). Never re-score down just to dodge a stage (rule #12).

## Workflow

1. **Declare the tier.** Use your session's apple estimate. Read the matrix above.
2. **Init the ledger first** so every stage has somewhere to land:
   ```
   npm run review:ledger -- init --apples <N> --slug <kebab-slug> --title "<title>"
   ```
   It writes `docs/knowledge/review-ledgers/<YYYY-MM-DD>-<slug>.review-ledger.json`
   scaffolding only the stages your tier requires.
3. **Dual-plan synthesis** (>3🍎): generate two plans with different models and
   synthesize with a judge → record `dual_plan_synthesis`. Do this before the
   plan review (the review reviews the synthesized plan).
4. **Plan review** (≥3🍎): a separate model reviews the (final) plan; address every
   concern → record `plan_review`. See
   [`references/plan-review.md`](references/plan-review.md).
5. **Implement**, then `npm run verify:fast`.
6. **As soon as implementation is done, run the review stages immediately**
   (do **not** wait for `create_pull_request`):
   **Code-review loop** (≥3🍎) → record `code_review`. See
   [`references/code-review-loop.md`](references/code-review-loop.md).
7. **Multi-model review + adjudication loop** (>3🍎) → record
   `multi_model_review`. See
   [`references/code-review-loop.md`](references/code-review-loop.md).
8. **Validate the ledger** and make sure it is committed on your branch:
   ```
   npm run review:ledger -- validate <path>
   ```
   Exit 0 = the guard will allow your PR. Exit 1 = it prints exactly which stage
   is incomplete.
9. Run full verify, which now includes an early PR-prereq pass:
   ```
   npm run verify
   ```
   (`verify` runs `verify:pr-prereqs`, surfacing review-ledger/preflight blockers before PR creation.)
10. Write the dated handoff (pr-preflight still requires it), then
    `create_pull_request`.

## Recording stages

Each stage is written with `stage <path> <stageName> --json '<patch>'`. The patch
is shallow-merged into that stage. Concrete per-stage JSON is in
[`references/ledger-recipes.md`](references/ledger-recipes.md). Example:

```
npm run review:ledger -- stage <path> code_review --json '{"clean":true,"rounds":[{"round":1,"models":["claude-sonnet-4.6"],"concerns_count":3,"resolved_count":3,"clean":true}]}'
```

## What the guard checks (and what it can't)

- It validates **completeness for the declared tier** — required stages present,
  `completed`/`clean` true, models named, `resolved_count >= concerns_count`,
  last review round clean (**or** a valid `escalated_to_human` terminal state after
  ≥2 rounds), downward-only `apples_rescored_from`, etc. The exact rules live in
  `scripts/agent/review/ledger.mjs` (the single source of truth).
- It does **not** verify truthfulness. Like the handoff requirement, the ledger
  is an honor-system artifact — its value is the forcing function + audit trail,
  not cryptographic proof. Do not game it; the point is the review actually
  happened.

## Honesty rules (non-negotiable)

- Never weaken a stage to make the validator pass. If a review surfaced a concern
  you could not resolve, fix it or escalate to the human — do **not** lower
  `concerns_count` or flip `clean` to true. (Project rule #12.)
- Loop reviews until genuinely no concerns remain, not until the count is
  convenient.
- Use **distinct** models where the tier demands it — two calls to the same model
  is not a multi-model review (the validator rejects duplicates).

## Bypass

Genuine edge cases only (e.g. a revert, an emergency infra fix). The guard
honors the standard mechanism:
`COPILOT_GUARDS_DISABLE=pr-review-ledger`. Document why in the PR. See
`.github/extensions/copilot-guards/README.md`.
