# Handoff: CI recovery loop — PR #1917

## Date

2026-07-28

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 3🍎, actual 2🍎. The investigation started as a medium CI-recovery diagnosis, but the live evidence collapsed to a single workflow-token fix plus one regression test.

## Summary

Investigated CI recovery loop incident #2154 for PR #1917 and confirmed the loop was not caused by marker parsing or review-thread resolution. The docs-update automation was publishing the `automation/docs-update` PR branch via the workflow/App identity, which deterministically parked required PR CI in `action_required`. CI recovery then kept escalating a `ci-retrigger` blocker against a symptom the source workflow could recreate on its next branch update.

## What changed

- Updated `.github/workflows/docs-update.yml` so the `peter-evans/create-pull-request@v7` step uses `token: ${{ secrets.CRAWLER_CI_PAT }}`.
- Added `tests/unit/docs-update-workflow.test.ts`, which parses the real workflow YAML and asserts the docs-update PR publisher is wired to `CRAWLER_CI_PAT`.

## Why this is the smallest correct fix

The repository already documents that same-App pushes can park required checks in `action_required`, and a later dedicated retrigger path was added to recover those stalls. For PR #1917, the source automation itself was still creating parked CI runs, so teaching CI recovery to chase them harder would only preserve the loop. Switching the docs-update PR publisher to the human/PAT path removes the root cause for this PR class.

## Verification

- `npm test -- tests/unit/docs-update-workflow.test.ts`
- `bash scripts/agent/verify-fast.sh`

## Notes

- Best-effort attempt to post the required pre-code plan comment on issue #2154 from this sandbox failed with `HTTP 403: Blocked by DNS monitoring proxy`, so the plan remained in session chat only.
