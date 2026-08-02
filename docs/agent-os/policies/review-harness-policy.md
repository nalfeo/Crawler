# Review Harness Policy — Apple-Scaled Review Before PR

## Purpose

Scale the amount of **review** a change receives to its **apple complexity**, and
make that review _provable_ before a PR is opened. The harness encodes a simple
rule: bigger changes get more eyes — a separate-model plan review (an
**adversarial** red-team at the top tier) and multi-model code review with
adjudication — and every required stage is recorded in an auditable **review
ledger** that a deterministic guard checks at the `create_pull_request` boundary.

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

### Investigation-only sessions

Investigation/repro/debug sessions are intentionally lightweight when they do
**not** produce merge-intent code changes. In that mode, you may skip
review-ledger and PR paperwork. If the investigation finds a fix that should
land, spin that into a **separate implementation session/PR** and run the full
normal process there (apple declaration, verify gates, review harness/ledger,
handoff).

## Trigger (apple tiers → required stages)

The required stages scale with the apple estimate you declare per
[`complexity-policy.md`](complexity-policy.md):

| Apples | ledger      | plan review        | code review (loop) | multi-model review | independent grade |
| ------ | ----------- | ------------------ | ------------------ | ------------------ | ----------------- |
| 1🍎    | **none**    | —                  | —                  | —                  | —                 |
| 2🍎    | **none**    | —                  | —                  | —                  | —                 |
| 3🍎    | ✅ required | ✅                 | ✅                 | —                  | ✅                |
| 4–5🍎  | ✅ required | ✅ **adversarial** | ✅                 | ✅                 | ✅                |

- **no ledger at all** (1–2🍎, since 2026-08-02) — a 1–2🍎 change requires **no
  review stages**, so its ledger recorded nothing but the tier. 341 of the 693
  committed ledgers (49%) were exactly that: content-free files that existed only
  to satisfy the guard. Those tiers now require **no ledger file**. See
  "Enforcement" for the trade-off this forces and the compensating control.
- **plan review** (≥3🍎) — a _separate model_ reviews the plan before any code is
  written; every concern is resolved. The plan-review floor was raised **2🍎 → 3🍎
  on 2026-07-07** to match the code-review floor, which already moved to 3🍎 on
  **2026-07-02** (ADR 0036 / handoff
  `docs/knowledge/handoffs/2026-07-02-streamline-verify-ci-gates.md`). A 2🍎 change
  now records its tier in a ledger but requires **no** review stages.
- **adversarial plan review** (4–5🍎) — at the top tier the plan review must
  **red-team** the design: the reviewer enumerates **≥2 alternative approaches** and
  argues _against_ the chosen design, then records `adversarial: true` and
  `alternatives_considered ≥ 2`. This **replaced the former `dual_plan_synthesis`
  stage** (ADR 0051, 2026-07-08): reading all historical ledgers showed the two
  independent plan authors produced a genuine "decisive fork" on only **2/17 (12%)**
  of firings — elsewhere the value was _critic_ value, which one strong adversarial
  reviewer delivers at ⅓ the cost (one pre-code invocation instead of three).
  `dual_plan_synthesis` remains a **legacy/optional** stage (still validated if
  present) so historical ledgers stay parseable, but is **no longer required** and
  should not be added to a new ledger.
- **`plan_divergence` instrumentation** — every _required_ plan review (≥3🍎)
  records `plan_divergence: convergent | minor | major_fork`, the reviewer's
  classification of whether exploring the alternatives revealed a real design fork.
  This accumulates fork-rate data across all tiers so the 2/17 baseline can be
  re-measured going forward (ADR 0051). Optional (validated if present) on a
  voluntary sub-3🍎 plan review.
- **code review** (≥3🍎) — run the appropriate review agent(s), address feedback,
  **loop until no concerns remain _or_ escalate to a human** (see below).
- **multi-model review** (>3🍎) — run each appropriate review agent across
  _multiple distinct models_; a final reasoning model adjudicates validity +
  remedy; fixes are **delegated**; **loop until clean _or_ escalate to a human**.
