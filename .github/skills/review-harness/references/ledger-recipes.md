# Review-ledger recipes

The ledger is a small JSON artifact under
`docs/knowledge/review-ledgers/<YYYY-MM-DD>-<slug>.review-ledger.json`. The CLI
(`npm run review:ledger -- ...`) is a thin wrapper around the validator in
`scripts/agent/review/ledger.mjs` (the single source of truth — the
`pr-review-ledger` guard imports the _same_ module).

## Lifecycle

> **1–2🍎 changes need NO ledger file at all** (they require no review stages).
> Only run this lifecycle at ≥3🍎.

```
# 1. Scaffold (only the stages your tier needs are created)
npm run review:ledger -- init --apples 4 --slug improve-local-harness --title "Encode apple-scaled review harness"

# 2. Fill in each stage as you complete it (shallow-merged into stages[name])
npm run review:ledger -- stage <path> plan_review        --json '{...}'
npm run review:ledger -- stage <path> code_review        --json '{...}'
npm run review:ledger -- stage <path> multi_model_review --json '{...}'
# dual_plan_synthesis is LEGACY-ONLY (retired by ADR 0051) — not scaffolded/required

# 2b. independent_grade is NOT hand-written — the grader CLI fills it in from
#     the real diff, after your code-review fixes have landed.
npm run review:grade -- prompt <path>
npm run review:grade -- record <path> --model <graderModel> --implementer <authoringModel> --file <reply> --head-sha <packetHeadSha>

# 3. Validate (exit 0 = guard will allow your PR). `validate` with no path
#    picks the newest ledger in the directory.
npm run review:ledger -- validate <path>
```

`init` flags: `--apples <1..5>` (required), `--slug <kebab>` (required),
`--title "<text>"` (required), `--date YYYY-MM-DD` (optional, defaults today),
`--force` (overwrite).

> **PowerShell quoting:** pass `--json` in single quotes and keep the inner JSON
> double-quoted, e.g. `--json '{"completed":true}'`. Do not backslash-escape the
> inner quotes. For a big multi-round patch it is often easier to edit the JSON
> file directly than to fight the shell.

## Tier → required stages

| apples | ledger file | stages the validator requires                                                         |
| ------ | ----------- | ------------------------------------------------------------------------------------- |
| 1      | not needed  | (none)                                                                                |
| 2      | not needed  | (none)                                                                                |
| 3      | required    | `plan_review`, `code_review`, `independent_grade`                                     |
| 4–5    | required    | `plan_review` (adversarial), `code_review`, `multi_model_review`, `independent_grade` |

`independent_grade` is required only on **`review-ledger/v2`** ledgers (what `init`
writes since 2026-08-02). The ~350 merged `review-ledger/v1` ledgers keep
validating under the v1 rules, so the cutover is forward-only.

The plan-review floor moved 2🍎 → 3🍎 on 2026-07-07 (matching the code-review
floor, which moved on 2026-07-02 / ADR 0036). A 2🍎 change requires **no** stages.
`dual_plan_synthesis` was **retired as a required 4–5🍎 stage by ADR 0051**
(2026-07-08) — the 4–5🍎 `plan_review` is now **adversarial** instead; the legacy
stage is still validated if present but is no longer scaffolded or required.

A stage that is _present but not required_ is **still validated** — don't add a
half-filled stage you didn't actually do. This matters when you **re-score
downward** (below): remove any now-unrequired incomplete scaffolds, or validation
will fail on them.

## Full tier-4 example

```json
{
  "schema_version": "review-ledger/v2",
  "date": "2026-06-29",
  "session_slug": "improve-local-harness",
  "task_title": "Encode apple-scaled review harness",
  "estimated_apples": 4,
  "stages": {
    "plan_review": {
      "completed": true,
      "reviewer_model": "gpt-5.4",
      "adversarial": true,
      "alternatives_considered": 3,
      "plan_divergence": "convergent",
      "concerns_count": 6,
      "resolved_count": 6,
      "notes": "Alt A/B enumerated + argued against; none beat the chosen design"
    },
    "code_review": {
      "clean": true,
      "rounds": [
        {
          "round": 1,
          "models": ["claude-sonnet-4.6"],
          "concerns_count": 3,
          "resolved_count": 3,
          "clean": true
        }
      ]
    },
    "multi_model_review": {
      "clean": true,
      "adjudicator_model": "gpt-5.4",
      "rounds": [
        {
          "round": 1,
          "models": ["claude-sonnet-4.6", "gpt-5.3-codex", "gemini-3.1-pro-preview"],
          "concerns_count": 5,
          "valid_count": 3,
          "resolved_count": 3,
          "clean": true
        }
      ]
    },
    "independent_grade": {
      "completed": true,
      "grader_model": "gemini-3.1-pro-preview",
      "implementer_model": "claude-opus-4.6",
      "head_sha": "9f1c2ab3d4e5f60718293a4b5c6d7e8f90a1b2c3",
      "criteria": {
        "correctness": 4,
        "scope_discipline": 5,
        "test_coverage": 4,
        "policy_compliance": 5,
        "maintainability": 4
      },
      "verdict": "pass",
      "findings_count": 1,
      "findings": [
        {
          "severity": "minor",
          "file": "src/game/loot.ts",
          "detail": "`rollTable` reads better as `rollLootTable`."
        }
      ],
      "notes": "One minor naming finding; no blockers, no criterion below 3."
    }
  }
}
```

## Per-stage validator rules (quick reference)

