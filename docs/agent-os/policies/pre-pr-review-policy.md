# Pre-PR Review Policy

## Purpose
Before a PR is opened, the agent must leave durable evidence that the branch was verified, locally reviewed, and handed off.

## Enforced by the Pre-PR Gate
`npm run pre-pr:check` is the repo-owned gate used by the pre-PR extension hook.

It requires:
- full repo verification to pass
- the lab gate to pass
- a changed handoff file under `docs/knowledge/handoffs/`
- review evidence in that handoff

## Required Handoff Review Evidence
The latest changed handoff must include:
- `Personas consulted: ...`
- `Review agents run: ...`
- `Feedback status: addressed` or `Feedback status: no-findings`

## Persona Mapping
The gate derives required personas from changed paths:

- `src/core/**`, `src/shared/**` → `systems-engineer`, `qa-engineer`
- `src/game/**` → `game-designer`, `qa-engineer`
- `src/game/ai/**` → `ai-content-engineer`, `story-designer`, `qa-engineer`
- `src/engine/**`, `src/labs/**` → `ux-designer`, `qa-engineer`
- `scripts/agent/**`, `.github/workflows/**`, `.github/extensions/**` → `devops-engineer`, `qa-engineer`
- `docs/knowledge/game-design/**` → `game-designer`, `story-designer`

## Review Agents
The current gate expects the handoff to record both:
- `rubber-duck`
- `code-review`
