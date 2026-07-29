# Session Handoff: Floor 1 dungeon square wall corners + flush door junctions

## Date

2026-07-29

## Persona

Producer → Sprite/Terrain Engineer

## Systems touched

terrain-packs, rendering

## Apples

3🍎 estimated, 3🍎 actual (exact). Full summary: `docs/knowledge/metrics/apples/2026-07-29-floor1-dungeon-square-walls.json`.

## What Was Done

Two visible Floor 1 defects reported by the maintainer, both fixed:

1. **Rounded corners on masonry.** Every terrain pack composites its material onto
   silhouettes from the single shared blob47 quadrant kit, which was authored for
   caves and rounds every exposed corner (`CORNER_RADIUS_PX = 48` of a 256px source
   cell). `floor1-dungeon`'s manifest `derivationNote` records that its alpha comes
   from that kit unchanged — so a cut-stone dungeon inherited eroded cave geometry
   structurally. Added `WallCornerStyle = 'rounded' | 'square'`
   (`scripts/sprites/terrain-packs/wall-corner-style.ts`) and parameterized
   `generateQuadrantKit`: `square` bites concave corners with a 48×48 `eraseRect`
   (new `png-buffer.ts` export) and skips the convex rounding branch entirely. The
   inset is unchanged in both styles — only the corner treatment differs. Regenerated
   `public/assets/terrain-packs/floor1-dungeon/wall-atlas.png`; the three cave atlases
   are byte-identical.

2. **Walls stopped short of doors.** `computeRawMask8` in `terrain-renderer.ts` built
   the blob47 neighbour mask from `PACK_WALL_TERRAIN_TYPES`, which excludes
   `TerrainType.DOOR`. A wall beside a door read "floor" on that side, applied the
   18.75% inset (12px at the 64px render cell) and rounded away, leaving a notch.
   Door tiles are full-bleed so the gap was entirely wall-side. Added
   `PACK_WALL_MASK_NEIGHBOR_TERRAIN_TYPES` (wall types + `DOOR`) and used it in
   `computeRawMask8` **only** — stamping and linework keep the narrow set so door
   tiles are never painted as wall. `src/labs/terrain-pack-lab/index.ts` imports the
   same exported set so the lab preview cannot drift from the runtime rule.

A third problem surfaced during code review and was fixed: `floor1.manifest.json`
makes `floor1-dungeon` and `floor1-cave` co-resident, and
`validateCrossPackWallSilhouettes` demanded byte-identical silhouettes for
co-resident packs — so `npm run terrain-packs:validate` failed with 40
`cross-pack-silhouette-mismatch` errors. See Key Decisions.

