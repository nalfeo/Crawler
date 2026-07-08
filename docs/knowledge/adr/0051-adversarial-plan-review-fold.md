# ADR 0051: Replace Dual-Plan Synthesis with an Adversarial Plan Review (+ `plan_divergence` instrumentation)

**Date:** 2026-07-08  
**Affected Systems:** review harness (`scripts/agent/review/ledger.mjs`, `scripts/agent/review/cli.mjs`), `pr-review-ledger` guard, review-harness skill + policy docs, complexity policy, persona docs

## Status

Accepted (2026-07-08).

## Estimated Complexity

🍎 × 4 — tier-conditional validator logic (a new axis threaded into the
single-source-of-truth `validatePlanReview`), a HARD gate (#14) the whole team
depends on, a new instrumentation field on **every** ≥3🍎 ledger, plus a wide
policy/skill/persona/ADR doc sync. Not gameplay/runtime, but the blast radius and
the "editing a hard gate" risk push it past 3🍎.

> Irony, noted honestly: removing dual-plan synthesis is itself a 4🍎 change, so
> under the **current** rules it ran one final `dual_plan_synthesis` stage (two
> plan authors + a judge) before this ADR took effect. A fitting send-off rather
> than a self-exemption.

## Context

The apple-scaled review harness (ADR 0036) requires, at **4–5🍎**, a
`dual_plan_synthesis` stage: **two** implementation plans authored by **two
different** models, then a **third** reasoning model judges and synthesizes the
final plan — **3 pre-code agent invocations**. The thesis was that a second
independent author explores the design space and catches wrong architectures a
single planner would commit to.

An empirical audit of **all 124 review ledgers** under
`docs/knowledge/review-ledgers/` tested that thesis:

- `dual_plan_synthesis` fired on **17/124** changes (all 4–5🍎).
- Classifying the 17 synthesis notes by how much the two independent plans
  **actually diverged**:
  - **2/17 (12%) were "decisive forks"** — the second author surfaced a
    genuinely different architecture and the judge killed a wrong path. Both were
    system-ordering / integration-contract calls (`spawner-battle-arena`,
    `spawner-red-placeholders`).
  - **~7/17 were "partial"** — the plans mostly converged and the judge pruned an
    over-engineered or erroneous **detail**. That is **critic** value, which a
    single reviewer on one plan also delivers.
  - **~8/17 were "convergent/none"** — the two plans agreed; the second author
    added nothing.
- Plan-review **concern counts keep rising with tier even after synthesis** (4🍎
  draws the most plan-review concerns, ~6.2 mean). The **critic** — not the second
  author — does the heavy lifting.

Conclusion: the second independent **author** earns its 3× cost on only a minority
of changes with a genuine design fork; everywhere else the value is **critic**
value, which a plan review already provides at ⅓ the cost.

## Decision

**Fold dual-plan synthesis into a stronger, adversarial plan review, and add an
instrumentation signal so we can measure the real fork rate going forward.** This
is a deliberate, human-approved **scope refinement** of HARD gate #14 — **not**
gate-weakening (AGENTS.md rule #12): the design-space-exploration safety net still
fires for the risky class (now via a red-teaming critic), and we only remove the
redundant second author on the ~85% of >3🍎 changes that converge.

Concretely, in `requiredStagesForApples()` (the single source of truth):

```js
if (apples >= 4) return ['plan_review', 'code_review', 'multi_model_review'];
if (apples >= 3) return ['plan_review', 'code_review'];
return [];
```

New required-stage matrix:

| apples | plan_review          | code_review | multi_model_review |
| ------ | -------------------- | ----------- | ------------------ |
| 1🍎    | —                    | —           | —                  |
| 2🍎    | —                    | —           | —                  |
| 3🍎    | ✅                   | ✅          | —                  |
| 4–5🍎  | ✅ (**adversarial**) | ✅          | ✅                 |

`dual_plan_synthesis` is **removed from required** but **kept as a legacy/optional
stage** — still validated if present, still in `STAGE_NAMES`, but no longer
scaffolded by `init` and not part of any required set.

### New `plan_review` fields (tier-conditional)

| field                     | <3🍎 (voluntary) | 3🍎          | 4–5🍎                |
| ------------------------- | ---------------- | ------------ | -------------------- |
| `plan_divergence` (enum)  | optional         | **required** | **required**         |
| `adversarial` (bool)      | optional         | optional     | **required `true`**  |
| `alternatives_considered` | optional (int≥0) | optional     | **required int ≥ 2** |

- **`adversarial: true`** (required @4–5🍎): the reviewer must **red-team** the
  design — enumerate ≥2 concrete alternative approaches and argue _against_ the
  chosen design. This is the fold: one critic captures the design-space
  exploration the second author used to provide.
- **`alternatives_considered` ≥ 2** (required @4–5🍎): a countable floor for the
  red-team.
- **`plan_divergence ∈ {convergent, minor, major_fork}`** (required @≥3🍎): the
  **instrumentation** signal. Every plan review classifies whether exploring
  alternatives revealed a genuine fork, so we accumulate a true fork-rate across
  **all** plan-review tiers (not just 4–5🍎) and can revisit this decision with
  data. Required at the same floor as `plan_review` itself.

### Operational rubric for `plan_divergence` (avoid a subjective enum)

Classify by the **adjudication outcome**, not by how much the reviewer wrote:

| value        | meaning                                                                                                                 |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `convergent` | alternatives were considered but none changed the plan; the chosen design stood as-is.                                  |
| `minor`      | the review pruned/added a **detail** (over-engineered piece, missed edge case) — no re-architecture.                    |
| `major_fork` | an alternative was genuinely better on a **load-bearing** decision and the plan was re-architected (a "decisive fork"). |

The enum values map onto the audit's three buckets: convergent/none → `convergent`,
partial → `minor`, decisive-fork → `major_fork`.

### No `schema_version` v2 axis (era partition = field presence)

We deliberately do **not** bump `schema_version` to gate the new rules on a version
flag. A version gate would let a hand-written "v1" ledger legally skip the new HARD
requirements — a rule-#12 footgun. Instead, analytics partition eras by **field
presence**: a ledger with a `plan_review` that has **no `plan_divergence`** and/or
**carries `dual_plan_synthesis`** is pre-0051; one _with_ `plan_divergence` is
post-0051. `SCHEMA_VERSION` stays `review-ledger/v1`.

## Consequences

### Positive

- 4–5🍎 pre-code review drops from **3 agent invocations to 1** (a single
  adversarial reviewer) — ~⅔ cheaper — while keeping the critic that the data
  shows does the real work.
- The red-team requirement (`adversarial` + `alternatives_considered ≥ 2`) makes
  the design-space exploration **explicit and auditable** in one place, rather than
  implicit in a discarded second plan.
- `plan_divergence` turns the "does a second author pay off?" question into a
  measured signal across all tiers, so the decision is revisitable with real data.
- One source of truth (`requiredStagesForApples` + `validatePlanReview`) still
  drives the guard, the CLI scaffolder, the docs, and the tests, so the matrix
  cannot drift silently.

### Negative

- The `plan_divergence` classification is a **subjective judgment**. Mitigated by
  the operational rubric above (judge by adjudication outcome) and the notes
  template in the skill (record the alternatives + why each was rejected).
- Every 3🍎+ ledger now carries one extra enum field; a 4–5🍎 ledger carries three
  new `plan_review` fields. Minor authoring overhead, offset by dropping the whole
  `dual_plan_synthesis` stage.
- We lose the _occasional_ genuine second-author fork (~12%). Mitigated: the
  adversarial reviewer is explicitly tasked to surface exactly those forks, and
  `major_fork` instrumentation will tell us if that mitigation is failing.

### Risks

- **Historical 4🍎 ledgers no longer satisfy the current required-field set.** A
  pre-0051 ledger (no `plan_divergence`, carries `dual_plan_synthesis`) would fail
  if **explicitly re-validated** against the new rules. This is **by design and
  safe**: the guard only re-validates ledgers **added on a branch** (`validate`
  with no path checks the newest; there is no bulk re-validation consumer), so the
  ~17 historical ledgers on `main` are never re-checked. Keeping
  `validateDualPlanSynthesis` + `dual_plan_synthesis` in `STAGE_NAMES` means a
  historical ledger that _is_ opened still parses. A dedicated test asserts a
  literal historical-style 4🍎 fixture (dual_plan_synthesis, no plan_divergence)
  is rejected under the new rules — pinning the intended, safe behavior.
- **Doc drift.** The policy lives in prose across many docs/personas; the guard
  help text and `test:guards` pin the enforced behavior, but stale prose could
  mislead. Mitigated by syncing every non-historical reference in this change and a
  pre-PR grep audit for stale "4–5🍎 … dual-plan synthesis (required)" wording.
- **Under-red-teaming.** `adversarial:true` + `alternatives_considered:2` are
  honor-system counts (rule #12 applies). The forcing function is the recorded
  notes + the `plan_divergence` audit trail, not cryptographic proof.

## Alternatives Considered

### 1. Keep dual-plan synthesis as-is

Rejected: the empirical 2/17 (12%) decisive-fork rate does not justify a standing
3× pre-code cost on all 4–5🍎 changes. The status quo spends the most on the tier
that already draws the most _critic_ concerns.

### 2. Drop dual-plan synthesis with **no** replacement

Rejected: that would discard the design-space-exploration value entirely, including
on the genuine-fork minority. The adversarial fold keeps that value from a single
critic at ⅓ the cost.

### 3. Gate the new rules behind a `schema_version` v2 bump

Rejected (this was the one **fork** the dual-plan synthesis for _this_ change
surfaced; the judge ruled against it). A version flag would let a hand-authored
"v1" ledger legally skip the new HARD requirements — a rule-#12 footgun — and there
is no re-validation path that needs the flag anyway. Eras partition cleanly by
field presence (see Decision). `plan_divergence` for this change was therefore
`minor`: the adjudication pruned an over-engineered detail a single critic catches
— which is itself evidence for the thesis.

### 4. Require `plan_divergence` only at 4–5🍎

Rejected: we want fork-rate data across **every** tier that runs a plan review, so
the field is required at the `plan_review` floor (≥3🍎). The marginal cost is one
enum value per 3🍎 ledger.

## Verification

- `npm run test:guards` passes, including: `requiredStagesForApples` 4🍎 → 3-stage
  set (no `dual_plan_synthesis`); `adversarial` required@4 / not@3; `alternatives_considered ≥ 2`@4
  (rejects 1); `plan_divergence` required@3 & @4, bad-enum rejected, optional-if-present@2;
  tier-boundary cases (apples null/2/3/4/5); a legacy `dual_plan_synthesis` ledger still
  validates; a 4🍎 ledger missing `dual_plan_synthesis` is now valid; and a literal
  historical-style 4🍎 fixture fails under the new rules (by design).
- `npm run review:ledger -- validate <path>` on this change's own 4🍎 ledger
  (authored under the **current** rules: `plan_review` + `dual_plan_synthesis` +
  `code_review` + `multi_model_review`).
- `pr-review-ledger` guard help text and all non-historical policy/skill/persona/complexity
  docs synced to the new matrix; historical handoffs, ledgers, and metrics left
  untouched as an audit trail.
- Forward-annotated ADR 0036 (kept **Accepted** — its code-review-floor decision is
  unchanged; only the 4–5🍎 dual-plan-synthesis requirement it recorded is superseded here).
