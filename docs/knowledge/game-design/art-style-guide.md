# Crawler — Art Style Guide

## Aesthetic Reference

**Camera / readability:** RimWorld, Prison Architect (top-down, clear readability at
small sizes). These govern _legibility and camera_, not character rendering.

**Character & world rendering (AUTHORITATIVE):** EarthBound, Chrono Trigger, Undertale,
The Legend of Zelda (A Link to the Past / Link's Awakening).

Crawler is **cartoonish, not realistic.** Bobblehead proportions are correct and
desirable. Gritty, painterly, semi-realistic, "dark fantasy grimdark" rendering is
WRONG for this game, however competent it looks in isolation.

> This section exists because it was previously absent. With no proportion or
> rendering guidance, every art wave re-invented the style from scratch and the
> generator's default — gritty semi-realistic pixel art — won by default. Several
> waves were spent actively briefing _against_ the correct style ("seven heads tall",
> "do NOT draw chibi"). Do not repeat that. If a brief and this guide disagree, this
> guide wins and the brief is the bug.

## Character Proportions

- **3 to 4 heads tall.** The head is roughly **one third** of total body height.
- Big head, small body, short chunky limbs. Mitten or simple block hands.
- Faces are simple and expressive: large dot/bean eyes, minimal or absent nose,
  a simple mouth. Expression comes from a few large features, never fine detail.
- Silhouette readability beats anatomical accuracy every time.
- Do **not** brief "realistic adult proportions", "seven heads", "lean and
  long-limbed", or anti-chibi negatives. Those are the documented wrong direction.

## Rendering

- **Flat colour fills** with hard-edged cel shading — **2 to 3 tonal stops per
  material**, never gradients.
- **Minimal dithering.** Heavy dither, noise, grain and grime read as realism and
  are wrong. Wear and age should be drawn as a few deliberate shapes, not texture.
- Clean, consistent dark outline.
- Limited palette per character; one saturated focal accent, everything else muted.
- Warm and readable over dour and muddy — even for grim subjects.

## Camera

- Fixed top-down perspective
- No camera rotation
- Zoom level adjusts for floor size

## Visual Hierarchy (Critical for Bullet-Hell Readability)

1. **Player** — Brightest, most saturated, always readable
2. **Player projectiles** — Distinct color family (blues/whites)
3. **Enemy projectiles** — Danger color (reds/oranges), high contrast
4. **Enemies** — Darker palette, silhouette-readable at small sizes
5. **XP gems / pickups** — Glowing, high saturation, draw attention
6. **Environment** — Muted, never competes with gameplay elements
7. **UI / HUD** — Clean, minimal, docked to edges

## Character Design

- Simple, iconic shapes (readable at 32x32 pixels)
- Each character has a distinctive silhouette
- 2-3 frame walk animation minimum
- Color-coded by class/role
- See **Character Proportions** and **Rendering** above — those are authoritative
  and every character brief must inherit them.

## Animation Priorities

- Placeholder programmer art is acceptable for prototype
- Juice effects (screen shake, flash, particles) are more important than detailed sprites
- Death animations should feel satisfying (pop, explode, dissolve)

## Color Palette

- TBD: Will be established during first art pass
- Constraint: Must maintain readability at 500+ entities on screen

## Resolution

- Target canvas: 1280x720 (16:9)
- Pixel art scale: TBD (16px or 32px base)
- UI renders at native resolution above game layer
