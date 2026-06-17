# Agent Personas — Index & Routing

Crawler is agent-driven. Every session adopts a **persona** — a scoped role with
its own responsibilities, constraints, and quality bar. This file is the
**routing matrix**: it tells you which persona to adopt for the work in front of
you. Read it _before_ you start, then read the persona doc you select.

> **How to use this:** Match your task to a row in the routing table below.
> When a task touches multiple layers or is ambiguous, default to **Producer**
> (the orchestrator) — it decomposes the work and hands slices to specialists.

## Routing Matrix

| If your task is mostly…                                                   | Adopt persona           | Primary paths                                                      |
| ------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------ |
| Multi-layer, cross-cutting, ambiguous, or needs coordination/sequencing   | **Producer**            | _(orchestrates; spans all paths)_                                  |
| Core ECS: components, systems, queries, performance, determinism          | **Systems Engineer**    | `src/core/**`                                                      |
| Game mechanics: combat, economy, progression pacing, tuning, balance labs | **Game Designer**       | `src/game/**`, `src/labs/**`, `src/shared/data/tuning.json`        |
| Floor content: themes, gimmicks, set pieces, quests, encounters, bosses   | **Content Designer**    | `src/shared/data/quests.*.json`, floor scenarios, objective tuning |
| Sprites, tilesets, VFX, palettes, sprite briefs & approval                | **Graphics Designer**   | `briefs/**`, `data/palettes/**`, `src/engine/sprites/**`           |
| HUD, menus, onboarding, controls, interaction polish, accessibility       | **UX Designer**         | `src/engine/**` (HUD/menus), controls config                       |
| Tests, coverage, property/invariant tests, regression, mutation           | **QA Engineer**         | `tests/**`                                                         |
| CI, verify scripts, harness, tooling, deployment, gates                   | **DevOps Engineer**     | `.github/workflows/**`, `scripts/agent/**`                         |
| Lore, flavor text, season framing, The Director's personality             | **Story Designer**      | `docs/knowledge/game-design/lore-bible.md`, narrative templates    |
| Ollama integration, prompt design, runtime content generation/validation  | **AI Content Engineer** | `src/game/ai/**`, prompt + schema flows                            |
| SFX, music, audio implementation, mix/pooling                             | **Sound Designer**      | audio systems & assets                                             |
| Balance validation, difficulty curve, pacing & fun-factor across seeds    | **Playtester**          | `docs/knowledge/game-design/**` (findings)                         |
| Reviewing a PR / diff for correctness, security, policy compliance        | **Reviewer**            | _(reads diffs; complements automated gates)_                       |

When two rows could apply, prefer the **more specific** persona for the layer you
are actually editing, and consult adjacent personas via their "Collaborates with"
lines. If you still can't tell, that ambiguity is itself the signal to adopt
**Producer** and split the work.

## Boundary Quick-Reference

These three roles overlap on "content" and are easy to confuse:

- **Game Designer** owns _mechanics & tuning_ — how a system behaves and its
  numbers (damage, XP curve, shop costs, danger scaling).
- **Content Designer** owns _authored floor/quest/encounter packs_ — the
  data that composes systems into a specific floor experience (themes,
  gimmicks, set pieces, quest objectives, safe-room beats, boss framing).
- **Systems Engineer** owns the _ECS plumbing_ those packs and mechanics run on.
- **Story Designer** owns _lore & voice_; **AI Content Engineer** owns
  _runtime generation_ of text. Content Designer authors the _static structure_
  they decorate.

## Conceptual Agents (harness, not personas)

Some named "agents" in this project are **harness components**, not personas you
adopt:

- **The Director** — the in-fiction AI showrunner whose runtime voice is
  produced by the **AI Content Engineer** persona (generation) and shaped by the
  **Story Designer** persona (personality/canon). See those docs.
- **The Governor** — the deterministic headless player used for smoke and
  balance-regression checks (`scripts/agent/health/governor-playthroughs.ts`).
  Owned by the **QA Engineer** persona; it is a script, never an LLM.

## Persona Index

| Persona             | File                     |
| ------------------- | ------------------------ |
| Producer            | `producer.md`            |
| Game Designer       | `game-designer.md`       |
| Content Designer    | `content-designer.md`    |
| Systems Engineer    | `systems-engineer.md`    |
| Graphics Designer   | `graphics-designer.md`   |
| UX Designer         | `ux-designer.md`         |
| QA Engineer         | `qa-engineer.md`         |
| DevOps Engineer     | `devops-engineer.md`     |
| Story Designer      | `story-designer.md`      |
| AI Content Engineer | `ai-content-engineer.md` |
| Sound Designer      | `sound-designer.md`      |
| Playtester          | `playtester.md`          |
| Reviewer            | `reviewer.md`            |
