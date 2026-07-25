# Contributing Guide

This workflow applies to both agents and humans.

## 1. Start from a fresh branch

- Branch from `main`
- Use one focused branch per task
- Do not push directly to `main`
- Keep branches small enough to review and verify quickly

## 2. Run preflight

At session start run:

```bash
bash scripts/agent/preflight.sh
```

Then load the relevant persona, recent handoffs, and any needed policy or guide docs.

### Sprite pipeline publication labels

Repository bootstrap for the sprite publication path should include this GitHub
label (the publisher now creates it on demand if it is missing before publishing):

- `art-only` — color `7057ff` — `Generated art-only changes eligible for guarded promotion`

## 3. Make focused changes

- Keep architectural changes aligned with the constitution
- If a decision affects 2+ systems, write or update an ADR
- If you add an ECS system, create its lab as part of the same change

## 4. Verify fast before push

After every meaningful change run:

```bash
npm run verify:fast
```

This is the minimum bar before pushing branch updates.

## 5. Verify before opening or updating a PR

Before a pull request, run:

```bash
npm run verify:fast
npm run verify:pr-prereqs
bash scripts/agent/lab-gate-check.sh
```

Reserve local full `npm run verify` runs for explicit human requests or targeted
diagnosis. Add `VERIFY_COVERAGE=1` to include coverage locally; add `VERIFY_FULL=1`
to also run the headless Floor 1 win-rate gate. CI enforces coverage, headless,
and e2e independently as required merge-gate inputs.

If the change adds or touches an ECS system, the lab gate is mandatory and the
real-pipeline wiring guard (`check:wired-systems`, ADR 0039) must pass — a lab
alone is not sufficient proof that the system runs in the real game or headless
pipeline.

## 5a. Apple-scaled review harness (before requesting review)

Before opening or updating a PR that touches code, run the apple-scaled review
harness and append the result to the review ledger. See
[`.github/skills/review-harness/SKILL.md`](../../.github/skills/review-harness/SKILL.md)
and [`docs/agent-os/policies/review-harness-policy.md`](../agent-os/policies/review-harness-policy.md).
Record the apple estimate (declared before writing code) and actuals + verdict
at handoff time per
[`docs/agent-os/policies/complexity-policy.md`](../agent-os/policies/complexity-policy.md).

## 5b. Observe before done (real-artifact validation)

For any change that adds/moves a system or alters runtime behavior, name the
**real pipeline artifact** you observed the behavior in — `npm run dev`, the
headless runner (`src/game/ai/headless-runner.ts`), or a win-rate sweep. A green
lab proves isolated correctness but can never prove the real game or headless
pipeline actually calls the system. See constitution Principle 13 and rule #14
in `AGENTS.md`.

## 6. Open a reviewable PR

Before requesting review:

- make sure the branch is up to date with `main`
- ensure CI passes deterministically
- keep the PR scoped so reviewers can understand intent quickly

## 7. Follow the handoff protocol

Before ending the session, write a handoff in `docs/knowledge/handoffs/`.

Include at least:

- what changed
- files touched
- commands run for verification
- open risks or follow-ups
- the recommended next action

## 8. Special rule: lab gate

No ECS system ships without a corresponding lab in `src/labs/`.

If the lab does not exist, the work is not done.
