---
applyTo: 'src/game/**'
---

# Game Layer Instructions

Game-specific systems: crafting, loot, floors, AI integration.

## Rules

- Do NOT import from `src/engine/` or `src/labs/`
- Import game logic from `src/core/` / `src/shared/`; third-party dependencies are allowed when needed
- AI content: **deterministic runtime AI** (headless runner, BT kernels, win-rate sweeps) runs every frame; **LLM/Director content**, when implemented, runs only during floor-load transitions
- All game randomness uses `world.rng` (SeededRandom) — never `Math.random()`
- Crafting recipes, loot tables, and floor configs are data-driven (JSON/TS objects)
- **Declare apple complexity** before starting: 🍎–🍎🍎🍎🍎🍎 per `docs/agent-os/policies/complexity-policy.md`

## AI Content Pipeline

`src/game/ai/` has two roles (see `.github/instructions/ai.instructions.md`):

- **Deterministic runtime AI** — headless runners, BT kernels, win-rate sweeps. Runs every frame, uses `world.rng`.
- **Future LLM / Director content** — floor-load only, Zod-validated, always with static JSON fallbacks.

> Layer boundaries are enforced by `eslint.config.js`. See `docs/README.md` for
> the governance source-of-truth registry.
