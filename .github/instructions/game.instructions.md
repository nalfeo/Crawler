---
applyTo: 'src/game/**'
---

# Game Layer Instructions

Game-specific systems: crafting, loot, floors, AI integration.

## Rules

- Do NOT import from `src/engine/` or `src/labs/`
- Import game logic from `src/core/` / `src/shared/`; third-party dependencies are allowed when needed
- AI content (when implemented) is called during floor-load, NEVER mid-gameplay
- All game randomness uses `world.rng` (SeededRandom) — never `Math.random()`
- Crafting recipes, loot tables, and floor configs are data-driven (JSON/TS objects)
- **Declare apple complexity** before starting: 🍎–🍎🍎🍎🍎 per `docs/agent-os/policies/complexity-policy.md`

## AI Content Pipeline

- `src/game/ai/` is the reserved integration location
- Content is generated during floor transitions (loading screen)
- Always provide static JSON fallbacks
- Validate AI output with Zod schemas
