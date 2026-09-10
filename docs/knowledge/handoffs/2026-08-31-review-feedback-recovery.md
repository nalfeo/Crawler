# Review feedback recovery

## Systems touched

hud-ux, devtools

## Apples

Estimated: 2. Actual: 2. Exact calibration.

## Summary

- Confirmed both CI-recovery review-thread blockers with an independent validator.
- Converted synchronous `onRunBundle` throws into the existing upload-failure reporting path without deferring the hook call.
- Replaced action-status text equality with a display token so repeated identical toasts keep their own lifetime.
- Added focused unit coverage for both regressions.

## Observation

- Before: a synchronous custom `onRunBundle` throw escaped `emitRunBundle`, bypassing `reportRunBundleUploadResult`; an older hide timer could hide a newer identical action-status toast.
- After: synchronous hook failures become rejected upload promises handled by the same player-visible failure path, and only the latest action-status display timer can hide the toast.

## Verification

- `npm run test:unit -- tests/unit/main-game-scene-run-bundle.test.ts --reporter=verbose`
- `npm run typecheck`
- `npm run lint -- --quiet`
- `npm run verify:fast`

## Notes

- No gameplay rules, endpoints, payload schema, or backend behavior changed.
- CI run inspection found the latest PR CI run green with no failed jobs; recovery was blocked by review threads only.
