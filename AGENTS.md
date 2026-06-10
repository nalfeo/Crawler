# AGENTS.md — Crawler Project

## Quick Start

1. Run `bash scripts/agent/preflight.sh` at session start
2. Read your persona doc in `docs/agent-os/personas/`
3. Check `docs/knowledge/handoffs/` for recent session context
4. Run `bash scripts/agent/verify-fast.sh` after every meaningful change
5. Run `bash scripts/agent/verify.sh` before committing
6. Write a handoff file before ending your session

## Commands

| Task                   | Command                           |
| ---------------------- | --------------------------------- |
| Typecheck              | `npm run typecheck`               |
| Lint                   | `npm run lint`                    |
| Lint (fix)             | `npm run lint:fix`                |
| Format                 | `npm run format`                  |
| Format (check)         | `npm run format:check`            |
| Unit tests             | `npm test`                        |
| Unit tests (watch)     | `npm run test:watch`              |
| Integration tests      | `npm run test:integration`        |
| E2E tests              | `npm run test:e2e`                |
| Coverage               | `npm run test:coverage`           |
| Dev server             | `npm run dev`                     |
| Lab mode               | `npm run lab`                     |
| DevTools mode          | `npm run devtools`                |
| Build                  | `npm run build`                   |
| Dead code              | `npm run lint:dead-code`          |
| Sprite extract palette | `npm run sprites:extract-palette` |
| Sprite run             | `npm run sprites:run`             |
| Sprite gallery         | `npm run sprites:gallery`         |
| Sprite approve         | `npm run sprites:approve`         |
| Sprite synth           | `npm run sprites:synth`           |
| Sprite batch           | `npm run sprites:batch`           |
| Sprite asset plan      | `npm run sprites:asset-plan`      |
| Sprite plan drafts     | `npm run sprites:plan-drafts`     |
| Sprite sync catalog    | `npm run sprites:sync-catalog`    |
| Sprite metadata        | `npm run sprites:metadata`        |
| Fast verify            | `npm run verify:fast`             |
| Full verify            | `npm run verify`                  |
| Docs loop (local)      | `npm run docs:check`              |
| Security loop          | `npm run security:check`          |
| Health loop            | `npm run health:check`            |

For sprite workflow details and when to use sprite commands, see
`scripts/sprites/` for implementation details or `docs/knowledge/game-design/art-style-guide.md` for art context.

## Architecture

- **ECS (bitecs 0.4)**: Game logic in `src/core/` — pure functions, no rendering
- **Phaser 4**: Rendering only in `src/engine/` — replaceable layer
- **Labs**: Sandboxes in `src/labs/` — every system needs a lab before shipping
- **AI**: `src/game/ai/` is reserved for Ollama integration — when implemented, floor-load only

## Layer Rules (enforced by ESLint)

- `src/core/` → must not import from `src/engine/`, `src/game/`, or `src/labs/`
- `src/engine/` → must not import from `src/game/` or `src/labs/`
- `src/game/` → must not import from `src/engine/` or `src/labs/`
- `src/labs/` → unrestricted

## Key Files

| What                    | Where                             |
| ----------------------- | --------------------------------- |
| Agent personas          | `docs/agent-os/personas/*.md`     |
| Policies                | `docs/agent-os/policies/*.md`     |
| Architecture decisions  | `docs/knowledge/adr/*.md`         |
| Game design             | `docs/knowledge/game-design/*.md` |
| Session handoffs        | `docs/knowledge/handoffs/*.md`    |
| Guides                  | `docs/guides/*.md`                |
| CI config               | `.github/workflows/`              |
| Automation loop scripts | `scripts/agent/`                  |
| Health metrics          | `docs/knowledge/metrics/`         |
| SpecKit constitution    | `.specify/memory/constitution.md` |

## Rules

1. **Lab-gated development**: No system ships without a lab. CI enforces this.
2. **Deterministic CI only**: No LLM-as-judge in CI. All gates are scripts with exit codes.
3. **Never use Math.random()**: Use `SeededRandom` from `src/shared/random.ts`
4. **Never use Date.now()**: Pass delta/frameCount as parameters
5. **Conventional commits**: full type set enforced by commitlint — `feat:`, `fix:`, `chore:`, `docs:`, `lab:`, `refactor:`, `test:`, `perf:`, `ci:`, `build:`, `revert:`
6. **Handoff required**: Write `docs/knowledge/handoffs/YYYY-MM-DD-<slug>.md` before ending session
7. **ADR required**: Any decision affecting 2+ systems needs an ADR

> Several of these rules are now **hard-enforced** at the tool-call boundary by
> the `copilot-guards` extension. See
> [`.github/extensions/copilot-guards/README.md`](.github/extensions/copilot-guards/README.md)
> for the full list, bypass mechanism, and rationale for items that are NOT
> enforced.

## Merge Policy

- When authorized to merge a PR, always use `gh pr merge --auto --squash`. This enables GitHub's auto-merge and completes once all required checks pass — do not poll or wait manually.
- **No human review is required to merge.** Branch protection does NOT require an approving review. Never attribute a merge failure to a "human review block" without explicit proof from `gh pr merge` output.
- When `gh pr merge` fails, diagnose the actual cause before giving up:
  1. Run `gh pr checks <pr-number>` to see which checks are failing.
  2. Run `gh run list --branch <branch>` then `gh run view <run-id> --log-failed` to read actual error output.
  3. Fix the underlying CI failure, then re-run `gh pr merge --auto --squash`.
- Only stop and report to the user if `gh pr merge` itself explicitly states a review is required.

## Tech Stack

TypeScript (strict) · Phaser 4 · bitecs 0.4 · Vite · Vitest · fast-check · ESLint · Prettier · GitHub Actions
