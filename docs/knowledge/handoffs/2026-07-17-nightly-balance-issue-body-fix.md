# Nightly balance issue body fix

## Date

2026-07-17

## Persona

Producer coordinating a small DevOps-oriented automation fix

## Systems touched

ci-policy

## Apples

2🍎 estimated. Actual pending final validation, but the diff remained a small two-file automation/test fix with no wider scope expansion.

## What changed

- Replaced the nightly balance issue body's angle-bracket artifact placeholder with the explicit six canonical aggregate artifact names so GitHub issue rendering cannot strip critical text.
- Added `buildIssueBody(...)` so the filer can patch the created issue body with the exact issue number after GitHub assigns it.
- Added rollback handling for the new body-update step so a failed post-create patch closes the newly created issue instead of leaving malformed instructions open.
- Added focused regression tests for exact issue-number injection, the new PATCH call, and update-failure rollback/aggregate-error behavior.

## Why this was needed

The first live scheduled run created issue #1253, and the live issue text had already lost critical literal tokens: `weapon-sweep-<weapon>` rendered as `weapon-sweep-`, and `Closes #<this issue number>` rendered as `Closes #`. That meant the filer was not reliably delivering the hard-gate instructions encoded in the source template.

## Files touched

- `.github/scripts/nightly-balance-issue/nightly-balance-issue.mjs`
- `.github/scripts/nightly-balance-issue/nightly-balance-issue.test.mjs`
- `docs/knowledge/review-ledgers/2026-07-17-nightly-balance-issue-body-fix.review-ledger.json`

## Verification run

- `node --test .github/scripts/nightly-balance-issue/nightly-balance-issue.test.mjs`
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-17-nightly-balance-issue-body-fix.review-ledger.json`
- `npm run verify:pr-prereqs`

## Unresolved issues

- I could not post the requested pre-code plan comment back onto issue #1253 from this sandbox: `gh issue comment` failed because the clone has no GitHub-hosted remote configured, and direct `gh api` POST attempts were blocked by the environment's DNS monitoring proxy. The plan itself was still written in-session before code, and the repo fix remains valid.
- This code change prevents future malformed issue bodies, but it does not retroactively rewrite the already-filed live issue from inside this restricted environment.

## Recommended next steps

- Once this branch is landed, either let the next nightly filer create the next issue with the fixed body or manually edit/recreate issue #1253 if the current malformed instructions need immediate correction.
