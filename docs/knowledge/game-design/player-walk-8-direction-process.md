# Player walk animation process

This is the production process for the male contestant's eight-direction walk
set. The supplied pixel-walking lookbook is treated as a consistency contract:
readable silhouette at game scale, one locked palette and outline, stable feet
and body pivot, and pose changes limited to gait and camera-facing orientation.

## Neutral-rig-first workflow

1. Generate and approve **one** ordinary static sprite:
   `player-male-neutral-front`. It is a directly front-facing, symmetric neutral
   stance -- not a frame sequence, spritesheet, or walk pose. This is the source
   of truth for head size, torso width, leg length, foot placement, palette,
   outline weight, and shadow policy.
2. Freeze the approved neutral rig. For every direction, supply it as the first
   seed frame and supply that direction's rasterized skeleton guide as the
   second seed. The generator must rotate the rig; it must never redesign it.
3. Generate neutral direction sprites in this order:
   `southEast`, `east`, `northEast`, `north`, `northWest`, `west`, `southWest`.
   Each is a separate normal one-cell brief and must be accepted against both
   the neutral rig and its skeleton guide before proceeding.
4. Create the four-frame gait for each accepted direction from that direction's
   neutral sprite and its gait skeletons. Keep one shared ground line and the
   same center/pivot in every frame.
5. Pack the reviewed direction clips into one atlas in
   `north, northEast, east, southEast, south, southWest, west, northWest`
   order. Each direction starts with its resting frame.
6. Approve the atlas only after deterministic clip checks and the LLM
   cross-direction consistency/stability review pass; then record inclusive
   ranges in `animation.directions`.

## Hard acceptance checks

- All eight clips use the same frame size, frame rate, palette, outline, and
  character identity.
- Every clip has a stable floor line and feet-center pivot; no directional clip
  bobs when played.
- The neutral front rig remains canonical and is never regenerated as a side
  effect of another direction or gait pass.
- No weapon, shield, text, border, cast shadow, background bleed, or clipped
  limb appears in any cell.
- At the game's display size, the silhouette and gait read without relying on
  facial detail.

The engine accepts legacy single-row strips unchanged. Directional sheets add
`animation.directions`, mapping each compass direction to an inclusive atlas
frame range. Until the full set is regenerated, the existing male strip is
registered as a temporary placeholder for all eight clips; it intentionally
reuses the south-facing frames rather than pretending to contain finished
directional art.
