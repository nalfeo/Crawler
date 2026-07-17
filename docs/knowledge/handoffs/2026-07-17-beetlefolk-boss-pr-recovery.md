# Handoff: PR #1224 blocker recovery

## Date

2026-07-17

## Persona

Producer -> DevOps Engineer / QA Engineer / Reviewer

## Systems touched

ci-policy, sprite-workflow

## Apples

Estimated 🍎🍎, actual 🍎🍎.

## What changed

- Backported the current `main` hardening for `.github/scripts/ci-recovery/github.mjs` so non-JSON GitHub API bodies now surface as structured errors instead of crashing `JSON.parse(...)`.
- Backported the matching `ci.yml` / `security-review.yml` promotion-scope fallback so `gh api .../check-runs` failures no longer make the scope-detection jobs fail closed with a `jq` parse error.
- Backported the focused Node test coverage for `github.mjs` to lock both non-JSON error-page handling and non-JSON success-body rejection.
- Added a 2🍎 review ledger for this PR-recovery slice.

## CI / blocker diagnosis

- `Human approval` and `route` both failed because `.github/scripts/ci-recovery/github.mjs` tried to `JSON.parse(...)` an HTML error page returned from GitHub.
- `Detect change scope` failed for the same root cause one layer higher: the workflow piped `gh api .../check-runs` output straight into `jq`, so an HTML/non-JSON response produced `jq: parse error: Invalid numeric literal`.
- `ci` and `Merge gate` were aggregate failures caused by `Human approval` failing, not separate code regressions.
- Review-thread validation on current head:
  - `src/shared/data/enemies.floor2.json:684` is deterministically addressed by `collisionRadius: 1.5`, the spawner override, and `tests/unit/floor2-boss-spawn.test.ts`.
  - `briefs/enemies/beetlefolk-boss.yaml:3` was valid on head `7350e84`; recovered by downloading the successful `asset-request` review artifact for issue #1220, deterministically filling enclosed transparent holes in the chosen wide variant, and approving it back onto the canonical `beetlefolk-boss-var-0` runtime asset + manifest entry.

## Verification

- `node --test .github/scripts/ci-recovery/github.test.mjs`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`
- `parallel_validation`

## Review thread outcomes

- Collision-radius thread: already addressed on current head.
- Wide-art thread: resolved once the salvaged approved artifact is committed; reply with `✅ Addressed in <sha>` should cite the updated `public/assets/generated/beetlefolk-boss-var-0.png` and manifest entry.
