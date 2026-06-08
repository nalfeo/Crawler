# `src/game/ai`

Reserved location for AI/LLM integration (Ollama, etc.). Per ADR-002 and the
agent-os policies, AI calls are **floor-load only** — no per-frame LLM work.

This directory is intentionally near-empty today; it exists so that AGENTS.md
and `.github/instructions/game.instructions.md` references resolve cleanly and
so contributors know where to add the first AI module.

When adding code here:

- Keep imports limited to `src/core/` and `src/shared/` (see ESLint layer
  rules).
- All prompts must pass the static scan in
  `scripts/agent/security/check-ai-prompts.ts` — sanitize interpolated values
  or use parameterized prompt templates.
- All randomness still goes through `SeededRandom` from `src/shared/random.ts`.
