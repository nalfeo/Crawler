# Handoff — Walk animation generation paused

**Date:** 2026-08-11
**Branch:** `nalfeo-walk-anim-reference-frame-recovery`
**Status:** Paused intentionally; durable source is committed, generated experiments remain local-only.
**Apples:** Estimated 2🍎, actual 2🍎 (exact).

## Systems touched

sprite-pipeline, sprite-workflow, devtools

## Durable branch state

The working tree was clean before this handoff. Before the pause checkpoint, the
branch contained five commits on top of its merge base with `origin/main`:

1. `779f759e2` — seed-frame schema, prompt, provider wiring, and the approved
   female frame-0 seed PNG.
2. `f116a0275` — female v2 brief plus unit/integration coverage for seed frames.
3. `027e8d7ab` — the original seed-frame handoff and 2-apple review ledger.
4. `d2f0f860a` — `identityOnly` seed semantics, near/far-limb prompt iteration,
   and the reusable Animation Viewer canvas extension.
5. `dfd354083` — sequential 1x1/2x2 walk-cycle experiment driver and frame-size
   normalization before strip packing.

The pause checkpoint adds this handoff and removes two lint-only unused initial
assignments from the experiment driver's command-output handling.

The durable Animation Viewer is:

`/.github/extensions/animation-viewer/extension.mjs`

It registers the `animation-viewer` canvas, loads a sheet by path, slices an
arbitrary rows-by-columns grid, plays it at an adjustable frame rate and zoom,
shows each frame, and supports replacing the sheet through `load_sheet`.

## Current experiment design

`scripts/sprites/experiments/walk-cycle-sequential.ts` generates the four poses
one at a time. Each chosen frame becomes an `identityOnly` seed for the next
frame, so identity/palette/outfit should carry forward without asking the model
to copy the previous pose.

- `--mode 1x1`: one pose candidate per generated sheet.
- `--mode 2x2`: four render variants of the same pose per generated sheet.
- `--mode both`: runs both strategies in sequence.
- The four chosen PNGs are normalized to a common height by top-padding with the
  frame background color, then packed into a horizontal strip.

The committed female brief is still stored at
`briefs/characters/player-walk-cycle-female-v2.yaml`, but its current internal
name and tags identify the latest prompt iteration (`player-walk-cycle-female-v6`
and `v5`). Treat the filename as historical rather than as the true revision.

## Local-only experiment artifacts

These outputs are intentionally ignored and are not durable outside this
worktree:

- Completed 1x1 strip:
  `generated/experiments/walk-sequential-1x1-2026-08-01T17-33-05/strip.png`
  (488,496 bytes).
- Completed 2x2 strip:
  `generated/experiments/walk-sequential-2x2-2026-08-01T17-47-14/strip.png`
  (572,540 bytes).
- Three earlier 1x1 attempt directories contain only partial artifacts:
  `17-21-52`, `17-26-07`, and `17-29-54`.

Both completed strips were opened in separate Animation Viewer instances
(`walk-1x1` and `walk-2x2`). No final human accept/reject decision was recorded,
so neither strip should be approved or checked in merely because it exists.

If this worktree may be deleted before resumption, copy the two completed
experiment directories elsewhere first or rerun the committed experiment
script. Do not commit them as game assets unless one is explicitly approved
through the normal sprite workflow.

## Known limitations and cautions

- `runBrief()` deliberately continues after a sensor-failing sprite CLI exit and
  uses the pipeline's best candidate. That is useful for comparing experiments
  but is not an approval signal.
- `_assemble-strip.ts` is a one-off recovery helper with the completed 1x1
  directory hard-coded. The reusable entry point is
  `walk-cycle-sequential.ts`.
- The Animation Viewer currently uses `outputW` for both display dimensions;
  `outputH` is accepted but not consumed. This is harmless for the square walk
  frames but should be corrected before relying on rectangular-frame previews.
- The branch is substantially behind current `origin/main`. On 2026-08-11,
  `git rev-list --left-right --count origin/main...HEAD` reported `85 5`.
  Preflight and the periodic sync both attempted a rebase, conflicted while
  replaying `779f759e2`, and aborted cleanly. No rebase remains in progress.
- The previous upstream branch was gone at handoff time. Push this branch before
  treating it as recoverable from GitHub.

## Resume sequence

1. Fetch `origin/main` and reconcile the five commits with current main. Resolve
   the first conflict at `779f759e2` by comparing current sprite-pipeline
   seed/reference handling rather than blindly taking either side.
2. Reload extensions after synchronization so the committed Animation Viewer
   and current guards are active.
3. Run `npm run verify:fast`, then the targeted sprite unit/integration suites if
   reconciliation changed seed-frame behavior.
4. Reopen the two local strips in the Animation Viewer if they still exist, and
   make an explicit human 1x1-versus-2x2 verdict. Rank identity consistency
   first, natural opposite-limb motion second, stable scale/floor line third.
5. If neither strip is acceptable, iterate the committed sequential script or
   prompt language. If one is acceptable, run the normal sprite judge,
   approval, check-in, wiring, and real-game observation path.

## Related context

- `docs/knowledge/handoffs/2026-08-01-walk-anim-seed-frame.md`
- `docs/knowledge/handoffs/2026-07-29-multi-frame-walk-cycle.md`
- `docs/knowledge/handoffs/2026-07-30-gender-player-walk-cycles.md`
- `docs/knowledge/handoffs/2026-07-29-player-walk-animation-layer.md`

## Verification at pause

- `node --check .github/extensions/animation-viewer/extension.mjs`
- `npm run verify:fast`
