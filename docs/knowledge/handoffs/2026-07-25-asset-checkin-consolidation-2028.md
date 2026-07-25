# Handoff: Asset check-in consolidation — issues #1986 and #2028

**Date:** 2026-07-25  
**Session slug:** asset-checkin-consolidation-2028  
**Apple estimate:** 1🍎  
**Closes:** #1986, #2028

## Summary

Both open `asset-checkin` tracking issues (#1986 — 14 welcome-room assets, #2028 — 4
welcome-room floor-variant assets) were resolved without needing to create a new batch
PR. Investigation revealed that all 18 assets are **already present in `main`**.

## Systems touched

sprite-pipeline

## Investigation findings

The merge-train reconciler and/or PR #2032 ("Add theme-equipment set index, create-theme
flow, and model-proposed rosters") absorbed the art surface from both checkin branches
before this consolidation session ran. Verified by:

- `git show origin/main:public/assets/generated/welcome-room-floor-seam-var-9.png | wc -c`
  → 3239 bytes (matches the checkin branch exactly, md5 confirmed identical)
- All 18 PNG files confirmed present in `origin/main` with identical content to their
  source branches.
- All manifest entries (`public/assets/generated/manifest.json`) confirmed present.
- All sprite-catalog entries (`src/shared/data/sprite-catalog.json`) confirmed present
  with `generated:` prefix format.

### Assets from issue #1986 (checkin-20260725-072019-8b6182)

14 assets — all confirmed in `main`:

- `welcome-room-cable-coil-var-0`, `-camera-rig-var-4`, `-crate-single-var-0`,
  `-crate-stack-var-3`, `-floor-seam-var-0`, `-floor-stain-var-2`, `-floor-tape-var-0`,
  `-floor-worn-var-0`, `-lounge-stool-var-1`, `-potted-plant-var-0`, `-show-poster-var-0`,
  `-side-table-var-12`, `-trash-bin-var-0`, `-wall-shelf-var-0`

### Assets from issue #2028 (checkin-20260725-175223-4db910)

4 assets — all confirmed in `main`:

- `welcome-room-floor-seam-var-9`, `-floor-stain-var-1`, `-floor-tape-var-1`,
  `-floor-worn-var-3`

## Wiring status

The floor-detail sprites (`welcome-room-floor-seam-*`, `-stain-*`, `-tape-*`,
`-worn-*`) are registered in the sprite catalog as `kind: sprite, tags: [prop,
generated, pipeline-approved]` but are **not yet referenced** by any runtime consumer:

- Not referenced in `src/shared/data/set-pieces.json` (welcome-room set piece).
- Not referenced in any TypeScript source file.

**Next step:** if these floor-detail sprites are intended to be rendered, wire them into
the welcome-room set piece as floor-kind decorations or into the terrain-packs/tilemap
system as floor overlay tiles. Open a separate non-art PR with the full test suite for
any wiring change.

The other 14 assets (props, furniture, etc.) similarly have no source wiring at this
time — their brief IDs don't appear in `set-pieces.json` or any `.ts` file. A
`sprites:placeholder-audit` pass or `sprites:generate-wiring` run (when npm deps are
available) would identify exact wiring opportunities.

## Why no batch PR was needed

The `sprites:asset-pr` script requires the `gh` CLI (blocked by DNS proxy in this
environment) and also guards against CI execution (`CI=true`). Since all assets were
already present in `main` with correct content, no merge was needed — closing the
tracking issues via PR #2043's description is sufficient.
