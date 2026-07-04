---
title: Systems Map
type: note
permalink: systems-map
tags: [systems, gameplay]
---

# Systems Map

High-level inventory of the game's major systems and where they live. Game
systems live in `src/game` and each must have a corresponding lab in `src/labs`.

## Observations

- [system] Combat — damage, health, knockback; weapons MELEE(0), RANGED(1), MAGIC(3), THROWN(4), BEAM(5), TRAP(6) from src/shared/constants.ts #combat
- [system] Crafting — the game's central pillar; crafting-focused vampire-survivors loop #crafting
- [system] Drops and Loot — loot drops and pickups; architecture in ADR 0006 #loot
- [system] AI (deterministic runtime) — behavior-tree kernels, headless-runner CLI, family-aware target selection, and win-rate sweeps live in src/game/ai and src/game/systems; runs every frame and per sweep, always through world.rng #ai
- [system] AI (LLM/Director content) — future load-time-only Ollama layer; when implemented, floor-load transitions only, static JSON fallbacks, Zod validation #ai
- [system] Floors — Floor 1 is a hand-authored dungeon with a headless victory gate; Floor 2 is the systemic cave floor (families, resource heart, dynamic win) — partially implemented, main-scene bootstrap still Floor 1 #floors
- [system] Floor 2 family systems — factionRelations (0–100 bands), FamilyMembership, family-aware AI + feuding, sealed boss dens, dynamic win evaluator, settlement + seeded shops, HUD family relationships widget, minimap territory tint; ADR 0040, spec floor2-family-territories.md #floor2
- [system] Achievements — src/game/systems/achievementSystem.ts + src/core/systems/achievementRewards.ts + src/shared/achievements.ts #achievements
- [system] Status Effects — src/core/systems/statusEffectSystem.ts #status-effects
- [system] Harvest and Props — src/core/systems/harvestSystem.ts + src/shared/harvestableDefs.ts + src/game/systems/propPlacer.ts #harvest
- [system] Spawner — src/game/spawners/spawnerSystem.ts; ADR 0025 (spawner) + ADR 0034/0036/0039 (orphaned-system wiring guard) #spawner
- [system] Sprite pipeline — multi-stage generation and judging under scripts/sprites; commands npm run sprites:\*; Azure sidecar (npm run sprites:gallery) for GPU generation #sprites
- [timing] Fixed timestep at 60 FPS; GAME.DELTA_MS = 1000/60 #loop

## Relations

- part_of [[Crawler Project Overview]]
- organized_by [[Architecture and Layers]]
- constrained_by [[Conventions and Invariants]]