- **top-level**: `schema_version` ∈ {`"review-ledger/v1"`, `"review-ledger/v2"`};
  v1 is accepted **only** for ledgers dated before `2026-08-03` — a ledger dated
  on/after the cutover **must** declare v2, so a new ≥3🍎 ledger cannot dodge
  `independent_grade` by declaring the old version. `date` = `YYYY-MM-DD`;
  `session_slug` kebab-case; `task_title` non-empty; `estimated_apples` int 1..5;
  `stages` object.
- **plan_review**: `completed===true`; `reviewer_model` non-empty;
  `concerns_count`/`resolved_count` ints ≥0; `resolved_count >= concerns_count`.
  **Tier-conditional (ADR 0051):** at **≥3🍎** `plan_divergence ∈ {convergent,
minor, major_fork}` is **required** (instrumentation — the design fork-rate
  signal); at **4–5🍎** `adversarial===true` **and** `alternatives_considered`
  int ≥2 are also required. Below their required tier these fields are optional
  but validated-if-present (`adversarial` boolean, `alternatives_considered`
  int ≥0, `plan_divergence` in the enum).
- **independent_grade** _(REQUIRED at ≥3🍎 on schema v2)_: `completed===true`;
  `grader_model` non-empty **and absent from every other stage** (the whole point
  is independence — the validator collects the plan reviewer, the dual-plan
  models/judge, every code-review and multi-model round model, and the
  adjudicator, and rejects a grader among them); `implementer_model` non-empty and
  **different from `grader_model`** (independence from the _author_, not just the
  reviewers); `head_sha` a 7–40 char hex git sha (binds the grade to the graded
  tree); `criteria` scores **every** one of `correctness`, `scope_discipline`,
  `test_coverage`, `policy_compliance`, `maintainability` as an int 1..5 with no
  unknown keys; `verdict ∈ {pass, fail}`; `findings_count` int ≥0. `findings`, if
  present, must be objects with `severity ∈ {blocker, major, minor}` (exact
  match) plus non-empty `file`/`detail`, and its length must equal
  `findings_count`. A `verdict` of `pass` is **rejected** when any criterion
  scores below 3 or any `blocker` finding is listed — the validator re-derives
  the same rule the grader CLI applies, so a hand-authored ledger cannot claim a
  pass the scores do not support. A `fail` **requires** `escalated_to_human: { reason, unresolved_findings ≥ 1 }`,
  and that record is **rejected** alongside a `pass`. Write it with
  `npm run review:grade -- record`, not by hand.
- **dual_plan_synthesis** _(LEGACY-ONLY — retired as a required stage by ADR
  0051; still validated if present so historical ledgers stay parseable)_:
  `completed===true`; `plan_models` = exactly 2 distinct non-empty ids;
  `judge_model` non-empty and not in `plan_models`.
- **code_review**: EITHER a clean terminal — `clean===true`; `rounds` non-empty;
  last round `clean===true`, `models` ≥1 non-empty, `resolved_count >= concerns_count`
  — OR an escalation terminal (see below).
- **multi_model_review**: EITHER a clean terminal — `clean===true`;
  `adjudicator_model` non-empty; `rounds` non-empty; last round `clean===true`,
  `models` ≥2 distinct, counts ints ≥0, `valid_count <= concerns_count`,
  `resolved_count >= valid_count` — OR an escalation terminal (see below).
  (`adjudicator_model` is required on both paths.)
- **top-level re-score (optional)**: if `apples_rescored_from` is present it must be
  an int 1..5 **strictly greater** than `estimated_apples` (downward-only; upward /
  no-op rejected) and `rescore_reason` must be a non-empty string. A lone
  `rescore_reason` (without `apples_rescored_from`) is rejected.

## Escalation terminal state (`escalated_to_human`)

When a `code_review` or `multi_model_review` loop hits a genuinely intractable
concern, cap it at **2 rounds** and record a terminal escalation instead of
looping forever. The validator accepts an escalated stage when:

- `clean` is **`false`** (escalation is NOT clean; `clean:true` + escalation fails).
- there are **≥2 attempted rounds** (never escalate on round 1), and **every** round
  records `models` (≥1 for code_review; ≥2 distinct for multi_model_review) + its
  non-negative-int counts.
- the final round is **non-clean** with genuine unresolved concerns
  (`resolved_count < concerns_count` for code_review; `< valid_count` for
  multi_model_review).
- `escalated_to_human` is `{ after_round, reason, unresolved_concerns }` where
  `after_round` is an int **equal to the final round index** (≥2; nothing follows
  the escalation), `reason` is non-empty, and `unresolved_concerns` is an int ≥1.

```json
"code_review": {
  "clean": false,
  "rounds": [
    { "round": 1, "models": ["claude-sonnet-4.6"], "concerns_count": 4, "resolved_count": 2, "clean": false },
    { "round": 2, "models": ["gpt-5.3-codex"], "concerns_count": 2, "resolved_count": 0, "clean": false }
  ],
  "escalated_to_human": {
    "after_round": 2,
    "reason": "Two remaining concerns require a product/architecture decision the agents cannot make.",
    "unresolved_concerns": 2
  }
}
```

## Downward-only re-score example

```json
{
  "schema_version": "review-ledger/v2",
  "date": "2026-07-07",
  "session_slug": "trim-thing",
  "task_title": "Trim thing",
  "estimated_apples": 2,
  "apples_rescored_from": 4,
  "rescore_reason": "Planned as a 4🍎 multi-file refactor; the diff collapsed to a one-line guard.",
  "stages": {}
}
```

Note `stages` is `{}` — after re-scoring down to 2🍎 (which requires no stages), the
original 4🍎 scaffolds were **pruned**. Leaving an incomplete `code_review`/
`multi_model_review` behind would fail validation.

If `validate` exits 1 it prints the exact failing rule(s) — fix the underlying
review, then the ledger, and re-run.
