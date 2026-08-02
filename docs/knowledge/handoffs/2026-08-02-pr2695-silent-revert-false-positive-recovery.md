# Handoff: PR #2695 silent-revert false-positive recovery

## Date

2026-08-02

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

2🍎 estimated, 2🍎 actual — targeted guard/test recovery on an existing PR.

## What changed

- Fixed `scripts/agent/health/silent-reverts.ts` / `silent-reverts-lib.ts` so
  the guard no longer reports a silent discard when the kept parent already
  independently contains the incoming side's change and only adds extra edits.
- Added regression coverage for that exact shape:
  - a unit-level `isDiscarded()` case for `result === other` with preserved
    incoming content
  - a real-git CLI scenario that merges a branch whose kept parent already
    contains the incoming side's line plus an extra non-conflicting edit

## Why

CI run `30759341447` failed only because the Silent Merge-Revert Guard flagged
`package.json` on merge `361ff543`. Inspection showed the merge kept the branch
blob because it already included main's `velocity:conflict-scan` addition plus
the PR's extra guard scripts — a clean subsumption, not a silent discard.

## Validation

- `tests/unit/silent-reverts-guard.test.ts`
- `tsx scripts/agent/health/silent-reverts.ts`
- `npm run verify:fast`

## Notes

- Repo-local `npm` install paths still hit the locked `ms-feed` tarball URLs in
  this sandbox, so validation used a temporary `/tmp/crawler-validate` toolchain
  plus a non-committed local `yarn install` to satisfy `verify:fast`.
