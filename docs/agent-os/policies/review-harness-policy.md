# Review Harness Policy — Apple-Scaled Review Before PR

## Purpose

Scale the amount of **review** a change receives to its **apple complexity**, and
make that review _provable_ before a PR is opened. The harness encodes a simple
rule: bigger changes get more eyes — a separate-model plan review, two competing
plans judged into one, and multi-model code review with adjudication — and every
required stage is recorded in an auditable **review ledger** that a deterministic
guard checks at the `create_pull_request` boundary.

This is the canonical definition. `AGENTS.md` and
`.github/copilot-instructions.md` restate it; the
[`review-harness` skill](../../../.github/skills/review-harness/SKILL.md) is the
operator playbook; `scripts/agent/review/ledger.mjs` is the single source of
truth for validation.

## Scope

Required for **any code-touching change** you intend to PR. A diff is exempt only
when **every** changed file is one of:

- **Docs** — `docs/**`, or a root-level `*.md` / `*.txt`.
- **Art** — `public/assets/**`, `briefs/**`, `data/palettes/**`.
- **Dependency lockfiles** — `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`.

Everything else is **code**: `src/**` (never exempt), `scripts/**`,
`.github/workflows/**`, `.github/extensions/**`, `.github/skills/**`,
`.github/instructions/**`, `.github/copilot-instructions.md`, and build/tooling
config (`eslint.config.js`, `vite`/`vitest`/`tsconfig`/`commitlint`, and
`package.json`). The strict allowlist lives in
`.github/extensions/copilot-guards/lib/pr-scope.mjs`.

## Trigger (apple tiers → required stages)

The required stages scale with the apple estimate you declare per
[`complexity-policy.md`](complexity-policy.md):

| Apples | plan review | dual-plan synthesis | code review (loop) | multi-model review |
| ------ | ----------- | ------------------- | ------------------ | ------------------ |
| 1🍎    | —           | —                   | —                  | —                  |
| 2🍎    | —           | —                   | —                  | —                  |
| 3🍎    | ✅          | —                   | ✅                 | —                  |
| 4–5🍎  | ✅          | ✅                  | ✅                 | ✅                 |

- **plan review** (≥3🍎) — a _separate model_ reviews the plan before any code is
  written; every concern is resolved. The plan-review floor was raised **2🍎 → 3🍎
  on 2026-07-07** to match the code-review floor, which already moved to 3🍎 on
  **2026-07-02** (ADR 0036 / handoff
  `docs/knowledge/handoffs/2026-07-02-streamline-verify-ci-gates.md`). A 2🍎 change
  now records its tier in a ledger but requires **no** review stages.
- **dual-plan synthesis** (>3🍎) — two plans authored by two _different_ models, a
  _third_ reasoning model judges + synthesizes the final plan.
- **code review** (≥3🍎) — run the appropriate review agent(s), address feedback,
  **loop until no concerns remain _or_ escalate to a human** (see below).
- **multi-model review** (>3🍎) — run each appropriate review agent across
  _multiple distinct models_; a final reasoning model adjudicates validity +
  remedy; fixes are **delegated**; **loop until clean _or_ escalate to a human**.

## Bounded review loop — cap at 2 rounds, then escalate to a human

The `code_review` and `multi_model_review` loops are **not** unbounded. Looping
"until clean" with no terminal state means an agent that hits a genuinely
intractable concern spins forever (or, worse, is tempted to weaken the ledger to
escape). Both stages therefore support an explicit **terminal `escalated_to_human`
state**:

- A stage is **complete** when EITHER (a) the last round is `clean:true` (the
  normal path), OR (b) it records a valid `escalated_to_human` **after at least 2
  genuinely-attempted rounds**.
- Escalation is **never** allowed on round 1, and is **never** a silent skip or
  short-circuit. It is a recorded terminal state a human must act on.
- Escalation is **not clean**: an escalated stage must set `clean:false`, its final
  round must be non-clean with genuine unresolved concerns, and it records
  `{ after_round, reason, unresolved_concerns }` (with `after_round` equal to the
  final round index, so no rounds may follow the escalation). See
  [`references/ledger-recipes.md`](../../../.github/skills/review-harness/references/ledger-recipes.md)
  for the exact schema.

