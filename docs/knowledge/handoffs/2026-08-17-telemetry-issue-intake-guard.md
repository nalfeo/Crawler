# Handoff: telemetry intake guard for Copilot issue assignment

## Systems touched

ci-automation, issue-intake

## Summary

- Skip telemetry-labeled issues before the Copilot issue intake workflow assigns or unlocks work.
- Keep the guard centrally in `issue-intake-lib.mjs` so both eligibility checks and the workflow entrypoint share the same exclusion.
- Add a regression test to ensure `label: telemetry` remains ineligible for Copilot assignment.

## Verification

- `node --test .github/scripts/ci-recovery/issue-intake.test.mjs`
- `npm run verify:pr-prereqs`

## Notes

Telemetry-only feedback artifacts should remain data collection and not be routed into repository automation as code work.
