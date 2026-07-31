# Handoff: PR #1886 reconciliation-lane guard recovery

## Date

2026-07-31

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 2🍎, actual 2🍎.

## What changed

- Investigated failing GitHub Actions run `30609670310` via MCP job logs for `Advisory coverage`, `Unit Tests`, `Merge gate`, and `ci`.
- Traced all listed blockers to one root cause: the new exported router constant `RECONCILIATION_LANE_CAP` was added without being registered in the CI knobs guard or documented in the canonical knobs policy.
- Registered `RECONCILIATION_LANE_CAP` in `tests/unit/ci-knobs-guard.test.ts` as a structural router constant.
- Added the matching structural-constants row to `docs/agent-os/policies/ci-config-knobs.md`.

## Observe before done

- Before: run `30609670310` failed `Unit Tests` and `Advisory coverage` on deterministic assertions from `tests/unit/ci-knobs-guard.test.ts`, and `Merge gate` / `ci` failed only because they aggregate that red unit-test result.
- After: the branch now classifies `RECONCILIATION_LANE_CAP` the same way as the other structural router lane constants, so the guard no longer has a missing-registration reason to fail.
- Real artifact: GitHub Actions job logs `91089587880`, `91092042267`, `91091786666`, and `91089587879`.

## Verification

- `github-mcp-server-get_job_logs` for jobs `91089587880`, `91092042267`, `91091786666`, `91089587879`
- `node --test scripts/agent/security/npm-audit.test.mjs` ✅
- `npm run test:unit -- tests/unit/ci-knobs-guard.test.ts` ❌ local environment missing `vitest`
- `node --test .github/scripts/ci-recovery/router.test.mjs` ❌ local environment missing `yaml`
- `npm install` ❌ sandbox network/DNS failure fetching `https://ms-feed-25.pkgs.visualstudio.com/.../postcss-8.5.22.tgz` (`getaddrinfo ENOTFOUND`)

## Notes

- This is a metadata/guard registration fix only; router dispatch behavior is unchanged.
- Once CI reruns in a fully provisioned environment, the aggregate `ci` and `Merge gate` jobs should clear automatically if the guard regression is the only remaining failure.
