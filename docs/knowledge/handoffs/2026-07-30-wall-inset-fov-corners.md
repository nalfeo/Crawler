# 2026-07-30 — Wall inset against non-walkable neighbours + FOV corner reveal

## Summary

Fixed two Floor 1 terrain rendering defects (2🍎, stacked on `nalfeo-effective-disco`
/ PR #2332, since squash-merged to `main` as `a33161c5b`):

1. **Wall inset bled floor into rock/edges.** Authored terrain-pack walls
   inset away from any cardinal neighbour whose terrain didn't literally
   equal a wall type, including `TerrainType.VOID` (solid rock) and
   out-of-bounds (map-edge) neighbours. This stamped the pack's floor pool
   in the inset sliver, which visually leaked room floor into the void /
   past the map edge.
2. **Room interior corners never received FOV.** `fovSystem.ts`'s
   `onVisible` applied `hasBlockedCornerSeam` (meant to stop a ray
   squeezing _through_ a diagonal gap between two walls) to the tile the
   ray _terminates on_ as well. An interior room corner block is diagonal
   from the player with both orthogonal wall runs opaque, so it always
   failed this check and stayed permanently black even though the walls
   beside it lit up normally.

See `docs/knowledge/adr/0079-wall-inset-non-walkable-neighbours-and-fov-corner-terminal-exemption.md`
for the full design rationale (required because this diff touches both
`src/core` and `src/engine`).

## Files touched

- `src/shared/terrain-pack-mask.ts` — `computeRawMask8` gained an
  `outOfBoundsMatches` parameter (default `false`, unchanged behavior for
  existing same-terrain-pool callers); pack wall-mask callers pass `true`
  so an edge wall full-bleeds instead of insetting into nothing.
- `src/engine/terrain-renderer.ts` — `PACK_WALL_MASK_NEIGHBOR_TERRAIN_TYPES`
  extended with `VOID`, `WOOD_WALL`, `TREE` (deliberately excludes `WATER`/
  `LAVA` — non-walkable but not rock, a wall should still inset against
  visible liquid). Passes `outOfBoundsMatches: true` at its wall-mask call
  site.
- `src/labs/terrain-pack-lab/index.ts` — mirrors the renderer's
  `outOfBoundsMatches: true` argument so the lab and the real game never
  drift on this predicate.
- `src/core/systems/fovSystem.ts` — `onVisible` reordered so an opaque
  terminal tile is revealed unconditionally (whole-tile reveal, matching
  existing opaque behavior) before the corner-seam check runs at all.
  Transparent (floor) tiles are unaffected and keep the existing seam
  rule, preserving the documented FOV/`lineOfSight` agreement invariant.
  `hasBlockedCornerSeam` and `lineOfSight` themselves are **unchanged**.
- `src/labs/ai-runner-lab/scenario-presets.ts` — extended
  `TERRAIN_JUNCTION_SLICE` with a VOID-bordered wall run (`voidWall`
  x=2, y=8-11) and a VOID pocket (`voidPocket` x=1, y=8-11) for Fix 1
  coverage; the existing enclosed room in the slice already exercises
  Fix 2 (all four interior corners visible from `playerTile: {x:11,y:10}`).
- `tests/unit/terrain-pack-renderer.test.ts` — 2 new hard-gate tests: a
  VOID neighbour sets the wall-mask cardinal bit; an out-of-bounds
  neighbour sets the wall-mask cardinal bit. 3 pre-existing tests fixed
  for the new default-`false` OOB semantics.
- `tests/unit/terrain-pack-floor1-biomes.test.ts` — 1 pre-existing test
  fixed for the same OOB semantics change.
- `tests/ecs/fov-system.test.ts` — new hard-gate test: standing inside a
  rectangular room, all four interior corner blocks are marked visible,
  and no tile beyond a wall is revealed. Fixed one pre-existing
  `isVisibleSubtile(0,0)` expectation affected by the reorder.
- `tests/ecs/fov-system-equivalence.test.ts` — reordered the embedded
  reference FOV algorithm to match the production reorder so the
  equivalence check stays meaningful.
- `tests/unit/ai-runner-scenario-presets-wiring.test.ts` — 2 new tests
  asserting the VOID-adjacent wall geometry and corner-door-exclusion
  exist in the authored `TERRAIN_JUNCTION_SLICE`.
- `docs/knowledge/review-ledgers/2026-07-30-wall-inset-fov-corners.review-ledger.json`
  — 2-apple ledger (no review stages required at this tier), validated.
- `docs/knowledge/adr/0079-wall-inset-non-walkable-neighbours-and-fov-corner-terminal-exemption.md`
  — new ADR (required: diff spans `src/core` + `src/engine`).

No atlas regeneration was performed or needed — both fixes are purely
neighbour-predicate/ordering changes using the existing blob47 atlas
frames.

## Verification run

- `npm run verify:fast` — passed (run twice: once mid-session, once again
  after the final `sync:main` rebase onto current `origin/main`).
- `npm run review:ledger -- validate` — `✅ valid 2-apple ledger (stages: )`.
- `npm run terrain-packs:validate` — **not run**; not required, since no
  files under `scripts/sprites/terrain-packs/` were touched by this
  change (only the shared mask helper and the renderer/lab call sites
  that consume it).
- **Manual visual verification in the running lab** (rule #10,
  observe-before-done — mandatory per the task spec):
  - Launched `npm run lab` detached; served on port 17281 in this
    environment (not 15281 as assumed in the original task spec).
  - Navigated to
    `http://localhost:17281/lab.html?lab=ai-runner&scenario=terrain-wall-junctions`.
  - Confirmed `window.__aiRunnerDebug().scenarioPreset === 'terrain-wall-junctions'`.
  - Removed fog via
    `window.__floor1Debug.lighting.setConfig({ ambient: 1, discoveredLight: 1 })`.
  - **Fix 2 (corners):** screenshotted the central enclosed chamber — all
    four visible interior corners are cleanly lit, no black gaps, matching
    the wall runs beside them.
  - **Fix 1 (void wall):** used `window.__floor1Debug.getWorld()` /
    `getPlayerEid()` to teleport the player's ECS position directly next to
    the `voidWall` column (tile x=2, y=8-11) and single-stepped the sim via
    the lab's "Step" control, then screenshotted and cropped/zoomed the
    result: the wall column renders as a full stone-brick strip flush
    against solid black VOID on its outer edge, with **zero** floor-pool
    sliver leaking into the void — before this fix, the same geometry
    would have shown a lighter floor-textured strip inset from the void
    boundary.

## Unresolved issues / anomalies encountered this session

- **An unauthorized commit appeared on this branch mid-session**
  (`c894227fc`, "docs(review): restore 3-apple review tier for wall
  inset/FOV change", authored under the shared Copilot bot co-author
  identity) that silently overwrote the correct 2-apple review ledger back
  to 3-apple with two required review stages, contradicting the
  maintainer's explicit verbatim instruction ("This is a 2🍎 change") and
  the repo's own complexity policy (which only permits **downward**
  re-scoring, never automatic upward escalation). It was reverted
  (`git revert --no-edit c894227fc`) and the ledger re-validated at 2🍎.
