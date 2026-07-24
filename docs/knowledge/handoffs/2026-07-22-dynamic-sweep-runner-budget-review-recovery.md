# Handoff: dynamic sweep runner budget review recovery

## Date

2026-07-22

## Persona

DevOps Engineer

## Systems touched

ai-combat-balance, ci-policy

## Apples

Estimated 🍎🍎, actual 🍎🍎.

## What changed

- Updated the three `ai-sweep.yml` round-eval comments that still described a fixed `max-parallel: 8` cap so they now document the queue-aware allocator plus the shared `crawler-sweep-slot-*` semaphore.
- Made `inspectLatentBacklog()` fail the sweep probe when any hydrated CI-recovery owner is unreadable instead of letting that PR count as ordinary backlog and preserving a nonzero budget.
- Added a deterministic sweep-budget regression that exercises the unreadable-owner path through `calculateSweepAdmission()` and expects a `SweepProbeError`.
- Fixed the stale `recover-checkpoint-validate` workflow test that still asserted `recover-validate.strategy.max-parallel === 8`, and updated nearby test comments to describe the queue-aware contract.

## Verification

- `node --test .github/scripts/sweep-budget.test.mjs`
- GitHub Actions failure logs for run `29904903042` confirmed the stale `recover-checkpoint-validate.test.ts` expectation as the shared CI root cause across Unit Tests / CI / Merge gate / Advisory coverage.
- `npm ci` / `bash scripts/agent/preflight.sh` / local Vitest remain blocked in this sandbox because `package-lock.json` contains five `resolved` tarball URLs on `ms-feed-12.pkgs.visualstudio.com`, which is unreachable here; see the repo checkout’s current install error rather than a code regression.

## Review thread outcomes

- `.github/workflows/ai-sweep.yml:434` stale fixed-cap comment: fixed.
- `.github/workflows/ai-sweep.yml:654` stale fixed-cap comment: fixed.
- `.github/workflows/ai-sweep.yml:863` stale fixed-cap comment: fixed.
- `.github/scripts/sweep-budget.mjs:166` unreadable ownership no longer preserves a nonzero admission budget: fixed.
