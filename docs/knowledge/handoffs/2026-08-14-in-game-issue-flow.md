# Handoff: In-game issue reporting

## Systems touched

hud-ux, mobile-ux, devtools

## Apples

Estimated: 3. Actual: 3.

## Summary

- Added active-game issue reporting through F8 and the touch-friendly `Issue`
  corner button, using the existing modal picker.
- Opening the report saves and pauses the exact prior simulation state; cancel
  and submit restore that state. In-flight submissions cannot reopen the flow.
- The client submits PR2's `POST /runs` payload when `VITE_RUNS_INGEST_URL` is
  configured, with `file_issue: true`, a required description, optional bounded
  current logs, and an optional bounded PNG captured from the Phaser renderer.
- Added pure payload/screenshot tests and real `MainGameScene` E2E coverage for
  pause restoration.

## Observation

- Before: `files/visual-review/issue-flow-before.png` captured the shipped game
  without the reporting affordance.
- After: `files/visual-review/issue-flow-after.png` captured the shipped game
  with the File an issue picker over the active scene. The renderer screenshot
  is captured before the picker opens, so attached evidence contains gameplay
  rather than the modal.

## Verification

- `npm run typecheck`
- Focused issue-flow unit tests and `main-game-scene-ui-exclusivity` E2E
- `npm run review:visual:deterministic`
- `npm run verify:fast`

## Configuration

Set `VITE_RUNS_INGEST_URL` to PR2's deployed `POST /runs` endpoint. No client
secret is required or accepted.
