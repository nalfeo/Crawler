# Anchor Lab

Visually verify and adjust the 2D anchor (`{ x, y }` pixel) on an item sprite.

## What it does

- Loads any sprite from `src/engine/sprites/registry.ts` and renders it scaled
  on a 2D canvas.
- Pins the sprite at the **anchor pixel** to a fixed point at the canvas center
  (the orange dot represents the player's hand).
- Rotates the sprite around that anchor in three modes:
  - **static** — hold at a fixed angle (use this to click-set the anchor)
  - **spin** — continuous rotation, makes anchor errors obvious (a wrong grip
    looks like the weapon orbits a phantom point instead of spinning in place)
  - **swing** — back-and-forth arc, simulates an attack swing
- Shows a red crosshair at the anchor inside the sprite's local frame.
- Reports whether the chosen anchor is valid (`isValidAnchor`) for the sheet's
  frame dimensions.
- Outputs a copy-pasteable `anchor: { x: N, y: M }` snippet for the
  sprite-registry entry.

## How to use

1. Pick a sprite in the **Sprite** dropdown.
2. Watch it spin. If the sprite orbits instead of spinning cleanly, the anchor
   is off.
3. Switch **Mode** to `static`, then click on the canvas where the grip should
   be. Or nudge **x** / **y** in the **Anchor** folder.
4. Switch back to `spin` to verify the grip stays put.
5. Click **Copy** to grab the `anchor: { x, y }` snippet and paste it into the
   sprite's entry in `src/engine/sprites/registry.ts`.

## Why this exists

The sprite-generation pipeline writes briefs with an `anchor` field. The engine
`SpriteDef` now mirrors that. But there is no runtime renderer yet that
consumes the anchor — so without a lab, anchor data is invisible until the
equipped-item renderer ships. This lab gives a fast feedback loop today.
