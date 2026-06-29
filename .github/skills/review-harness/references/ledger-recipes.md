# Review-ledger recipes

The ledger is a small JSON artifact under
`docs/knowledge/review-ledgers/<YYYY-MM-DD>-<slug>.review-ledger.json`. The CLI
(`npm run review:ledger -- ...`) is a thin wrapper around the validator in
`scripts/agent/review/ledger.mjs` (the single source of truth — the
`pr-review-ledger` guard imports the _same_ module).

## Lifecycle

```
# 1. Scaffold (only the stages your tier needs are created)
npm run review:ledger -- init --apples 4 --slug improve-local-harness --title "Encode apple-scaled review harness"

# 2. Fill in each stage as you complete it (shallow-merged into stages[name])
npm run review:ledger -- stage <path> plan_review        --json '{...}'
npm run review:ledger -- stage <path> dual_plan_synthesis --json '{...}'
npm run review:ledger -- stage <path> code_review        --json '{...}'
npm run review:ledger -- stage <path> multi_model_review --json '{...}'

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

| apples | stages the validator requires                                             |
| ------ | ------------------------------------------------------------------------- |
| 1      | `code_review`                                                             |
| 2–3    | `plan_review`, `code_review`                                              |
| 4–5    | `plan_review`, `dual_plan_synthesis`, `code_review`, `multi_model_review` |

A stage that is _present but not required_ is still validated — don't add a
half-filled stage you didn't actually do.

## Full tier-4 example

```json
{
  "schema_version": "review-ledger/v1",
  "date": "2026-06-29",
  "session_slug": "improve-local-harness",
  "task_title": "Encode apple-scaled review harness",
  "estimated_apples": 4,
  "stages": {
    "plan_review": {
      "completed": true,
      "reviewer_model": "gpt-5.4",
      "concerns_count": 6,
      "resolved_count": 6,
      "notes": "all adopted"
    },
    "dual_plan_synthesis": {
      "completed": true,
      "plan_models": ["gpt-5.5", "gemini-3.1-pro-preview"],
      "judge_model": "claude-opus-4.8",
      "notes": "synthesized into plan.md"
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
    }
  }
}
```

## Per-stage validator rules (quick reference)

- **top-level**: `schema_version === "review-ledger/v1"`; `date` = `YYYY-MM-DD`;
  `session_slug` kebab-case; `task_title` non-empty; `estimated_apples` int 1..5;
  `stages` object.
- **plan_review**: `completed===true`; `reviewer_model` non-empty;
  `concerns_count`/`resolved_count` ints ≥0; `resolved_count >= concerns_count`.
- **dual_plan_synthesis**: `completed===true`; `plan_models` = exactly 2 distinct
  non-empty ids; `judge_model` non-empty and not in `plan_models`.
- **code_review**: `clean===true`; `rounds` non-empty; last round `clean===true`,
  `models` ≥1 non-empty, `resolved_count >= concerns_count`.
- **multi_model_review**: `clean===true`; `adjudicator_model` non-empty; `rounds`
  non-empty; last round `clean===true`, `models` ≥2 distinct, counts ints ≥0,
  `valid_count <= concerns_count`, `resolved_count >= valid_count`.

If `validate` exits 1 it prints the exact failing rule(s) — fix the underlying
review, then the ledger, and re-run.
