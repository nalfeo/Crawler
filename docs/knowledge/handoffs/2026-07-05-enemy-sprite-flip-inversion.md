# Session Handoff: Fix inverted enemy sprite flip (face left at rest)

## Date

2026-07-05

## Persona

UX Designer

## Systems touched

hud-ux, enemies

## Apples

2🍎 exact

## What Was Done

Fixed an INVERTED enemy sprite flip in `src/engine/PhaserBridge.ts`. Two just-merged
PRs conflicted: #770 codified enemy sprite GENERATION as **right-facing**
(`data/sprite-types/enemy.json` → `sensors.enemy.facing: 'right'`), while #767 added
the engine flip `img.setFlipX(movingRight)`. Because Phaser's `flipX` MIRRORS the
source texture, #767's convention was only pixel-correct for LEFT-facing source art —
so with the real right-facing art, mobs rendered **backwards** (faced right at rest,
faced left while moving right).

Fix: `img.setFlipX(movingRight)` → `img.setFlipX(!movingRight)`, plus an engine-wide
invariant comment. Enemies now face LEFT at rest / moving-left (mirrored) and face
RIGHT (native, unflipped) only while moving right.

**Observed in real artifacts (rule #10, not a lab):**

- **Source art faces RIGHT:** viewed the actual generated 64×64 enemy PNGs from
  `public/assets/generated/` (`rat-v1-var-3`, `rat-v1-var-9`, `rat-king-v1-var-7`,
  `rat-queen-v1-var-7`) — every rat's snout/nose is on the RIGHT, tail on the LEFT.
- **Before (backwards):** horizontally mirroring `rat-v1-var-3.png` (== Phaser
  `setFlipX(true)`, the old code's value for a right-moving enemy) puts the snout on
  the LEFT — a rat moving right visually faced LEFT.
- **After (correct):** `flipX=false` for a right-moving enemy shows the snout on the
  RIGHT. Re-verified in the real render path via `createPhaserBridge(scene).sync(world)`
  unit tests: flipX=true at rest / sub-epsilon / moving-left; flipX=false moving-right.
  (Before/after render images saved in the session `files/`.)

## Key Decisions Made

- **Encode reality over the reviewer's assumption (rule #12):** the plan review asked
  for an exact-epsilon boundary assertion "staying left-facing". Investigation showed
  `Velocity.x` is **Float32**, so the literal `0.001` reads back as ~0.00100000004 —
  just above the f64 epsilon — and therefore _does_ flip. The added boundary test
  asserts the true behavior (flips at stored 0.001) and documents the f32 rounding;
  this is a stronger guard (pins the effective threshold to the epsilon magnitude and
  the store width).
- **De-coupled the corpse-shatter test from facing policy:** removed the incidental
  `flipX` assertion from the baby-slime corpse-shatter _scale_ test; the dedicated
  facing test owns the flip contract, so the scale test won't break on future
  facing-policy tweaks.
- Kept the fix scoped to a render flip — did NOT expand to "face the player" or
  "preserve last-facing at death" (separate behavior change, out of scope).

## What's Next / Blockers

- No blockers. Optional future work: an end-to-end deterministic pixel/orientation
  check (loading the real texture and asserting rendered facing) would guard this
  visual class beyond the flipX-boolean unit assertions.

## Review harness

- Tier: 2🍎 → `plan_review` required.
- Ledger: `docs/knowledge/review-ledgers/2026-07-05-enemy-sprite-flip-inversion.review-ledger.json`
  (validated ✅).
- Reviewer model: `gpt-5.4` (rubber-duck, xhigh). Verdict: `approved_with_changes`;
  3 non-blocking concerns, all 3 adopted.

## Retrospective

### Lessons Learned

- **`flipX` inversions must be reasoned against the SOURCE-art orientation, never in
  isolation.** A flip test that names `flipX=false` "left-facing" silently bakes in an
  assumption about how the art was authored; when the art convention changed (#770),
  the engine test still "passed" while rendering backwards. Tie the flip semantics to
  the documented art-orientation contract in a comment.
- **Boundary tests on ECS velocity must account for Float32 storage.** bitecs stores
  are Float32; a `> EPSILON` comparison against an f64 literal never sees an exact
  match, so `>` and `>=` are equivalent and exactly-`EPSILON` literals round _above_
  the threshold. Don't assume float64 semantics when picking boundary values.
- Viewing the generated PNGs directly with the image viewer is a fast, deterministic
  "real artifact" observation for facing/orientation questions — no lab needed.

### Mistakes Made

- First pass at the reviewer-requested boundary assertion asserted `flipX===true` at
  vx=0.001 (assuming float64 semantics); it failed immediately. Early signal: the
  single failing test was exactly the newly-added boundary case — a one-line `node -e`
  Float32 probe confirmed the rounding in seconds. Encode the observed behavior, not
  the assumed behavior.

### Opportunities for Future Improvement

- Promote enemy facing into a deterministic e2e pixel-orientation check
  (`tests/e2e/helpers/pixels.ts`) so an art-convention change trips a red test rather
  than shipping backwards mobs (this class has now flipped twice: #767 → #770 → this).
- Consider exporting `ENEMY_RIGHTWARD_FLIP_EPSILON` (or a small helper) so tests can
  reference the threshold symbolically instead of hard-coding `0.001`.
