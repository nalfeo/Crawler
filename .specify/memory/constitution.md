# Crawler — Project Constitution

## Identity

Crawler is a crafting-focused vampire-survivors-like set inside a brutal intergalactic reality show dungeon. Built with Phaser 3 + bitecs ECS + TypeScript.

## Governing Principles

### 1. Agent = Model + Harness

The model provides reasoning. The harness is everything else: tools, memory, sandbox, context, gates, sensors, loops, policies. LLMs are for creative pursuits only. All enforcement is deterministic.

### 2. Lab-Gated Development

No ECS system ships to production without a corresponding lab sandbox. Labs live in `src/labs/<system>-lab/`. This is enforced by CI, not by instructions alone.

### 3. Deterministic CI Only

No LLM-as-judge in CI. All gates are deterministic scripts with exit codes. The CI pipeline is ordered by speed — fast gates run first, fail fast.

### 4. Deterministic Game Logic

All game randomness uses `SeededRandom` — never `Math.random()`. All time uses delta/frameCount — never `Date.now()`. Same seed must produce identical game sequences.

### 5. ECS-Phaser Bridge Pattern

Game logic lives entirely in bitecs systems (pure functions). Phaser is a replaceable rendering layer. `src/core/` never imports from `src/engine/`.

### 6. AI Content During Load Only

Ollama (The Director) generates content during floor-load transitions. Never mid-gameplay. Always provide static JSON fallbacks. Validate with Zod schemas.

### 7. Memory Governance

- Mandatory handoff files at session end
- ADR required for decisions affecting 2+ systems
- Promotion to Tier 1 (hot memory) requires evidence of 3+ sessions needing the knowledge
- Nothing is deleted — only archived

### 8. Conventional Commits

Use prefixes: `feat:`, `fix:`, `chore:`, `lab:`, `docs:`. CI enforces commit format.

### 9. Coverage Requirements

- `src/core/` and `src/game/`: 90% line coverage minimum
- `src/shared/`: 90% minimum
- `src/engine/`: 50% minimum
- `src/labs/`: 30% minimum
- Overall: 80% minimum

### 10. Hashimoto's Loop

Every agent failure becomes a permanent fix: observe → classify → decide fix type → implement → add regression test → audit. Never "fix the prompt" — encode rules as sensors.

## Architectural Boundaries

- `src/core/` → `src/shared/`, `bitecs` only
- `src/engine/` → `src/core/`, `src/shared/`
- `src/game/` → `src/core/`, `src/shared/`
- `src/labs/` → unrestricted

## Non-Negotiable

- No `Math.random()` anywhere in game code
- No `eval()` or `Function()` constructors
- No secrets in source code
- No LLM calls in CI pipeline
- No Phaser imports in `src/core/`
