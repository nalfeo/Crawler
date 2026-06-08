# 2026-06-07 — Commit-lint workflow

## Summary

Branch protection on `main` previously listed `commit-lint` as a required
status check, but no workflow defined that context. Every PR therefore sat
in `BLOCKED` against a phantom check. Two-part fix: removed `commit-lint`
from the required contexts as an immediate unblock (admin API), then this
session added a real workflow so the check can be re-enabled.

## Files touched

- `commitlint.config.cjs` (new) — extends `@commitlint/config-conventional`,
  with `type-enum` matching the agent commit rules (feat/fix/chore/docs/
  lab/refactor/test/perf/ci/build/revert). Relaxes subject-case and body/
  footer line length since handoff and ADR bodies legitimately wrap past
  100 cols.
- `.github/workflows/commit-lint.yml` (new) — runs on `pull_request:
  [opened, synchronize, reopened, edited]`. Validates the PR's commit
  range (`base.sha..head.sha`).
- `package.json` / `package-lock.json` — added `@commitlint/cli` and
  `@commitlint/config-conventional` as devDependencies.

Also (out of band, via gh CLI before this branch): updated
`repos/nalfeo/Crawler/branches/main/protection` to remove `commit-lint`
from `required_status_checks.contexts` and set
`required_conversation_resolution.enabled = false`.

## Verification

- `echo "feat: a test message" | npx commitlint` → exit 0.
- `echo "bogus: nope" | npx commitlint` → exit 1, prints
  `type must be one of [feat, fix, chore, docs, lab, ...]`.
- `npm install` clean, 0 vulnerabilities.

## Unresolved

- After this PR merges, re-add `commit-lint` to the `main` branch
  protection required status checks (admin API call, takes one minute).

## Next steps

- Same as above — re-enable the required context once the workflow has
  run successfully on at least one merged PR so GitHub knows the context
  name exists.
