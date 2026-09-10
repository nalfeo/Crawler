# 2026-09-05 Goobers PR 4260 recovery

## Systems touched

ci-policy

## Kickoff declarations

- Verdict: **recommended**
- Apple estimate: **2**

## Summary

Recovered PR #4260 from two Copilot review threads and the paired Goobers CI failures.

- `goobers-run.yml` now uses the built-in `github.token` for the singleflight Actions metadata read, matching the workflow's declared `actions: read` permission instead of depending on the narrower Goobers PAT.
- Scheduled fresh-intake scans still leave approved work to the four provider-side atomic claim slots, but now reserve a selected `legacy-parity` issue as the one dispatch-level target because plain fresh claims require `goobers:approved`.
- The run-start reservation visibility check now handles legacy-parity reservations by reading the issue's own labels directly; approved/resume targets keep the provider-query visibility replay.
- The receipt cleanup fixture now drains stdin for the `gh api --input -` PATCH path, matching the real CLI well enough that `jq | gh api` does not fail under `pipefail` with SIGPIPE.

## Validation

- `npx vitest run tests/unit/goobers-run-workflow.test.ts tests/unit/goobers-run-slot-cleanup.test.ts tests/unit/goobers-contracts.test.ts`
- `node .github/scripts/validate-goobers-contracts.mjs`
- `GOOBERS_REQUIRE_LINUX_SUITES=1 npx vitest run tests/unit/goobers-contracts.test.ts tests/unit/goobers-run-workflow.test.ts tests/unit/goobers-run-slot-cleanup.test.ts --reporter=verbose`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`
