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
  - `briefs/enemies/beetlefolk-boss.yaml:3` remains a real blocker because the checked-in runtime asset is still `public/assets/generated/beetlefolk-boss-var-0.png` at 64×64; the wide 128×64 replacement has not been generated/approved yet.

## Verification

- `node --test .github/scripts/ci-recovery/github.test.mjs`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`
- `parallel_validation`

## Review thread outcomes

- Collision-radius thread: ready to mark `✅ Addressed in <sha>` after the final repair commit.
- Wide-art thread: intentionally left unresolved pending a credentialed sprite-generation/approval run that updates `public/assets/generated/beetlefolk-boss-var-0.png` and `public/assets/generated/manifest.json`.
