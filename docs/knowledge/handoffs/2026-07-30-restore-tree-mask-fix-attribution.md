# 2026-07-30 — Restore TREE to wall mask; correct ADR/handoff attribution

## Summary

Follow-up to PR #2359 (merged as `de14465c9`), correcting two things in that
PR's own content. 1🍎.

1. **`TerrainType.TREE` restored to `PACK_WALL_MASK_NEIGHBOR_TERRAIN_TYPES`.**
   #2359 dropped it, reasoning that a trunk neither fills its cell nor reads as
   a wall face. That substituted speculation about art that does not exist for
   the stated requirement — _"we should not inset on sides of a wall where the
   other side is not walkable."_ `TREE` is not walkable, so it belongs in the
   set. No generator writes `TREE`, so the entry is inert either way; the point
   is that the set should match the stated rule rather than only the terrain
   that currently happens to exist.
2. **ADR 0079 and the #2359 handoff corrected.** They described the implementing
   session as inventing a maintainer quote and as the source of "unauthorized"
   changes. That was false.

## What actually happened (the attribution correction)

The implementing session was quoting its delegation prompt verbatim. That prompt
was written by the delegating session — this one — and contained both:

- `This is a 2🍎 change`
- `Do NOT relax hasBlockedCornerSeam itself or change lineOfSight`

Both constraints were wrong. The corner cannot be **lit** without changing
`lineOfSight`, because `src/engine/lighting/light-field.ts` consumes it via the
`FloorMap.hasLineOfSight` wrapper. But the delegate followed the constraints
correctly, independently diagnosed the over-broad seam bypass on its merits, and
**escalated instead of exceeding its authority** — the required behaviour under
the "never weaken an explicit requirement without asking" rule.

The constraint was the mistake, not the implementation. Verified by querying the
session store directly:

```sql
SELECT user_message FROM turns
WHERE session_id = '<delegate>' AND turn_index = 0
```

## Files touched

- `src/engine/terrain-renderer.ts` — `TREE` restored to the mask set; doc block
  updated to explain it is inert-but-rule-consistent rather than excluded.
- `docs/knowledge/adr/0079-wall-inset-non-walkable-neighbours-and-fov-corner-terminal-exemption.md`
  — decision records `TREE`; "Alternatives Considered" now records that the
  rejected approach was implemented under a wrong scoping constraint, and that
  the constraint was revised rather than the requirement weakened.
- `docs/knowledge/handoffs/2026-07-30-wall-inset-fov-corners.md` — the false
  "fabricated quote" framing replaced with the two lessons below.
- `docs/knowledge/review-ledgers/2026-07-30-restore-tree-mask-fix-attribution.review-ledger.json`

## Verification run

- `npm run verify:fast` — passed.
- No behaviour change: `TREE` is unwritten by every generator, so the mask entry
  cannot change a rendered frame. The rest of the diff is documentation.
- `npm run review:ledger -- validate` — `✅ valid 1-apple ledger`.

## Unresolved issues / anomalies

- **PR #2359 merged while these corrections were in flight.** Auto-merge fired at
  08:19:39Z and GitHub deleted the head branch; a subsequent push recreated
  `nalfeo-studious-pancake` as a stray branch containing the corrections. They
  were cherry-picked onto `main` for this PR. The stray branch should be deleted.
- **A PR's head branch is not always the delegate's local branch name.** #2359
  was backed by `nalfeo-studious-pancake`; the delegate's local branch
  `nalfeo-wall-inset-fov-corners` was never pushed and did not exist on the
  remote. Both sessions spent real effort believing they were editing the same
  thing, and the delegate's local reverts had no effect on the PR. Confirm with
  `gh pr view <n> --json headRefName,headRefOid` before concluding anything about
  who changed what.

## Lessons worth keeping

- **A wrong constraint in a delegation prompt is indistinguishable, from the
  inside, from a correct one.** When a delegate reports "the fix needs exactly
  what you told me not to touch", treat it as signal about the constraint, not
  as resistance to override.
- **Check provenance before calling something fabricated.** One
  `turns.user_message` query at `turn_index = 0` settles authorship. Getting it
  wrong is cheap to avoid and expensive to leave in a permanent record — an ADR
  and a handoff both shipped with the wrong story before this correction.

## Recommended next steps

- PR 2: per-side apron underdraw blending. Material follows the facing cell's
  pack; sliver brightness follows that cell's visibility. Note the constraint
  found while planning: the apron is `WALL_INSET_PX = 48/256` = 18.75% of a cell,
  but FOV sub-tiles at `subFactor` 2 are 50% of a cell, so the apron cannot be
  distinguished from the wall body by the visibility bitmap. The light field
  itself samples at `stepPx: 4`, so the fix belongs in the visibility gate, not
  in a global `subFactor` increase.
- PR 3: door sizing and genuine side-on E/W door art.
- Delete the stray `nalfeo-studious-pancake` branch.

## Systems touched

mapgen, lighting
