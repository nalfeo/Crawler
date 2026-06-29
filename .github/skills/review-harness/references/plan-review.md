# Plan review (>1🍎) and dual-plan synthesis (>3🍎)

These stages happen **before** you write code.

## Models (current task-tool ids)

- Reasoning/judge/reviewer: `gpt-5.4` (xhigh), `claude-opus-4.8`, `gpt-5.5`.
- Plan authors (use two _different_ ones): `gpt-5.5`, `gemini-3.1-pro-preview`,
  `claude-opus-4.7`.

> Pick whatever is appropriate; the validator only requires the _roles_ to be
> filled with **non-empty, distinct** model ids where the tier demands distinct
> models. Record the exact ids you actually used.

---

## Dual-plan synthesis (only >3🍎)

Generate two independent plans with two different models, then have a third
reasoning model judge and synthesize the final plan. Do this **before** the plan
review (the plan review reviews the synthesized result).

1. Launch two planning agents in parallel (one tool block, two `task` calls):

   ```
   task(agent_type="general-purpose", model="gpt-5.5", reasoning_effort="high",
        name="plan-a",
        prompt="<full task context>. Produce a complete, ordered implementation
                plan: files to touch, tests, risks, verification. Do NOT write code.")

   task(agent_type="general-purpose", model="gemini-3.1-pro-preview",
        reasoning_effort="high", name="plan-b",
        prompt="<same full context>. Produce a complete, ordered implementation
                plan ... Do NOT write code.")
   ```

2. Synthesize with a third model (different from both authors). You can do this
   yourself if you are that reasoning model, or delegate:

   ```
   task(agent_type="general-purpose", model="claude-opus-4.8", reasoning_effort="high",
        name="plan-judge",
        prompt="Here are two plans for <task>:\n\nPLAN A:\n...\n\nPLAN B:\n...\n
                Judge both, take the stronger parts of each, and output ONE
                final synthesized plan. Call out where they disagreed and why
                you chose what you chose.")
   ```

3. Write the synthesized plan into your `plan.md`, then record the stage:

   ```
   npm run review:ledger -- stage <path> dual_plan_synthesis --json \
     '{"completed":true,"plan_models":["gpt-5.5","gemini-3.1-pro-preview"],"judge_model":"claude-opus-4.8","notes":"<1-line synthesis summary>"}'
   ```

   Validator: exactly **2 distinct** `plan_models`; `judge_model` non-empty and
   **not** one of the plan models.

---

## Plan review (>1🍎)

A _separate model_ reviews your plan and you address every concern before coding.

1. Run the review (the `rubber-duck` agent is purpose-built for plan/impl
   critique):

   ```
   task(agent_type="rubber-duck", model="gpt-5.4", reasoning_effort="high",
        name="plan-review",
        prompt="Review this implementation plan for <task>. Surface bugs, design
                flaws, missing edge cases, and ordering problems. Return a verdict
                (approved / approved_with_changes / rejected) and a numbered list
                of concerns.\n\nPLAN:\n<paste plan.md>")
   ```

2. **Address every concern.** Adopt, or write down a grounded reason not to. The
   validator requires `resolved_count >= concerns_count`, so leaving a concern
   unaddressed without resolving it is a deny — fix it, don't undercount it.

3. Record the stage:

   ```
   npm run review:ledger -- stage <path> plan_review --json \
     '{"completed":true,"reviewer_model":"gpt-5.4","concerns_count":6,"resolved_count":6,"notes":"all adopted"}'
   ```

   Validator: `completed===true`, `reviewer_model` non-empty,
   `resolved_count >= concerns_count`, both counts integers ≥ 0.

> Tip: append the reviewer's concerns + your resolutions to `plan.md` (a "Plan
> Review Resolutions" section) so the audit trail lives next to the plan.
