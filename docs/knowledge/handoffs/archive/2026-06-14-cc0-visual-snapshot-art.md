# Session Handoff: CC0 visual-snapshot art bridge

## Date

2026-06-14

## Apples

Estimated: 🍎 x 3
Actual: 🍎 x 3
Verdict: 🎯 Exact — a self-contained art/lab/tooling bundle (bake script + lab + judge), no core/engine churn, but lots of iterative visual debugging.

## What Was Done

Replaced the rejected procedural floor-1 art with **vendored CC0 Kenney
`tiny-dungeon` frames** baked to 64px. This is an explicit **temporary art
bridge** to stop the game looking like Asteroids — it is **not** the sprite
pipeline being built elsewhere.

- `scripts/bake-snapshot-assets.mjs` (new, kept/committed): pure node + pngjs.
  Crops `public/assets/kenney/tiny-dungeon/spritesheet.png` frames, color-keys
  the torch flame onto transparency, ×4 nearest-neighbor upscale → 64px
  `public/assets/generated/temp_*.png`, plus a `_bake-preview` contact sheet.
  Frame picks: wall **40** (clean plain brick, no grate/banding), open door
  **34** (door swung open, wide dark passage — clearly see-through), closed door
  **46** (solid door + handle), floors **48/49** (only seamless tan tiles),
  hero **96** (knight), npc **99** (princess), slime **108**, vermin **122**
  (spider — see Blockers), flame **29** (color-keyed).
- `src/labs/visual-snapshot-lab/index.ts`: rewritten on a clean integer tile
  grid (TILE=64, 11×9). Floor drawn under everything incl. walls/doorways → no
  black gaps. Uniform wall ring + an **inner drop-shadow** cast onto the floor
  for depth. **Scattered floor pebble/crack detail** for visible variation.
  See-through open door over a floor threshold + an exterior passage tile.
  Layered **glowing fireball** in flight (tail + outer glow + bright core +
  flicker, yoyo travel). Deterministic via `SeededRandom(0xc0ffee)`.
- `scripts/eval-visual-snapshot.ts`: tightened to a strict senior-art-director
  rubric (tiling / style / readability / overall) and made the dev port
  configurable via `SNAPSHOT_PORT` (default 3003).
- Deleted ~30 obsolete procedural `temp_*` assets and all temp `scripts/_*`
  inspector artifacts.

## Judge Outcome (important context)

Final strict eval: **tiling 2, style 3, readability 3, overall 2**. The user
reviewed the actual screenshot and confirmed it is cohesive and a massive jump
from the prior art. We established the VLM judge is **anchored on boilerplate
criticism** — its final rationale claims "no fireball glow", "no floor
variation", and "open door has no passage", all of which are **demonstrably
present in the screenshot it scored**. Style is capped ~3 ("amateurish vs
Terraria") because flat 16px Kenney CC0 art has an inherent fidelity ceiling no
amount of tiling work can lift to a "modern pixel game" ≥4.

**User decision (explicit):** accept cohesive Kenney CC0 as the temporary look,
fix the concrete defects (wall corners/banding, clearer open door, floor
variation), and ship even though judge style stays ~3. All those concrete
defects were addressed. We intentionally **stopped iterating** rather than burn
the 20-iteration budget against an unmovable judge.

## What's Next

- If true "Terraria-quality" is required, the only path is sourcing a richer,
  higher-fidelity CC0 dungeon tileset (web sourcing previously failed — itch-only
  packs, hallucinated URLs). Flag before attempting again.
- Wire these `temp_*` assets into the real game scene if the team wants the
  bridge art in actual gameplay (currently only the snapshot lab consumes them).
- Find/commission a real **rat** sprite — every vendored CC0 pack lacks one, so
  a spider currently stands in as the vermin.
- The judge could be rebuilt to compare against a reference image instead of an
  absolute "modern game" bar, to reduce boilerplate anchoring.

## Blockers

- No CC0 rat exists in any vendored pack (tiny-dungeon, tiny-town,
  roguelike-rpg-pack, roguelike-characters) → spider substitute.
- VLM judge will not score flat Kenney CC0 ≥4 on style regardless of tiling
  quality; this is accepted per the user decision above, not a code bug.

## Branch State

- Branch: `nalfeo/cc0-visual-snapshot-art`
- Commit: `lab: cohesive CC0 dungeon art for visual-snapshot lab`
- `npm run verify:fast`: passing (114 files, 1144 tests)
- `npm run verify` (full): not run this session
- PR created: no
