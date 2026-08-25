# Handoff: Epic create issue assignees

## Systems touched

ci-policy

## Summary

Updated the generic `epic-create` issue materialization workflow script so every generated epic review issue and every generated node issue is assigned to `@nalfeo`.

## Validation

- `bash scripts/agent/preflight.sh` — passed.
- `node --test .github/scripts/epics/epic-create.test.mjs` — passed (31 tests).
- `npm run verify:fast` — passed (144 test files / 2368 tests; fast integrity checks passed).
- `code_review` — no comments.
- `codeql_checker` — no CodeQL-analyzable language changes detected.

## Tests added

Extended `.github/scripts/epics/epic-create.test.mjs` to assert that both review-gate issue creation and node issue creation include the canonical `@nalfeo` assignee payload.

## Apple score

Estimated: 1🍎. Actual: 1🍎.
