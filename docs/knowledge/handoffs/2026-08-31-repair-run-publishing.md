# Repair in-game publishing feedback

## Systems touched

hud-ux, devtools

## Apples

Estimated: 3. Actual: 3. Exact calibration.

## Summary

- End-of-run publishing now preserves the structured upload result from the
  production `createFloorMainSceneOptions` sink instead of collapsing disabled
  and failed outcomes into `undefined`.
- `MainGameScene` reports successful and failed RunStats uploads through a
  dedicated action-status toast above terminal screens.
- Issue filing uses the same action-status toast, so its asynchronous result is
  no longer hidden on the next frame by the proximity-driven interaction hint.
- The existing terminal latch still publishes one complete run bundle per run,
  and issue submission remains locked while its request is in flight.

## Persona routing

- Producer framed the shared hard gate and coordinated publication.
- UX Designer traced and repaired the player-visible production paths.
- QA Engineer strengthened complete-payload and exactly-once browser coverage.
- Reviewer completed the required independent 3-apple post-diff review.

## Observation

- Before: issue submission wrote its result into `interactionHint`, which
  `updateInteractions()` hid on the next frame when the player was not near an
  interaction target. Run completion uploads exposed no player-visible outcome,
  and unexpected sink rejection was reduced to a console warning.
- After: the real `main-scene-probe-lab` boots `MainGameScene` with the shipped
  `createFloorMainSceneOptions` sink. Browser tests intercept the configured
  endpoint and observe complete issue and RunStats payloads exactly once plus
  visible success and failure confirmations.

## Verification

- Typecheck and lint passed.
- Focused upload, issue, scene, and sink unit suites passed.
- Real-browser issue-submission and completion-telemetry suites passed for both
  success and failure responses.
- Independent review found no functional defects; its stale-comment finding was
  corrected.
- `verify:fast` could not start because this Windows host resolves `bash` to the
  WSL shim and has no installed WSL distribution. Its targeted TypeScript,
  lint, unit, and browser coverage passed independently.

## Notes

- No endpoint, payload contract, gameplay behavior, or backend was changed.
- The unrelated existing dungeon-generator snapshot worktree change was not
  modified and must not be included in this PR.
