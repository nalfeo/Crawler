# Crawler Sprite Style Guide

> Source of truth for the visual style of every sprite the generation pipeline produces. This file is loaded as plain text and concatenated into **every** prompt sent to the image provider as a hard preamble. It is how we keep the model grounded on the project's style — alongside the mandatory ≥2 reference images per brief (see ADR `0003`, spec F2.3). Reference images do ~90% of the style fidelity work; this preamble pins the remaining hard constraints so the model cannot drift into "generic AI pixel art".

## The style in one paragraph

Crawler sprites are **16×16 pixel art** in the Kenney roguelike tradition — solid filled shapes with a 1-pixel dark outline on the silhouette, two-stop shading inside (a base mid-tone plus a darker shadow on the lower / right side), no anti-aliasing, no decorative noise. The whole frame must read as a **single subject** centered on a transparent background, square, with no decorative borders. Silhouettes-first: if the shape doesn't read at 1× over a dark floor tile, the sprite is wrong regardless of how nice the interior detail looks.

## Hard constraints (these are non-negotiable)

The generator MUST follow every constraint below. Each is also enforced by a deterministic sensor downstream (see `scripts/sprites/sensors/`):

1. **Size:** the final sprite is exactly `[width, height]` from the brief — typically 16×16. The model is asked for 1024×1024; the post-processor does the nearest-neighbor downscale.
2. **Palette:** every opaque pixel must snap to an exact entry in `data/palettes/kenney-roguelike.json` (the locked Kenney roguelike palette). No off-palette colors. No gradients. No hue shifts the palette doesn't already contain.
3. **Alpha:** every pixel is fully opaque (alpha 255) or fully transparent (alpha 0). No partial transparency, no anti-aliased fringes.
4. **Background:** transparent — or, if the model insists on solid, a flat neutral color (pure white, pure black, or pure magenta `#ff00ff`) reachable from the frame corners so the post-processor can flood-fill it away. No decorative backgrounds, no checkerboards, no gradients, no shadows under the subject.
5. **Composition:** a **single subject**, **centered**, **square aspect**, **fully inside the frame** with at least 1 pixel of breathing room on every side at the final 16×16 size.
6. **No text of any kind.** No numbers, no digits, no labels, no captions, no signatures, no watermarks, no UI chrome. The pipeline rejects sheets where the model added a number on each cell — this happens often enough that it must be called out explicitly in the prompt.
7. **No multiple subjects per cell.** If the brief asks for a sword, the cell shows one sword — not "a sword on a shield" or "a sword next to a coin".
8. **No anti-aliasing.** Edges are hard. Color transitions are 1-pixel boundaries between palette entries.

## Visual conventions

These are softer guidelines — the model should follow them, but downstream sensors don't enforce them. Reference images do most of the work here:

- **Outline:** one-pixel-wide dark outline on the silhouette. Pure black is fine; a near-black palette entry is preferred.
- **Shading:** two stops inside the silhouette — a base mid-tone covering most of the shape, plus a darker shadow stop on the lower-right side. Highlights, if any, are 1-pixel pops in the upper-left. Avoid more than three stops total per material — Kenney sprites are deliberately flat.
- **Silhouette first:** the shape should read clearly at 16×16 even with all interior detail removed. Test mentally: "if I painted the whole sprite black, would I still know what it is?"
- **Orientation:** weapons stand **vertical** by default — held upright with the grip at the bottom and the business end at the top. This is what `data/sprite-types/weapon.json` sets, so the in-game renderer can rotate any weapon around a single known axis. Briefs that genuinely need a side-profile / diagonal shape (e.g. `iron-sword.yaml`) override with `sensors.weapon.orientation: diagonal`. Characters face the viewer. Items sit grounded as if on a surface.
- **Anchor pixel:** every brief declares an `anchor` (typically the grip on a weapon, the feet on a character, the base on an item). That pixel must be opaque in the final 16×16 sprite — the engine uses it to attach effects, hands, etc.

## Sheet-mode layout

Default sheet-mode generation asks for a **4×4 grid of 16 distinct variants** on a 1024×1024 canvas (configurable per brief). 1024 ÷ 4 = 256, so every cell is a clean integer 256×256 — the post-processor nearest-neighbor downscales by ×16 / ×8 / ×4 to 16×16, 32×32, or 64×64 with no resampling artefacts. 16 variants per call gives the scoring loop plenty of headroom to reject low-quality candidates without paying for a second provider round-trip. Each variant occupies one cell. Constraints for the grid:

- Cells are equal-sized squares, arranged left-to-right, top-to-bottom.
- Each variant fits **fully** within its cell — no cropping, no overflow into the adjacent cell.
- Variants are **distinct**: different silhouette / proportions / hilt-shape / shading choices. Diversity is the entire point of sheet mode.
- All variants share the same orientation, same scale, same subject type. They are siblings, not "a sword, then a dagger, then an axe".
- The same background-color rules apply to the **whole sheet**: a flat neutral color the post-processor can flood-fill, or transparent. No per-cell borders, dividers, or labels.

## The prompt preamble

The exact text below is what `scripts/sprites/build-prompt.ts` concatenates at the top of every prompt. Editing this section is the supported way to change generator behavior across all briefs at once. Keep it short — the model has a finite attention budget and the brief-specific subject description is what we want it to spend it on.

> --- STYLE PREAMBLE (do not deviate) ---
>
> You are generating pixel art in the **Kenney roguelike** style for the game *Crawler*. Every output must follow these rules without exception:
>
> 1. Hard 1-pixel outlines. No anti-aliasing. No partial transparency. Edges are crisp 1-pixel transitions between solid colors.
> 2. Limited palette: flat fill colors only, no gradients. The downstream pipeline will snap every pixel to a fixed 70-color palette, so subtle hue variation will be lost — use bold, distinct colors.
> 3. Two-stop shading inside each shape: a base mid-tone plus a darker shadow on the lower-right side. Optional 1-pixel highlight in the upper-left. No more than three color stops per material.
> 4. **Single subject, centered, square**, fully inside its cell with at least 10% margin on every side.
> 5. **Transparent or flat neutral background** (pure white, pure black, or pure magenta). No decorative backgrounds, no shadows under the subject, no scene props.
> 6. **No text, numbers, digits, labels, captions, watermarks, signatures, or UI chrome anywhere in the image.** This is the single most common failure mode and it makes the output unusable.
> 7. Silhouette-first composition: the shape must read clearly even with all interior detail removed.
> 8. Match the visual weight, outline thickness, and color saturation of the reference images attached to this request. The references are the ground truth for style — when in doubt, copy them.
>
> --- END STYLE PREAMBLE ---

## When to update this file

- A new asset family (enemies, tiles, VFX) needs conventions the weapon-focused MVP didn't cover → add a new H2 section, do not edit the existing weapon-tuned text in place. Sprites already approved against the old text must still pass the new sensors.
- A repeated failure mode shows up across briefs (e.g., model keeps adding swirly magic effects to weapons) → add a numbered prohibition to the prompt preamble.
- The palette is replaced or extended → update §"Hard constraints" item 2 and bump the ADR.

Avoid wordsmithing the preamble. Every additional sentence is a sentence the model has to track. Add only when a deterministic sensor downstream isn't enough and human review keeps flagging the same complaint.
