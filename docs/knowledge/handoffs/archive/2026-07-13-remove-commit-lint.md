# 2026-07-13 — Remove commit/PR name linter rule

## Summary

Removed the conventional commit / semantic PR title linting enforcement. The
user found the enforcement was causing excessive friction for agents and wasn't
worth the overhead (issue #1105).

## What was removed

- **`.github/workflows/commit-lint.yml`** — CI workflow that validated PR titles
  against the conventional commit format on every PR open/sync/edit.
- **`commitlint.config.cjs`** — Commitlint base configuration (extends
  `@commitlint/config-conventional`, custom `type-enum`, `ignores` for merge
  commits, etc.).
- **`commitlint.title.config.cjs`** — PR-title-specific commitlint config (same
  rules as base but with no `ignores` escape hatches).
- **`@commitlint/cli` and `@commitlint/config-conventional`** — npm devDependencies
  removed and `package-lock.json` updated.

## What was updated

- **`.github/extensions/copilot-guards/guards/pr-preflight.mjs`** — Removed
  `CONVENTIONAL_TITLE_RE`, `extractTitle`, `checkSemanticTitle` functions and
  the `skipSemanticTitle` parameter from `evaluatePreflightChecks`. Removed those
  exports. The `create_pull_request` guard no longer blocks on PR title format.
- **`.github/extensions/copilot-guards/tests/pr-preflight.test.mjs`** — Removed
  the three semantic-title tests (`CONVENTIONAL_TITLE_RE accepts/rejects`,
  `checkSemanticTitle reports`). All remaining 14 tests pass.
- **`docs/agent-os/policies/ci-policy.md`** — Removed gate step #4
  ("Conventional commit / semantic PR title check"), renumbered subsequent steps.
  Removed the "Conventional Commit Enforcement" section and the
  "Require the semantic PR / commit check to pass" branch protection rule.
- **`AGENTS.md`** — Removed rule #5 ("Conventional commits") and renumbered
  subsequent rules (6→5, 7→6, …, 15→14). Updated cross-references to rule
  numbers in rules 9, 13, and 14.
- **`.github/copilot-instructions.md`** — Removed the "Write conventional
  commits. Allowed types (enforced by commitlint): …" bullet.
- **`scripts/sprites/asset-pr.ts`** — Removed stale comment referencing the
  `commit-lint` CI job when generating the asset PR title.
- **`scripts/agent/security/check-deps.ts`** — Removed `@commitlint/` from
  the trusted-scope prefixes list (package no longer in use).

## Verification

- `node --test .github/extensions/copilot-guards/tests/pr-preflight.test.mjs` → 14/14 pass
- `npm run verify:fast` — full typecheck + lint + unit tests pass
- Review ledger: `docs/knowledge/review-ledgers/2026-07-13-remove-commit-lint.review-ledger.json` (1🍎, no stages required)

## Systems touched

ci-policy, docs-tooling

## Unresolved

None.

## Next steps

None required. Agents can now use any PR title style without CI blocking them.