**Observation (rule #10):** reproduced the pre-fix door notch deterministically
(`files/repro-door-gap.png`) and confirmed it gone post-fix
(`files/repro-door-fixed.png`). Observed square corners in the **real game** via
`npm run dev` + Playwright (`files/floor1-after-lit.png`,
`files/floor1-after-door-full.png`). The renderer mask fix is proven on the real
runtime path by a **fail-to-pass** unit test in `tests/unit/terrain-pack-renderer.test.ts`
driving `buildTerrainLayer` — the same function `MainGameScene.ts:2251` calls.
**Honest gap:** an in-game screenshot framing a door junction was never captured;
teleporting to a doorway kept landing outside the terrain-streaming boundary. The
door evidence is the deterministic repro + the fail-to-pass runtime-path test, not
a game screenshot.

## Key Decisions Made

Written up in **ADR 0078** (`docs/knowledge/adr/0078-per-pack-wall-corner-style.md`).

- **Corner style is derived from the pack id**, not threaded through every signature.
  Keeps `validateAuthoredSilhouetteExact(manifest, atlas)` and the compose entry
  points signature-compatible. Rejected the plan reviewer's preferred
  manifest-owned field: `cornerStyle` is build-time-only data, adding it to the
  runtime zod schema in `src/shared/terrain-pack-types.ts` would churn every
  committed manifest, and `composePack` would _still_ need an authoring-side
  registry to generate the field.
- **The registry is a `ReadonlyMap`, not a plain object.** `ComposePackInput.id` is
  an arbitrary string; with a plain object, ids like `constructor` / `toString` /
  `__proto__` return an inherited truthy value, so `?? DEFAULT` never fires and a
  non-`WallCornerStyle` reaches the geometry branch. All four shipped packs are
  declared exhaustively, enforced by a fail-to-pass test.
- **Cross-pack validation relaxed to the seam.** The property the gate protects is
  that a material boundary cannot create a notch — a statement about the cell's
  outermost pixel ring, the only pixels adjacent to a neighbouring cell. Full-cell
  equality was strictly stronger than the gate's own stated purpose, free only while
  every pack shared one silhouette kit. Now: same style → full-cell equality;
  different styles → boundary ring only (`cross-pack-seam-mismatch`). Measured on
  the real pair: 2214 differing pixels across 47 masks, **0** on the boundary ring,
  **0** in the cardinal edge bands. Escalated to the maintainer rather than deciding
  unilaterally; they chose this option.

## What's Next / Blockers

No blockers. `npm run terrain-packs:validate` reports all four packs OK and
`npm run verify:fast` passes.

Possible follow-ups:

- Floor 2+ dungeon-flavoured packs should declare `square` when authored — the
  exhaustiveness test will force the decision rather than silently defaulting to
  `rounded`.
- Consider a deterministic e2e pixel probe for the wall/door junction so the
  observe-before-done evidence for this bug class stops depending on framing a
  screenshot in a live game.

## Retrospective

### Lessons Learned

- **A visual bug can be structural rather than authored.** `floor1-dungeon`'s
  manifest `derivationNote` was the fastest route to the root cause — it said in
  plain text that the alpha came from `quadrant-kit.ts` unchanged. Reading pack
  manifests before reading pixels saved a lot of time.
- **Building a throwaway repro that reproduces the user's screenshot exactly** was
  the highest-leverage early step: it converted "walls look wrong" into two separable
  defects and gave a before/after artifact for free.
- **`ComposePackInput.id` being an arbitrary string is a real prototype-pollution
  surface.** Any string-keyed lookup with a `??` fallback over a plain object is
  wrong when the key is caller-supplied. Reach for `Map` by default.
- Sprite tests live in a **separate vitest project**; the `unit` project excludes
  `tests/unit/sprites/**`. Run them with
  `npx vitest run --project sprites tests/unit/sprites/...`.
- Rebuilding a pack needs no Azure:
  `npx tsx scripts/sprites/terrain-packs/gen/cli.ts --from-source --pack floor1-dungeon`.
- `window.__floor1Debug` (DEV only) exposes `getWorld`, `getPlayerEid`, `hasTexture`,
  `getDoorRenderSummary`, `lighting.*`, `fov.*`. Teleporting past the fog/terrain
  streaming boundary blanks terrain and the camera does not re-centre — budget for
  that when trying to frame a specific tile in-game.
- PowerShell: `Get-Content -Raw | Set-Content` silently converts files to CRLF; use
  `[IO.File]::ReadAllText` / `WriteAllText`. The ledger CLI's `--json` flag is not
  usable from PowerShell (quote mangling) — edit the ledger JSON directly and then
  run `review:ledger -- validate`.

### Mistakes Made

- **Cited "ADR 0052" in a `validate.ts` comment before writing the ADR — and 0052 was
  already taken** (slicer-never-cut-through-art). ADR numbers collide constantly
  because parallel sessions claim them; the directory already had two `0073`s, two
  `0074`s, two `0076`s. Early signal: I wrote the reference from memory instead of
  running `Get-ChildItem docs\knowledge\adr\*.md -Name | Sort-Object | Select -Last 5`
  first. Fix: pick the number _before_ citing it, and grep the repo for the number to
  confirm it is unclaimed.
- **Did not run `npm run terrain-packs:validate` after regenerating the atlas** — the
  gen CLI printed "All packs valid" for the single-pack build, which I took as
  sufficient. The cross-pack gate only runs in the full validate command, so a
  40-error blocker survived until code-review round 2. Early signal: the gen CLI's
  message says "packs" plural but only validates what it built. Fix: always run the
  standalone full `terrain-packs:validate` after touching shared geometry.
- Ran the first code-review round before the post-review edits existed, so round 2
  had to cover a moving target. Batching the plan-review fixes _then_ reviewing would
  have been one round cheaper.

### Opportunities for Future Improvement

- `scripts/sprites/terrain-packs/gen/cli.ts` should run the **cross-pack** validation
  (or at least warn that it hasn't) after a single-pack rebuild. Its current "All
  packs valid" output is actively misleading.
- ADR numbering is unmanaged and collides routinely. A tiny `npm run adr:next` that
  scans the directory and prints the next free number would remove a recurring
  papercut and the duplicate numbers already in the tree.
- The corner-style registry is a small, well-tested pattern that other per-pack
  build-time properties will want. If a second one appears, promote it to a single
  `packBuildProfile(packId)` lookup rather than adding a parallel registry.
- A deterministic pixel probe for "wall meets door flush" (in the spirit of
  `tests/e2e/hud-overlap-visual.test.ts`) would turn this bug class into a permanent
  gate instead of relying on manual in-game framing.
