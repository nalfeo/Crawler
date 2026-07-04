---
applyTo: 'src/game/ai/**'
---

# AI Layer Instructions

`src/game/ai/` is a **dual-purpose** directory:

1. **Deterministic runtime AI** — headless simulation runners (`headless-runner-cli.ts`, `simulation-step.ts`), behavior-tree kernels (`behavior-tree.ts`, `exploration.ts`), win-rate sweeps (`ai:hill-climb`, `ai:winrate-sweep`, `ai:weapon-sweep`, `ai:headless`). This code runs every frame or per-sweep, must use seeded randomness (`world.rng`) and delta/frame time, and is validated through the real pipeline plus the headless Floor gate.
2. **Future LLM / Director-generated content** — layered on top; when implemented, runs **only during floor-load transitions**, never mid-gameplay.

## Rules

### For deterministic runtime AI

- All randomness via `world.rng` (SeededRandom). Never `Math.random()`, never `Date.now()`.
- Behavior kernels are pure `(inputs) => decision` functions unit-tested in `tests/unit/` or `tests/ecs/`.
- Any exported `*System` must be wired into a real pipeline site or explicitly allowlisted (`npm run check:wired-systems`).
- Balance/tuning changes must be justified against a seed sweep (win-rate), never a cherry-picked seed.

### For LLM / Director content (when added)

- Calls happen **only** during floor-load transitions, never mid-gameplay.
- Every AI-generated content type has a Zod schema for validation.
- Every prompt template has a static JSON fallback.
- No prompt injection vectors: sanitize game state before injection.
- Cache responses by seed + context hash so tests stay deterministic.
- Planned content types: floor intros, item descriptions, achievement announcements, death screens, audience chat.

## The Director's Voice

The Director is an ancient AI showrunner with 1980s game-show-host enthusiasm and reality-TV-producer menace. Each playthrough has a procedurally chosen "season quirk."

> `src/game/ai/` is also subject to the game-layer rules in
> `.github/instructions/game.instructions.md`. See `docs/README.md` for the
> governance source-of-truth registry.
