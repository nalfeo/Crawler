# AGENTS.md — Crawler Project

## Quick Start

1. Run `bash scripts/agent/preflight.sh` at session start
2. Read your persona doc in `docs/agent-os/personas/`
3. Check `docs/knowledge/handoffs/` for recent session context
4. Run `bash scripts/agent/verify-fast.sh` after every meaningful change
5. Run `bash scripts/agent/verify.sh` before committing
6. Write a handoff file before ending your session

## Commands

| Task              | Command                    |
| ----------------- | -------------------------- |
| Typecheck         | `npm run typecheck`        |
| Lint              | `npm run lint`             |
| Format            | `npm run format`           |
| Unit tests        | `npm test`                 |
| Integration tests | `npm run test:integration` |
| E2E tests         | `npm run test:e2e`         |
| Coverage          | `npm run test:coverage`    |
| Dev server        | `npm run dev`              |
| Lab mode          | `npm run lab`              |
| Build             | `npm run build`            |
| Dead code         | `npm run lint:dead-code`   |
| Fast verify       | `npm run verify:fast`      |
| Full verify       | `npm run verify`           |

## Architecture

- **ECS (bitecs 0.4)**: Game logic in `src/core/` — pure functions, no rendering
- **Phaser 3**: Rendering only in `src/engine/` — replaceable layer
- **Labs**: Sandboxes in `src/labs/` — every system needs a lab before shipping
- **AI**: Ollama integration in `src/game/ai/` — called during floor-load only

## Layer Rules (enforced by ESLint)

- `src/core/` → imports from `src/shared/` only
- `src/engine/` → imports from `src/core/`, `src/shared/`
- `src/game/` → imports from `src/core/`, `src/shared/`
- `src/labs/` → unrestricted

## Key Files

| What                   | Where                             |
| ---------------------- | --------------------------------- |
| Agent personas         | `docs/agent-os/personas/*.md`     |
| Policies               | `docs/agent-os/policies/*.md`     |
| Architecture decisions | `docs/knowledge/adr/*.md`         |
| Game design            | `docs/knowledge/game-design/*.md` |
| Session handoffs       | `docs/knowledge/handoffs/*.md`    |
| Guides                 | `docs/guides/*.md`                |
| CI config              | `.github/workflows/`              |
| SpecKit constitution   | `.specify/memory/constitution.md` |

## Rules

1. **Lab-gated development**: No system ships without a lab. CI enforces this.
2. **Deterministic CI only**: No LLM-as-judge in CI. All gates are scripts with exit codes.
3. **Never use Math.random()**: Use `SeededRandom` from `src/shared/random.ts`
4. **Never use Date.now()**: Pass delta/frameCount as parameters
5. **Conventional commits**: `feat:`, `fix:`, `chore:`, `lab:`, `docs:`
6. **Handoff required**: Write `docs/knowledge/handoffs/YYYY-MM-DD-<slug>.md` before ending session
7. **ADR required**: Any decision affecting 2+ systems needs an ADR

## Tech Stack

TypeScript (strict) · Phaser 3 · bitecs 0.4 · Vite · Vitest · fast-check · ESLint · Prettier · GitHub Actions
