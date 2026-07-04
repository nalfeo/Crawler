# ADR 0036: Raise the Review-Harness Code-Review Floor to 3🍎

**Date:** 2026-07-02  
**Status:** Accepted  
**Affected Systems:** review harness (`scripts/agent/review/ledger.mjs`), `pr-review-ledger` guard, review-harness skill + policy docs, persona docs

## Status

Accepted (2026-07-02).

## Estimated Complexity

🍎 × 3 — one source-of-truth function plus its tests and guard help text, and a
wide but mechanical doc/persona sync; no gameplay or runtime logic.

## Context

The apple-scaled review harness records which review stages a change went through
in a committed **review ledger**, which the deterministic `pr-review-ledger` guard
validates at the `create_pull_request` boundary. The required stages are chosen by
`requiredStagesForApples()` in `scripts/agent/review/ledger.mjs` (the single source
of truth) from the declared apple estimate.

Until now the **code-review loop** stage was required at _every_ tier (1🍎+). In
practice, the local code-review loop costs ~5–6 minutes per round and adds little
marginal signal on trivial/small (1–2🍎) changes, where `typecheck` + `lint` +
changed-unit-tests (`verify:fast`) and the full CI suite already backstop
correctness. That ceremony was the dominant cost of shipping a one-line fix.

## Decision

Raise the **code-review loop** floor so it is required only for **3🍎+** changes.
Leave every other threshold unchanged: the pre-code **plan review** stays required
at **2🍎+**, and **dual-plan synthesis** + **multi-model review** stay at **4🍎+**.

The enforced change is entirely in `requiredStagesForApples()`:

```js
if (apples >= 4) return ['plan_review', 'dual_plan_synthesis', 'code_review', 'multi_model_review'];
if (apples >= 3) return ['plan_review', 'code_review'];
if (apples >= 2) return ['plan_review'];
return [];
```

New required-stage matrix:

| apples | plan_review | dual_plan_synthesis | code_review | multi_model_review |
| ------ | ----------- | ------------------- | ----------- | ------------------ |
| 1🍎    | —           | —                   | —           | —                  |
| 2🍎    | ✅          | —                   | —           | —                  |
| 3🍎    | ✅          | —                   | ✅          | —                  |
| 4–5🍎  | ✅          | ✅                  | ✅          | ✅                 |

A **1🍎 or 2🍎 change still commits a review ledger** — the guard reads the declared
tier from it. It just needs zero (1🍎) or one (2🍎) stages. An empty `stages: {}`
object validates fine for 1🍎. Because `validateLedger` still validates any stage
that is _present_, a small change that voluntarily runs a code review can record it
without penalty.

## Consequences

### Positive

- Trivial/small (1–2🍎) changes ship without the ~5–6 min/round local code-review
  loop, cutting low-value ceremony where CI + `verify:fast` already backstop.
- The code-review loop's cost is now spent where it earns its keep — 3🍎+ changes
  with real design/logic surface area.
- One source of truth (`requiredStagesForApples`) still drives the guard, the CLI
  scaffolder, the docs, and the tests, so the matrix cannot drift silently.

### Negative

- A genuine 3🍎 change that is _mis-declared_ as 2🍎 now skips code review entirely
  (previously it would still have required a code-review loop at any tier). Apple
  honesty matters more than before.
- Ledgers for 1🍎 changes now carry no stage evidence at all, so the audit trail
  for the smallest changes is just the declared tier.

### Risks

- **Under-declaration loophole.** Lowering the floor makes "declare 2🍎 to skip the
  code review" a tempting shortcut. This is an apple-honesty violation — the
  **Deflation** anti-pattern in
  [`complexity-policy.md`](../../agent-os/policies/complexity-policy.md) (marking work
  as fewer apples than it is) — reinforced by the general "never weaken a gate to go
  green" spirit of AGENTS.md rule #12. The mitigation is the calibration policy plus
  the weekly apple-calibration report that surfaces estimate-vs-actual drift.
- **Doc drift.** The threshold lives in prose across many docs/personas; the guard
  help text and the `test:guards` suite pin the behavior, but stale prose could
  still mislead. Mitigated by syncing every non-historical reference in this change.

## Alternatives Considered

### 1. Keep code review required at all tiers

Rejected: this is the status quo whose ceremony cost on 1–2🍎 changes motivated the
change. CI + `verify:fast` already cover the correctness floor for trivial diffs.

### 2. Drop code review to 4🍎+ (align with multi-model review)

Rejected: 3🍎 changes are substantial enough (multi-system or non-trivial logic) to
warrant at least a single-model code-review loop; moving the floor to 4🍎 would lose
real signal on the middle tier.

### 3. Also drop the plan-review floor

Rejected and explicitly out of scope: the pre-code plan review is cheap relative to
its value (it catches design issues before code exists) and the human decision kept
it at 2🍎+.

## Verification

- `npm run test:guards` (215 tests) passes, including updated
  `requiredStagesForApples` expectations and new tier-1 (no stages), tier-2
  (plan_review only), and "code_review becomes required at 3🍎" cases.
- The `pr-review-ledger` guard help text and all non-historical policy/skill/persona
  docs were synced to the new matrix (historical handoffs, ledgers, and metrics are
  intentionally left untouched as an audit trail).
