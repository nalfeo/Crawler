# Handoff - Animation Viewer recovery

## Summary

Recovered the standalone Animation Viewer from the post-merge commits on
`nalfeo-walk-anim-reference-frame-recovery` (PR #2622). The viewer now lists
approved generated animation entries and lets the user select a sheet without
entering a path manually. It also honors non-square `outputW` and `outputH`
values for individual frames and the zoomed playback canvas.

The rest of that branch remains intentionally unrecovered. Its walk-cycle
generation scripts and generated experiment outputs were explicitly local-only,
and main already ships the approved gender-specific walk-cycle sheets through
the standard frame-sequence pipeline.

## Systems touched

devtools

## Files touched

- `.github/extensions/animation-viewer/extension.mjs`
- `docs/knowledge/handoffs/2026-08-17-animation-viewer-recovery.md`

## Verification

- `node --check .github/extensions/animation-viewer/extension.mjs`
- `bash scripts/agent/verify-fast.sh`
- `npm run verify:pr-prereqs`
- Opened the viewer with `public/assets/generated/player-walk-cycle-female.png`
  and observed playback in the real canvas.
- Verified non-square output at `96x144` per frame and `384x576` at 4x zoom.
- Selected `player-walk-cycle-male` from the available-animation list and
  confirmed the replacement sheet loaded and played.

## Unresolved issues

None.

## Recommended next steps

Publish this as a small ready-for-review tooling PR. Do not rebase or recover
the 182-behind walk-animation experiment branch.
