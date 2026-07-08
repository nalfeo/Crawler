# Plan review (≥3🍎) — ADVERSARIAL at 4–5🍎

These stages happen **before** you write code.

## Models (current task-tool ids)

- Reasoning/judge/reviewer: `gpt-5.4` (xhigh), `claude-opus-4.8`, `gpt-5.5`.
- Adversarial plan reviewer (4–5🍎, one _separate_ model): `gpt-5.4` (xhigh),
  `claude-opus-4.8`, `gpt-5.5`.
- Legacy dual-plan authors (only if recording the optional `dual_plan_synthesis`
  stage — see below): two _different_ of `gpt-5.5`, `gemini-3.1-pro-preview`,
  `claude-opus-4.7`.

> Pick whatever is appropriate; the validator only requires the _roles_ to be
> filled with **non-empty, distinct** model ids where the tier demands distinct
> models. Record the exact ids you actually used.

---

## `dual_plan_synthesis` is LEGACY-ONLY (retired at 4–5🍎 by ADR 0051)

**As of ADR 0051 (2026-07-08), `dual_plan_synthesis` is no longer a required
stage at any tier.** Reading all historical ledgers showed that two independent
plan authors produced a genuinely _decisive_ fork on only **2/17 (12%)** of
firings; elsewhere the value was _critic_ value. So at 4–5🍎 the single
`plan_review` is now **adversarial** (one reviewer, ⅓ the cost) — see the next
section.

`dual_plan_synthesis` stays a **legacy/optional** stage: the validator still
accepts it if present (so the ~17 historical ledgers stay parseable), but `init`
no longer scaffolds it and you should **not** add it to a new ledger. If you ever
need to record it anyway, the shape is unchanged:

```
npm run review:ledger -- stage <path> dual_plan_synthesis --json \
  '{"completed":true,"plan_models":["gpt-5.5","gemini-3.1-pro-preview"],"judge_model":"claude-opus-4.8","notes":"<summary>"}'
```

(exactly **2 distinct** `plan_models`; `judge_model` non-empty and **not** one of
the plan models.)

---

## Plan review (≥3🍎) — ADVERSARIAL at 4–5🍎

A _separate model_ reviews your plan and you address every concern before coding.
(The plan-review floor was raised 2🍎 → 3🍎 on 2026-07-07; a 2🍎 change requires no
review stages.)

At **4–5🍎 the review must be ADVERSARIAL**: the reviewer red-teams the design —
enumerates **≥2 concrete alternative approaches** and argues _against_ the chosen
design — so we keep the design-space-exploration value the retired
dual-plan-synthesis stage used to provide, from a single critic.

1. Run the review (the `rubber-duck` agent is purpose-built for plan/impl
   critique). At 4–5🍎, instruct it to red-team:

   ```
   task(agent_type="rubber-duck", model="gpt-5.4", reasoning_effort="high",
        name="plan-review",
        prompt="Adversarially review this implementation plan for <task>. FIRST
                enumerate at least 2 credible ALTERNATIVE approaches and argue
                against the chosen design (what would a reviewer who dislikes this
                plan say?). THEN surface bugs, design flaws, missing edge cases,
                and ordering problems. Return a verdict (approved /
                approved_with_changes / rejected), a numbered list of concerns,
                and whether a genuinely different architecture is warranted.
                \n\nPLAN:\n<paste plan.md>")
   ```

2. **Address every concern.** Adopt, or write down a grounded reason not to. The
   validator requires `resolved_count >= concerns_count`, so leaving a concern
   unaddressed without resolving it is a deny — fix it, don't undercount it.

3. **Classify `plan_divergence`** (required at ≥3🍎) with this operational rubric —
   judge by the _adjudication outcome_, not by how much the reviewer wrote:

   | value        | meaning                                                                                               |
   | ------------ | ----------------------------------------------------------------------------------------------------- |
   | `convergent` | alternatives were considered but none changed the plan; the chosen design stood as-is.                |
   | `minor`      | the review pruned/added a DETAIL (an over-engineered piece, a missed edge case) — no re-architecture. |
   | `major_fork` | an alternative was genuinely better on a load-bearing decision and the plan was re-architected.       |

4. Record the stage. At 4–5🍎 you MUST also record `adversarial` +
   `alternatives_considered`:

   ```
   npm run review:ledger -- stage <path> plan_review --json \
     '{"completed":true,"reviewer_model":"gpt-5.4","adversarial":true,"alternatives_considered":3,"plan_divergence":"convergent","concerns_count":6,"resolved_count":6,"notes":"<alts + why rejected>"}'
   ```

   A 3🍎 plan review records `plan_divergence` but not the adversarial fields:

   ```
   npm run review:ledger -- stage <path> plan_review --json \
     '{"completed":true,"reviewer_model":"gpt-5.4","plan_divergence":"minor","concerns_count":2,"resolved_count":2,"notes":"..."}'
   ```

   Validator: `completed===true`, `reviewer_model` non-empty,
   `resolved_count >= concerns_count`, both counts integers ≥ 0; at 4–5🍎
   `adversarial===true` and `alternatives_considered` integer ≥ 2; at ≥3🍎
   `plan_divergence ∈ {convergent, minor, major_fork}`.

> **Notes template (honesty — capture the actual red-team):** in `notes` (or a
> "Plan Review Resolutions" section of `plan.md`) record the alternatives you
> weighed and why you rejected them, e.g.
> `Alt A: <approach> — rejected because <reason>. Alt B: <approach> — rejected
because <reason>. Chosen: <design>. divergence=convergent (no alt beat it).`
> This makes the `plan_divergence` value auditable rather than rhetorical.
