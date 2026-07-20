# Handoff: Reduce PR automation and CI setup overhead

## Date

2026-07-19

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 3🍎, actual 3🍎.

## Summary

Reduced redundant CI setup/checkouts and narrowed automation fan-out without weakening gates:

- `pr-ready-reviewer-guard` now processes only the triggering PR on `pull_request_target` events, while scheduled/manual runs still sweep all open PRs. Event runs fail closed if the triggering PR number is missing.
- `Epic Drift Audit` PR/push triggers now watch only the Floor 2 equipment epic control plane plus direct execution inputs (`scripts/agent/epics/**`, `.github/actions/setup-node/action.yml`, `package*.json`, `tsconfig*.json`, and the workflow itself).
- `ci.yml` now consolidates the former `Types & Lint` + `Format & Labs` jobs into one `Static validation` job with one shared checkout/setup sequence. Advisory unit-coverage + build work moved under the existing `ci-advisory` job so the workflow removes three repeated setup/checkout sequences overall (`check-types-and-lint`, `check-format-and-labs`, `test-unit-coverage`, and standalone `build` collapsed to two jobs).
- Added deterministic regression coverage for the new CI topology and Epic Drift trigger scope, plus PR-guard tests that lock event-only PR processing.
- Fixed a follow-up review finding by adding `.github/scripts/*.test.mjs` to `npm run test:guards`, so `pr-ready-reviewer-guard.test.mjs` actually runs in CI.

## Files touched

- `.github/scripts/pr-ready-reviewer-guard.mjs`
- `.github/scripts/pr-ready-reviewer-guard.test.mjs`
- `.github/workflows/ci.yml`
- `.github/workflows/epic-drift-audit.yml`
- `tests/unit/ci-workflow-overhead.test.ts`
- `package.json`
- `docs/knowledge/review-ledgers/2026-07-19-reduce-pr-automation-overhead.review-ledger.json`

## Verification

- `node --test .github/scripts/pr-ready-reviewer-guard.test.mjs`
- `npx vitest run --project unit tests/unit/ci-workflow-overhead.test.ts`
- `npm run test:guards`
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-19-reduce-pr-automation-overhead.review-ledger.json`

## Review harness

- Plan review (`gpt-5.4`): approved with changes; `plan_divergence=minor`
- Code review (`claude-sonnet-4.6`): 1 real issue found (`pr-ready-reviewer-guard.test.mjs` was not included in `test:guards`), fixed, and re-verified clean

## Blockers / notes

- The issue requested a pre-code plan comment on issue #1684. I prepared the exact comment body and attempted to post it with both `gh` and direct API calls, but this session’s environment only exposes a localhost git remote to `gh`, the token-backed GitHub calls returned GraphQL 403s, and direct `api.github.com` POSTs were blocked by the DNS monitoring proxy. The implementation proceeded only after capturing that blocker explicitly in the review ledger and handoff.

## Unresolved issues

None in the code. The only unresolved item is the environment blocker for posting the required issue comment from this session.
