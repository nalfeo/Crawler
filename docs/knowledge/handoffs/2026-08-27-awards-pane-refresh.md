# Awards pane refresh

## Status

Implemented a focused UX refresh for the real Awards pane and shared reward-opening overlay.

## Systems touched

engine-ui, labs

## Changes

- Renamed the pane heading to Awards and added an unlocked/rewards-ready progress summary.
- Increased pane and row breathing room, strengthened unopened reward actions, and visually subdued claimed rows.
- Added a framed modal surface and divider to RewardOpeningUI without changing sequence, input-lock, or grant semantics.
- Added a real MainGameScene probe method so review setup can open the safe-room-gated pane through the shipped UI path.

## Evidence

- Before: `files/visual-review/before/main/awards-pane.png`
- After: `files/visual-review/after/v1/awards-pane.png`
- Reward overlay: `files/visual-review/after/v1/awards-reward-opening.png`
- The Azure-backed `review:visual:llm` run was blocked because `AZURE_OPENAI_ENDPOINT` is not configured in this environment; no evaluator score is claimed.

## Verification

- `npm run typecheck:src` passed.
- Engine lint passed.
- Unit test command was started but did not complete in the available run window.
