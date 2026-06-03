# ADR 0001: ECS Architecture with bitecs

## Status
Accepted

## Date
2024-12-01

## Context
We need an architecture for game logic that:
1. Supports 500-1000+ entities on screen (bullet-hell density)
2. Keeps game logic portable (future Steam/mobile/Godot targets)
3. Is highly testable without rendering infrastructure
4. Works well with TypeScript

## Decision
Use bitecs 0.4 for Entity Component System (ECS) architecture with a Phaser bridge pattern:
- **Game logic** lives in `src/core/` as bitecs systems (pure functions)
- **Rendering** lives in `src/engine/` — Phaser reads ECS state, no reverse dependency
- **Components** are plain objects (bitecs 0.4 API)
- **Systems** are pure functions: `(world: GameWorld) => void`

## Consequences
### Positive
- All game logic testable without Phaser (headless testing)
- Portable: swap Phaser for any renderer without touching game logic
- High performance: bitecs stores components as typed arrays
- Natural fit for deterministic gameplay (pure function systems)

### Negative
- Learning curve for ECS paradigm
- Bridging ECS state to Phaser GameObjects adds complexity
- bitecs 0.4 has limited TypeScript documentation
- Component data access patterns differ from OOP game dev

### Risks
- bitecs 0.4 is relatively new; API may evolve
- Phaser bridge performance needs profiling at scale

## Alternatives Considered
- **miniplex**: Better TypeScript DX, but slower for dense entity counts
- **Roll-your-own ECS**: Full control but significant upfront investment
- **Phaser-native (no ECS)**: Simpler start but poor testability and portability
