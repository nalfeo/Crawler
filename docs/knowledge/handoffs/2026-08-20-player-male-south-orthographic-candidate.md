# Handoff: male player south orthographic candidate

**Date:** 2026-08-20  
**Mode:** local Azure generation  
**Apple estimate / actual:** 1🍎 / 1🍎 (art-only; no approval, queueing, wiring, or engine change)

## Systems touched

- `briefs/characters/player-male-south-neutral.yaml`
- Local-only candidate run under `generated/runs/player-male-south-neutral/`

## Canon and brief provenance

The candidate preserves the existing male contestant identity and the reality-show
dungeon frame from `docs/knowledge/game-design/game-design-document.md`, as
registered by `docs/knowledge/game-design/lore-bible.md`. The brief uses the
approved `player-male-neutral-front` rig as its identity seed and follows the
user-supplied 3/4-RPG-perspective reference: orthographic construction, no
vanishing point or apparent-size change, and simultaneous top/front planes.
No lore contradiction was found.

## Candidate and decision

- Run: `generated/runs/player-male-south-neutral/2026-08-21T05-49-34-532cfbcc`
- Candidate: `processed/00.png`
- Deterministic sensors: **8/8 passed**.
- VLM judgment: **failed** — design language 2/5, reference-style match 2/5,
  brief match 2/5, readability 1/5; hard-blocked.
- Eyeball review: rejected. The visible result is noisy, has uneven outlines and
  weak game-scale readability, and does not convincingly establish the requested
  south-facing orthographic 3/4 construction.

No approval, queue action, engine change, viewer-extension change, or
assets/queue conflict resolution was performed. The task required exactly one
candidate, so no regeneration was attempted. A human must explicitly request a
new generation before this asset can proceed.
