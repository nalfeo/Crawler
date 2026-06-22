# AGENTS.md — Crawler Project

## Quick Start

1. Run `bash scripts/agent/preflight.sh` at session start
2. Select your persona from the routing matrix in `docs/agent-os/personas/README.md` (default to **Producer** for multi-layer or ambiguous tasks), then read that persona doc
3. Check `docs/knowledge/handoffs/` for recent session context
4. Run `bash scripts/agent/verify-fast.sh` after every meaningful change
5. Run `bash scripts/agent/verify.sh` before committing
6. Write a handoff file before ending your session
7. **Unlock the session lock** — run the `gh workflow run` unlock command from the [Session Lock](#session-lock) section

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

## Server Launch Diagnostics

When diagnosing Crawler dev/lab/devtools launch failures, inspect these session artifacts before retrying commands:

1. `files/worktree-server-launch.log` — append-only JSONL launch/discovery events and errors.
2. `files/worktree-server-status.json` — latest structured discovery snapshot used by the Worktree Server canvas.

## Session Server Lifecycle Policy

When working in a Copilot worktree session, keep **at most one active dev/lab/devtools server per session** unless there is an explicit reason to run more.

1. **Reuse first (hot reload path):** if the session already has a healthy server that serves the route you need, reuse it instead of launching another.
2. **Replace cleanly when needed:** if you must relaunch (hung process, wrong mode, wrong flags), stop the existing server process tied to the same session/workspace first, then start the new one.
3. **Always print the URL on launch:** every successful launch command must output the URL that should be opened (base URL, or specific route URL if relevant).

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
8. **Always fix test and infra failures**: Never skip, ignore, or document broken tests/lint/build issues as "preexisting" or "unrelated" and move on. Fix every failure you encounter, regardless of whether you caused it. There is no such thing as a pre-existing issue that is out of scope — cruft compounds and wastes future agent time.

> Several of these rules are now **hard-enforced** at the tool-call boundary by
> the `copilot-guards` extension. See
> [`.github/extensions/copilot-guards/README.md`](.github/extensions/copilot-guards/README.md)
> for the full list, bypass mechanism, and rationale for items that are NOT
> enforced.

## Session Lock

Every push to a `copilot/**` branch automatically sets a `copilot/session-active`
commit status to **pending**, which blocks merging when branch protection is
configured (see `.github/workflows/copilot-session-guard.yml` for setup
instructions).

**At the end of every session**, after writing your handoff, unlock the branch:

```bash
gh workflow run .github/workflows/copilot-session-guard.yml \
  --ref main \
  -f sha="$(git rev-parse HEAD)" \
  -f state=success \
  -f description="Session complete"
```

If the session ended with unresolved issues, use `state=failure` instead.
The status stays locked until you explicitly unlock it — mid-session pushes
will re-lock automatically, so you only need to unlock once at the very end.

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
