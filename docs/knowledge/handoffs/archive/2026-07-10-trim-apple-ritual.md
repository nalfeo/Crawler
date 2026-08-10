# Handoff: Trim apple ritual + add apples:record CLI

**Date:** 2026-07-10
**Session:** trim-apple-ritual
**Branch:** nalfeo-trim-apple-ritual

## Summary

Trimmed the apple complexity ritual and added a deterministic CLI tool to eliminate
hand-written JSON and wrong-value fix turns.

**Changes made:**

- New `npm run apples:record -- --session <slug> --estimated <n> --actual <n>` CLI
  (`scripts/agent/docs/apple-record-cli.ts`). Auto-derives delta/verdict/hello_kitties/date.
  Validates inputs; errors on duplicate file.
- Dropped the apple file requirement for 1–2🍎 sessions entirely. 80% of 401 existing
  files were `delta=0 exact` — pure ritual overhead at tiers where no review fires.
- Updated `complexity-policy.md`, `AGENTS.md`, `copilot-instructions.md`,
  and `pr-shepherd/references/playbook.md`.

## Verification

`npm run verify:fast` and `npm run verify` passed. CLI smoke-tested: happy path writes correct JSON,
bad `--actual 9` exits 1, duplicate file exits 1, missing args prints usage.

## Systems touched

agent-personas

## Apples

🍎🍎🍎 estimated, 🍎🍎🍎 actual — exact.

## Unresolved issues

None.

## Recommended next steps

- The `apple-calibration.ts` calibration thresholds/commentary could be updated
  to note that entries below 3🍎 are no longer expected going forward, but this
  is advisory — the calibration script still works fine reading old entries.