This is a **safety win**: a bounded loop plus forced human attention replaces an
unbounded silent loop. Escalating is always preferable to weakening a gate
(project rule #12).

## Downward-only, diff-justified apple re-scoring

You may revise your apple estimate **after** planning, but only **strictly
downward** and only when the **actual diff** justifies it (e.g. a change you sized
at 4🍎 collapsed into a one-file tweak). Record it with two optional top-level
ledger fields:

- `apples_rescored_from` — the original, higher estimate (must be an integer 1..5
  and **strictly greater** than `estimated_apples`; upward or no-op re-scores are
  rejected by the validator).
- `rescore_reason` — a non-empty justification (required whenever
  `apples_rescored_from` is present; a lone `rescore_reason` is rejected).

A downward re-score makes the required stages follow the **new lower tier**.
Because the validator checks **every present stage**, you must **prune** (remove)
any now-unrequired stages that are still incomplete scaffolds — otherwise they
fail validation. "Justified by the diff" is **honor-system + policy** (rule #12),
not mechanically provable: never re-score down merely to dodge a stage.

## The review ledger

A small JSON artifact committed at
`docs/knowledge/review-ledgers/YYYY-MM-DD-<slug>.review-ledger.json`. It records
which stages ran and their outcomes (models used, concern/resolution counts,
per-round cleanliness). Author and validate it with the CLI:

```
npm run review:ledger -- init --apples <N> --slug <kebab> --title "<title>"
npm run review:ledger -- stage <path> <stageName> --json '{...}'
npm run review:ledger -- validate <path>
```

The exact stage schemas and validator rules live in
`scripts/agent/review/ledger.mjs` and are documented in the skill's
[`.github/skills/review-harness/references/ledger-recipes.md`](../../../.github/skills/review-harness/references/ledger-recipes.md).

## Enforcement

The `pr-review-ledger` guard (`.github/extensions/copilot-guards/guards/pr-review-ledger.mjs`)
runs on `create_pull_request`, and local `npm run verify` now runs
`npm run verify:pr-prereqs` to surface the same ledger/preflight blockers earlier
in the execution-complete loop:

1. Computes the branch diff. A docs/art/deps-only diff is **skipped**.
2. For a code-touching diff, it looks for a review ledger **added on this branch**
   (an old ledger on `main` does not count).
3. It **validates** every added ledger for completeness against its declared
   apple tier. Missing or incomplete → **hard deny** with the exact failing rule.

The same validator backs the CLI and the guard, so `validate` exiting 0 locally
means the guard will allow the PR.

The guard tests (and the rest of the copilot-guards suite) run in CI via
`npm run test:guards`, wired into the `check-format-and-labs` job and
`scripts/agent/verify.sh`.

## What it does NOT do (honesty caveat)

The ledger is an **honor-system artifact**, exactly like the handoff requirement.
The guard validates _completeness_ — that the required stages are present and
internally consistent — **not truthfulness**. It cannot verify that a review
actually happened or that you reported counts honestly. Its value is the forcing
function plus the audit trail.

Therefore (project rule #12, non-negotiable): **never weaken a stage to go green.**
Do not lower a `concerns_count`, flip `clean` to `true`, or reuse one model where
the tier demands distinct models. If a review surfaces a concern you cannot
resolve, fix it or escalate to the human — do not edit the ledger around it.

## Bypass

For genuine edge cases (reverts, emergency infra fixes), disable the guard for the
session with `COPILOT_GUARDS_DISABLE=pr-review-ledger` and document why in the PR.
See [`.github/extensions/copilot-guards/README.md`](../../../.github/extensions/copilot-guards/README.md).

## Cross-links

- Skill / playbook: [`.github/skills/review-harness/SKILL.md`](../../../.github/skills/review-harness/SKILL.md)
- Apple scale: [`complexity-policy.md`](complexity-policy.md)
- Guard catalogue: [`.github/extensions/copilot-guards/README.md`](../../../.github/extensions/copilot-guards/README.md)
- Validator (source of truth): `scripts/agent/review/ledger.mjs`
