---
applyTo: 'src/game/**'
---

# Game Layer Instructions

Game-specific systems: crafting, loot, floors, AI integration.

## Rules

- Import from `src/core/` and `src/shared/` ONLY
- NO imports from `src/engine/` or `src/labs/`
- AI content (Ollama) is called during floor-load, NEVER mid-gameplay
- All game randomness uses `world.rng` (SeededRandom) — never `Math.random()`
- Crafting recipes, loot tables, and floor configs are data-driven (JSON/TS objects)

## AI Content Pipeline

- `src/game/ai/` contains Ollama integration
- Content generated during floor transitions (loading screen)
- Always provide static JSON fallbacks
- Validate AI output with Zod schemas
