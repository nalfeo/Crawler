# Handoff: asset-request CI recovery

## Date

2026-07-31

## Persona

DevOps Engineer

## Systems touched

sprite-pipeline, ci-policy

## Apples

2🍎 estimated, 2🍎 actual (exact)

## Summary

- Recovered the asset-request auto-close PR after the initial CI-only repair exposed three follow-up review blockers.
- Restored `package.json`, `package-lock.json`, `scripts/agent/security/npm-audit.mjs`, and `scripts/agent/security/npm-audit.test.mjs` to their exact `origin/main` contents so the unrelated PostCSS rollback / temporary dependency-exception changes are no longer part of this PR.
- Tightened `scripts/sprites/checkin.ts` to fail closed when `gh issue list` cannot be executed or parsed while discovering linked `asset-request` issues, preventing permanent loss of close-keyword provenance.
- Added focused regression coverage that proves those provenance lookup failures abort before any branch push or issue creation.

## Files touched

- `scripts/sprites/checkin.ts`
- `tests/unit/sprites/checkin.test.ts`
- `docs/knowledge/handoffs/2026-07-31-asset-request-ci-recovery.md`
- `docs/knowledge/review-ledgers/2026-07-31-asset-request-ci-recovery.review-ledger.json`

## Verification

- GitHub Actions MCP: inspected the prior failing `ci`, `Lightweight Checks`, and `Merge gate` jobs, then validated the three listed review threads with separate code-review agents.
- `node --test scripts/agent/security/npm-audit.test.mjs`
- `npx prettier --check scripts/sprites/checkin.ts tests/unit/sprites/checkin.test.ts scripts/agent/security/npm-audit.mjs scripts/agent/security/npm-audit.test.mjs package.json`
- `parallel_validation` → code review: 0 findings; CodeQL: 0 alerts reported
- `npm ci` _(environment-blocked: mirrored package-host DNS failure, e.g. `getaddrinfo ENOTFOUND ms-feed-12.pkgs.visualstudio.com` while resolving locked tarballs)_
- `npm exec --yes --package=vitest@4.1.10 --package=vite@8.0.16 --package=typescript@6.0.3 -- vitest run tests/unit/sprites/checkin.test.ts` _(environment-blocked: repo-local `vitest.config.ts` resolves `vitest/config` from the project install, which is unavailable without a successful dependency install)_

## Unresolved / next steps

- Branch CI rerun remains the authoritative full verification path for the touched Vitest suite because this sandbox still cannot complete the project dependency install from the mirrored package hosts.
