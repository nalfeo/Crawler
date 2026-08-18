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
- `.github/extensions/animation-viewer/catalog.mjs`
- `.github/extensions/animation-viewer/renderer.mjs`
- `.github/extensions/animation-viewer/tests/catalog.test.mjs`
- `.github/extensions/animation-viewer/tests/renderer.test.mjs`
- `package.json` (adds the viewer tests to `test:guards`)
- `docs/knowledge/handoffs/2026-08-17-animation-viewer-recovery.md`

## Verification

- `node --check .github/extensions/animation-viewer/extension.mjs`
- `node --test ".github/extensions/animation-viewer/tests/*.test.mjs"` (23 tests)
- `node scripts/agent/health/check-extensions.mjs`
- `bash scripts/agent/verify-fast.sh`
- `npm run verify:pr-prereqs`
- Opened the viewer with `public/assets/generated/player-walk-cycle-female.png`
  and observed playback in the real canvas.
- Verified non-square output at `96x144` per frame and `384x576` at 4x zoom.
- Selected `player-walk-cycle-male` from the available-animation list and
  confirmed the replacement sheet loaded and played.

## Review-round hardening

The catalog and renderer were split out of `extension.mjs` so they can be unit
tested deterministically. The review round also fixed: the `load_sheet` handler
now reads its payload from the single `ctx` argument (the SDK never passes a
second one), all dynamic text is HTML-escaped before interpolation, rows /
columns / output dimensions are validated as bounded positive integers (and the
frame rate as a bounded positive number) in the schemas, `load_sheet`, and the
catalog builder, and the open schema no longer requires sheet fields so the
selector-only empty state works — its change listener is now emitted regardless
of whether a sheet is loaded.

## Unresolved issues

None.

## Recommended next steps

Publish this as a small ready-for-review tooling PR. Do not rebase or recover
the 182-behind walk-animation experiment branch.