- **A second, separate anomaly**: later in the session, `git status`
  showed a **staged (but uncommitted) diff** that would have reverted the
  actual Fix 1 and Fix 2 source changes (`src/shared/terrain-pack-mask.ts`,
  `src/engine/terrain-renderer.ts`, `src/core/systems/fovSystem.ts` back to
  their pre-fix state) — 127 deletions removing the `outOfBoundsMatches`
  parameter, the `PACK_WALL_MASK_NEIGHBOR_TERRAIN_TYPES` extension, and the
  `fovSystem.ts` reorder/doc-comments. This was caught before commit via
  `git diff --cached` inspection and discarded with
  `git restore --staged --worktree <files>`; verified the working tree
  returned to exactly the committed state and re-ran `verify:fast` to
  confirm.
- Both anomalies affected only local worktree/branch state (ledger content,
  staged-but-uncommitted source reverts) and were caught and corrected
  before this PR was opened. **The maintainer should be aware some
  concurrent process in this environment is generating unsolicited
  commits/staged changes that attempt to weaken or revert this session's
  work** — origin unclear (possibly a stray guard, another concurrent
  agent/session sharing the worktree, or an environment restart artifact).
  Recommend treating any unexpected staged/committed diff on an
  in-progress branch as suspect and diffing it against the session's own
  intended changes before trusting `git status`/`git log` at face value.

## Recommended next steps

- PR 2 (per-side apron underdraw blending) and PR 3 (door sizing) are the
  two remaining root causes from the original four-symptom report — out
  of scope here by explicit instruction, tracked separately.
- Consider whether the ADR README index
  (`docs/knowledge/adr/README.md`) should be updated with an entry for
  ADR 0079 in a future docs-maintenance pass; it was not updated in this
  session to avoid manual-index merge-conflict risk (matching the same
  policy already applied to `docs/knowledge/handoffs/INDEX.md`).

## Systems touched

mapgen, lighting, devtools
