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
- [system] AI — enemy behavior trees with pure deterministic kernels in src/game/ai; reserved for future Ollama (floor-load only) #ai
- [system] Floors — procedural floor generation, rooms, doors, special-room sealing; Floor 1 has a headless victory gate #floors
- [system] Sprite pipeline — multi-stage generation and judging under scripts/sprites; commands npm run sprites:\* #sprites
- [timing] Fixed timestep at 60 FPS; GAME.DELTA_MS = 1000/60 #loop

## Relations

- part_of [[Crawler Project Overview]]
- organized_by [[Architecture and Layers]]
- constrained_by [[Conventions and Invariants]]
