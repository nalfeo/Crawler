# 2026-07-03 - Release Pipeline Fix

## Systems touched

ci-policy

## Summary

Diagnosed and fixed intermittent "Deployment failed, try again later" errors from
`actions/deploy-pages@v4` in the GitHub Pages deploy pipeline. The errors were caused
by transient GitHub Pages infrastructure failures and had accumulated 13 open stale
release-failure issues.

## Changes Made

- `.github/workflows/deploy.yml`
  - Added `continue-on-error: true` to the first deploy attempt
  - Added a 60-second wait step when attempt 1 fails
  - Added a retry deploy step (attempt 2, no `continue-on-error`)
  - Added `Resolve deployment URL` helper step (`if: always()`) that sets `page_url`
    from whichever attempt succeeded, with an explicit warning if both failed
  - Updated `environment.url` and `PAGES_URL` env var to use `steps.deploy-url.outputs.page_url`
  - Added `Close stale release-failure issues` step (runs on `success()`, closes only
    issues created >120 s ago to avoid race conditions)

- `.github/workflows/promote-to-prod.yml`
  - Same retry pattern: `continue-on-error` + 60s wait + retry + `if: always()` URL resolver
  - Updated `environment.url` to reference `steps.deploy-url.outputs.page_url`

- `docs/knowledge/review-ledgers/2026-07-03-release-pipeline-fix.review-ledger.json`
  - 2-apple ledger with plan_review stage (claude-opus-4.6, 6 concerns, all resolved)

- `docs/knowledge/metrics/apples/2026-07-03-release-pipeline-fix.json`
  - Estimated: 2, Actual: 2, Verdict: exact

## Apple Estimate

🍎🍎 (2 apples) — exact match. 2 workflow files, no new systems or tests.

## Verification

- Review ledger validates: `npm run review:ledger -- validate` → ✅
- `parallel_validation` (Code Review): 3 concerns identified and resolved
  - URL resolver: added `if: always()` + else warning clause (both files)
  - GNU date: added comment documenting ubuntu-only dependency
- Secret scan: clean
- No TypeScript/lint/test changes needed (workflow YAML only)

## Root Cause Analysis

The `actions/deploy-pages@v4` action calls the GitHub Pages deployment API. The
Pages service occasionally returns a failure status for a newly created deployment,
causing the action to throw "Deployment failed, try again later." This is a transient
infrastructure issue on GitHub's side. The pipeline auto-recovered on subsequent CI
pushes, but each failure created a new tracking issue.

## Recommended Next Steps

- **Shepherd loop**: merge this PR — CI should be straightforward (no code changes)
- Once merged, the next successful deploy will auto-close the 13 open release issues
  (#671, #673, #677, #686, #696, #698, #704, #709, #720, #723, #729, #731, #734)

## Unresolved Issues

None.
