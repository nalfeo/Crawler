# Handoff: sprites:approve hard-block gate

**Date:** 2026-07-29  
**Session slug:** sprites-approve-hard-block-gate  
**Apple estimate:** 🍎🍎  
**Issue:** nalfeo/Crawler#2275

## Systems touched

sprite-pipeline

## Summary

Fixed a correctness hole where `sprites:approve` would happily stamp
`approvedAt` on a variant the judge had explicitly hard-blocked. The
`hardBlocked` flag is a veto — not a score to weigh — but the manual approval
path had no equivalent of the guard in `auto-selection.ts`.

## Changes landed

### `scripts/sprites/approve.ts`
- Added `'hard-blocked'` to `ApproveError.kind` union.
- Extended the `RunSummaryShape.candidates[].judgeScorecard` inline type to
  expose `hardBlocked`, `passed`, and `hardBlockInstruction` fields (was just
  `minScore`).
- Added `allowHardBlocked?: boolean` to `ApproveVariantOptions`.
- Added a **hard-block gate** in `approveVariant()` that throws
  `ApproveError('hard-blocked', …)` when `judgeScorecard.hardBlocked === true`
  unless the caller passes `allowHardBlocked: true`.
- Added a **soft warning** (`process.stderr.write`) when
  `judgeScorecard.passed === false` but not hard-blocked, so operators get
  visibility without a hard refusal.

### `scripts/sprites/approve-cli.ts`
- `ParsedArgs` now includes `allowHardBlocked: boolean`.
- `parseArgs` recognises `--allow-hard-blocked` flag (default `false`).
- `approveVariant` call passes `allowHardBlocked: parsed.allowHardBlocked`.
- `exitCodeForError` maps `'hard-blocked'` → exit code 4.

### `scripts/sprites/sidecar/server.ts`
- `mapApproveError` now maps `'hard-blocked'` → HTTP 422 (Unprocessable
  Entity) so the gallery UI can surface a meaningful error instead of a
  generic 500.

### `scripts/sprites/check-manifest-hard-blocked.ts` (new)
- Pure CI invariant check: reads `manifest.json`, reports any entry whose
  `judgeScorecard.hardBlocked === true`.
- Exports `validateNoHardBlockedEntries()` pure validator for tests.
- Exits 1 on violation with fix instructions.

### `package.json`
- Added `check:manifest-hard-blocked` script.

### `.github/workflows/ci.yml`
- Added "Manifest hard-block check" step to the `check-lightweight` job,
  running `check:manifest-hard-blocked`. Skipped for `DOCS_ONLY`.

### `AGENTS.md`
- Listed `npm run check:manifest-hard-blocked` in the commands table.

### `tests/unit/sprites/approve.test.ts`
- Extended `FakeRunOptions` with `hardBlockedFor` and `judgeFailedFor`.
- Updated `writeFakeRun` to populate hard-blocked / failed scorecards.
- Added `describe('hard-block gate')` with three tests:
  1. Throws `ApproveError('hard-blocked')` with the judge instruction.
  2. Approves when `allowHardBlocked: true` (conscious override).
  3. Non-hard-blocked variant in same run approves normally.

### `tests/unit/sprites/check-manifest-hard-blocked.test.ts` (new)
- 8 tests covering: empty entries, all-clean entries, entries without
  scorecards, single violation with instruction, single violation without
  instruction, multiple violations, custom label, and fix instructions.

### `public/assets/generated/manifest.json`
- Removed `welcome-room-floor-stain-var-1` (1 of 464 entries, the one
  pre-existing hard-blocked entry that the issue flagged).

### `public/assets/generated/welcome-room-floor-stain-var-1.png`
- Deleted (the art the judge vetoed).

### `src/shared/data/sprite-catalog.json`
- Removed the `generated:welcome-room-floor-stain-var-1` catalog entry.

## Testing

- Existing `test:sprites` tests continue to pass.
- New hard-block gate tests and `check-manifest-hard-blocked` tests added.
- `check:manifest-hard-blocked` passes on the current repository state (0
  hard-blocked entries).
- `check:sort-assets` still passes (manifest key sort unchanged).

## Notes

- `allowHardBlocked: true` is intentionally awkward to invoke: operators must
  name the flag explicitly in both the API and the CLI. It is NOT a
  general-purpose `--force`; it is specifically for conscious overrides of the
  judge veto.
- The `passed === false` warning is non-blocking by design. `passed` is a
  *soft* threshold aggregating evaluator scores; the judge may score below
  threshold on one axis but still be usable art. The hard-block is the only
  true veto.
- `tile-door-v1-var-1` (mentioned in the issue, from PR #1972) was NOT on
  `main` at the time of this fix; no action needed for it here.