- **independent grade** (≥3🍎, schema v2) — a model that took **no part** in
  authoring or reviewing the change reads the **actual diff** (never the ledger's
  self-report) and scores it 1–5 on five fixed criteria — `correctness`,
  `scope_discipline`, `test_coverage`, `policy_compliance`, `maintainability` —
  then returns a `pass`/`fail` verdict and findings. Run it with
  `npm run review:grade` (see "The independent grader"). The validator rejects a
  `grader_model` that appears in any other stage, and a `fail` verdict must carry
  an `escalated_to_human` record — it can never be recorded as a quiet pass.

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
  [the ledger-recipes reference](../../../.github/skills/review-harness/references/ledger-recipes.md)
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
3. **No ledger → allow, with a reminder.** A 1–2🍎 change legitimately has none.
4. **Any added ledger is validated** for completeness against its declared apple
   tier. Incomplete or invalid → **hard deny** with the exact failing rule.

### The trade-off this makes explicit

The apple tier is only knowable **from** the ledger. So the moment 1–2🍎 changes
stop committing one, a _missing_ ledger can no longer be a hard gate — an agent
that skips the ledger on a 4🍎 change looks identical to a legitimate 1🍎 change.
The ≥3🍎 ledger is therefore an **artifact-trust** gate (the same model as the
handoff requirement), not a hard one. What remains hard:

- a ledger that IS present must be complete and internally consistent for its tier;
- the ≥3🍎 `independent_grade` stage is the **compensating control** — it is the
  one stage graded from the diff by a model with no stake in the change.

The same validator backs the CLI and the guard, so `validate` exiting 0 locally
means the guard will allow the PR.

The guard tests (and the rest of the copilot-guards suite) run in CI via
`npm run test:guards`, wired into the `check-format-and-labs` job and
`scripts/agent/verify.sh`.

## The independent grader

`npm run review:grade` produces the ≥3🍎 `independent_grade` stage. Like every
other stage, the model call is dispatched by **you** (the `task` tool, with an
explicitly different model) — the script owns the deterministic half:

```
# 1. Build the grading packet: the REAL branch diff + the fixed rubric.
#    It also prints every model that must NOT grade this change.
npm run review:grade -- prompt <ledgerPath> [--out files/grade-prompt.md]

# 2. Dispatch that prompt to an independent model, save its reply, then:
npm run review:grade -- record <ledgerPath> --model <graderModel> \\
  --implementer <authoringModel> --file <replyPath>
```

`record` **recomputes** the verdict from the returned scores and findings rather
than taking the model's word: a reply that scores any criterion below 3, or
reports a blocker-severity finding, cannot be recorded as a `pass`. Findings are
schema-validated on the way in (`severity` must match `blocker`/`major`/`minor`
exactly, with a non-empty `file` and `detail`), because an unvalidated findings
array is a blocker-detection bypass — `severity: "BLOCKER"` or a bare string
would be counted as a finding but not as a blocker. It then re-validates the
whole ledger and exits non-zero if anything is still incomplete.

The **ledger validator re-derives the same rule**, not just the CLI: the guard
trusts the validator, so a hand-authored ledger claiming `pass` over a score
below 3 or an unresolved blocker is rejected outright.

Independence is checked against the **author** as well as the reviewers.
`implementer_model` records the model that wrote the change, and a
`grader_model` equal to it — or to any plan/code/multi-model reviewer — is
rejected. Grading your own work is the failure mode this stage exists to prevent.

Because the grade is bound to a `head_sha` (validated as a real 7–40 char hex
object id, not just a non-empty string), a grade cannot be silently carried
across a rewrite of the branch — re-grade after you change the diff.

### Schema v2 and the historical corpus

Adding a required stage would retroactively invalidate every ≥3🍎 ledger already
merged. So `independent_grade` is required **only on `review-ledger/v2`** ledgers
(the version `init` now writes); the ~350 merged v1 ledgers keep validating under
the v1 rules. The cutover is forward-only, and both versions stay supported by
the same validator.

That alone would leave a hole: a new ≥3🍎 ledger could simply _declare_ v1 and
skip the stage. So v1 is accepted **only for ledgers dated before
`2026-08-03`** (the day after the stage landed, so ledgers already authored by
in-flight sessions on the cutover day are not retroactively invalidated). A
ledger dated on or after the cutover must declare v2.

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
- Adversarial-fold rationale + backward-compat: [ADR 0051](../../knowledge/adr/0051-adversarial-plan-review-fold.md) (supersedes the `dual_plan_synthesis` requirement in [ADR 0036](../../knowledge/adr/0036-raise-code-review-floor.md))
