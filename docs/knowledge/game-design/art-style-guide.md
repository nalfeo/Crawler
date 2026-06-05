# Crawler — Art Style Guide

## Aesthetic Reference

- **Primary:** RimWorld / Prison Architect (top-down, clear readability)
- **Secondary:** Brotato (character design, item design)
- **Tertiary:** Vampire Survivors (particle effects density, screen chaos)

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
