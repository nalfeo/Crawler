# Handoff: CI capacity + prioritization invariant lock-in

## Date

2026-07-24

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 3🍎, actual 3🍎.

## Summary

Locked CI-recovery capacity/prioritization invariants by adding runtime-resolved dispatch-cap knobs in `router.mjs`, wiring knob env vars in `ci-recovery-router.yml`, adding explicit router regression coverage for knob resolution + simulated burst budget behavior, and adding a consolidated policy + guard test that pin required invariants and knob wiring.

## Files touched

- `.github/scripts/ci-recovery/router.mjs`
- `.github/scripts/ci-recovery/router.test.mjs`
- `.github/workflows/ci-recovery-router.yml`
- `docs/agent-os/policies/ci-config-knobs.md`
- `tests/unit/ci-knobs-guard.test.ts`
- `docs/knowledge/review-ledgers/2026-07-24-ci-capacity-prioritization-invariants.review-ledger.json`
- `docs/knowledge/metrics/apples/2026-07-24-ci-capacity-prioritization-invariants.json`

## Verification run

- `node --check .github/scripts/ci-recovery/router.mjs` ✅
- `node --check .github/scripts/ci-recovery/router.test.mjs` ✅
- Router dry-run burst (mocked API, real `router.mjs` execution) ✅
  - Output showed `dispatch cap applied sent=3 ... budget=3` with busy cap `7`, global cap `3`, and per-run cap `8`.
- Apple metrics entry generated for `ci-capacity-prioritization-invariants` ✅
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-24-ci-capacity-prioritization-invariants.review-ledger.json` ✅
- `npm run verify:fast` ⚠️ blocked by missing dependencies in sandbox (`@eslint/js`, `typescript`, `vitest`, `yaml` unavailable because lockfile-resolved feed host is unreachable).
- `node --test .github/scripts/ci-recovery/router.test.mjs` ⚠️ blocked in sandbox due missing `yaml` package (same dependency-install blocker).

## Unresolved issues

- Full local verification is blocked in this sandbox because dependency install cannot reach the lockfile-resolved package feed host (`ms-feed-12.pkgs.visualstudio.com`).

## Recommended next steps

1. Re-run `npm ci` in a network-enabled environment.
2. Run:
   - `node --test .github/scripts/ci-recovery/router.test.mjs`
   - `npm run test:unit -- tests/unit/ci-knobs-guard.test.ts`
   - `npm run verify:fast`
3. If green, proceed with PR merge flow.
