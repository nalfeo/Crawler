# Agent Personas — Index & Routing

Crawler is agent-driven. Every session adopts a **persona** — a scoped role with
its own responsibilities, constraints, and quality bar. This file is the
**routing matrix**: it tells you which persona to adopt for the work in front of
you. Read it _before_ you start, then read the persona doc you select.

> **How to use this:** Match your task to a row in the routing table below.
> When a task touches multiple layers or is ambiguous, default to **Producer**
> (the orchestrator) — it decomposes the work and hands slices to specialists.

## Personas vs. agents

These are two layers of the same system, and the distinction matters:

| Layer                        | What it is                                                                  | Where it lives            |
| ---------------------------- | --------------------------------------------------------------------------- | ------------------------- |
| **Persona** (this directory) | The **doctrine** — what a role owns, refuses, and is measured by            | `docs/agent-os/personas/` |
| **Agent** (`.agent.md`)      | The **invocable entry point** — selectable in the agent picker, runs a loop | `.github/agents/`         |
| **Skill** (`SKILL.md`)       | A **reusable procedure** an agent or persona invokes by name                | `.github/skills/`         |

Every persona in the index below names a **canonical agent** (the first agent in
its `## Agent` section), no two personas claim the same canonical agent, and
every agent links back to a persona doc that exists. `npm run docs:check`
(`scripts/agent/docs/check-personas.ts`) enforces all of that deterministically —
plus that every agent has a non-empty frontmatter `description` and that no agent
is orphaned — so the two layers cannot silently drift apart.

A persona's `## Agent` section may name additional agents after the canonical
one; those are **specialist siblings** that inherit its doctrine and narrow it to
one workflow (for example `perf-optimizer` under Systems Engineer,
`velocity-engineer` under DevOps Engineer). They are listed in the Agent Index at
the bottom.

## Standing rules for every persona

These apply to **all** personas. They are stated once here so a policy change
does not have to be copy-edited into thirteen files; individual persona docs
link back to this section instead of restating it.

- **Plan-first.** Before writing any code, output your **full plan** in the
  session — the complete, ordered implementation plan, not a one-line summary.
  Plans go in the session response and, for cloud/coding-agent sessions, the
  progress summary and PR description — never a posted issue/PR comment, since
  cloud sessions have no comment credentials. Never block a session waiting for
  comment access. Do not hide plans in repo files unless the
  human explicitly asks for a file artifact.
- **Declare an apple estimate** (🍎–🍎🍎🍎🍎🍎) before any code, and score the
  actual at handoff. See [`docs/agent-os/policies/complexity-policy.md`](../policies/complexity-policy.md).
- **Run the apple-scaled review harness** and record a **review ledger**: a
  separate-model **plan review** at ≥3🍎 (**adversarial** at >3🍎 — enumerate ≥2
  alternatives and argue against the chosen design, recording `plan_divergence`),
  a **code-review loop** until no concerns _or_ a 2-round cap then human
  escalation at ≥3🍎, and **multi-model review + adjudication** at >3🍎. The
  `pr-review-ledger` guard hard-denies `create_pull_request` without a valid
  ledger for a code-touching change. See the
  [review-harness skill](../../../.github/skills/review-harness/SKILL.md) and
  [`docs/agent-os/policies/review-harness-policy.md`](../policies/review-harness-policy.md).
- **Observe before done.** For any visual or runtime change, reading the diff is
  not verification. Reproduce the old behavior in a **real** artifact
  (`npm run dev`, a headless probe, or a pipeline `RunStats`), then re-observe
  after the change, and state the before/after in the PR/handoff. A green lab is
  never sufficient on its own for a wiring or behavior change (AGENTS.md r9/r14).
- **Never weaken a requirement or a gate to go green.** If green appears to
  require relaxing a stated requirement, loosening a sensor, or cherry-picking
  seeds, STOP and ask the human (AGENTS.md r11/r12).
- **Build-vs-buy.** For fundamental systems, evaluate off-the-shelf,
  industry-standard libraries first. If custom is chosen, record the fit-gap
  rationale (determinism, performance, licensing, integration, maintenance).
- **Broad sweeps (>10 runs) run on GitHub infrastructure** by default via
  `workflow_dispatch`, not local compute (AGENTS.md r15).

## Routing Matrix

| If your task is mostly…                                                             | Adopt persona         | Agent                | Primary paths                                                    |
| ----------------------------------------------------------------------------------- | --------------------- | -------------------- | ---------------------------------------------------------------- |
| Multi-layer, cross-cutting, ambiguous, or needs coordination/sequencing             | **Producer**          | `producer`           | _(orchestrates; spans all paths)_                                |
| Core ECS: components, systems, queries, performance, determinism                    | **Systems Engineer**  | `systems-engineer`   | `src/core/**`                                                    |
| Game mechanics: combat, economy, progression pacing, tuning, balance labs           | **Game Designer**     | `game-designer`      | `src/game/**`, `src/labs/**`, `src/shared/data/tuning.json`      |
| Enemy behavior, pathfinding, target selection, headless runner, AI sweeps           | **Game AI Engineer**  | `game-ai-engineer`   | `src/game/ai/**`                                                 |
| Floor content, quests, encounters, set pieces, lore, flavor text, Director voice    | **Content Designer**  | `content-designer`   | `src/shared/data/quests.*.json`, lore bible, narrative templates |
| Sprites, tilesets, VFX, palettes, sprite briefs & approval, art wiring              | **Graphics Designer** | `asset-forge`        | `briefs/**`, `data/palettes/**`, `src/engine/sprites/**`         |
| Set-piece interiors: room layout, prop dressing, furniture scale/fit                | **Set Designer**      | `set-piece-designer` | `src/shared/data/set-pieces.json`, `scripts/agent/set-piece/**`  |
| HUD, menus, onboarding, controls, interaction polish, accessibility, audio feedback | **UX Designer**       | `ux-designer`        | `src/engine/Hud*.ts`, controls config, `src/engine/audio/**`     |
| Tests, coverage, property/invariant tests, regression, mutation                     | **QA Engineer**       | `qa-engineer`        | `tests/**`                                                       |
| CI, verify scripts, harness, tooling, deployment, gates, agent velocity             | **DevOps Engineer**   | `devops-engineer`    | `.github/workflows/**`, `scripts/agent/**`                       |
| Balance validation, difficulty curve, pacing & fun-factor across seeds              | **Playtester**        | `playtester`         | `docs/knowledge/game-design/**` (findings), sweep dispatch       |
| Reviewing a PR / diff for correctness, security, policy compliance                  | **Reviewer**          | `reviewer`           | _(reads diffs; complements automated gates)_                     |

When two rows could apply, prefer the **more specific** persona for the layer you
are actually editing, and consult adjacent personas via their "Collaborates with"
lines. If you still can't tell, that ambiguity is itself the signal to adopt
**Producer** and split the work.

This table is **not** the machine-readable source of truth. That is
[`routing.json`](routing.json), which maps each persona to its canonical agent
and to the system keywords `scripts/agent/producer.ts` uses when it decomposes a
request into slices. Edit `routing.json` first; `npm run docs:check` then reports
every row here, every persona doc, and every agent file that still disagrees.

## Boundary Quick-Reference

These roles overlap and are easy to confuse:

- **Game Designer** owns _mechanics & tuning_ — how a system behaves and its
  numbers (damage, XP curve, shop costs, danger scaling).
- **Content Designer** owns _authored content and its voice_ — the data that
  composes systems into a specific floor experience (themes, gimmicks, set
  pieces, quest objectives, safe-room beats, boss framing) **and** the lore,
  flavor text, and The Director's personality that decorate it.
- **Systems Engineer** owns the _ECS plumbing_ those packs and mechanics run on.
- **Game AI Engineer** owns _how enemies decide and move_ — deterministic
  behavior trees, pathfinding, target selection, and the headless AI runner.
  This is engineering, not content: **no LLM ever runs in this path.**
- **Playtester** owns _evidence about balance_, not balance itself; it measures
  and reports, and Game Designer changes the numbers.

## Worked Routing Examples

When two rows feel plausible, these decisions resolve the most common ties:

- **"Make floor danger scale faster after the boss."** → **Game Designer.** This
  is a _number/curve_ (mechanics & tuning), not authored floor data. If it also
  needed a new authored encounter to showcase it, that slice goes to **Content
  Designer** and the whole thing is **Producer**-orchestrated.
- **"Add a goblin-warren quest pack to Floor 2."** → **Content Designer.** It
  composes existing mechanics into authored data; no new mechanic or ECS change.
  It only becomes **Systems Engineer** if it needs a new component/query to run.
- **"Enemies should path around walls."** → **Game AI Engineer.** Pathfinding and
  target selection live in `src/game/ai/`. The _tuning_ of how aggressively they
  path is **Game Designer**; the ECS primitives underneath are **Systems Engineer**.
- **"The Director should taunt the player on death."** → **Content Designer** —
  it owns both the voice and the authored lines. Escalate to **Producer** if it
  needs new runtime plumbing to deliver them.
- **"Fix the flaky sprite-pipeline test."** → **QA Engineer** (test
  effectiveness), escalating to **DevOps Engineer** if the flake is a
  harness/CI-timeout problem rather than a test logic problem.
- **"Is the bow underpowered on Floor 1?"** → **Playtester.** It dispatches the
  sweep and reports the win-rate evidence; it does not change the numbers.

## Conceptual Agents (harness, not personas)

Some named "agents" in this project are **harness components**, not personas you
adopt:

- **The Director** — the in-fiction AI showrunner. Its personality, canon, and
  authored lines are owned by the **Content Designer** persona. Runtime LLM
  generation of Director dialogue is **not currently implemented** anywhere in
  the codebase; if it is ever built it is load-time-only, Zod-validated, with
  static fallbacks (constitution Principle 6).
- **The Governor** — the deterministic headless player used for smoke and
  balance-regression checks (`scripts/agent/health/governor-playthroughs.ts`).
  Owned by the **QA Engineer** persona; it is a script, never an LLM.

## Persona Index

| Persona           | File                   | Agent                                                                       |
| ----------------- | ---------------------- | --------------------------------------------------------------------------- |
| Producer          | `producer.md`          | [`producer`](../../../.github/agents/producer.agent.md)                     |
| Systems Engineer  | `systems-engineer.md`  | [`systems-engineer`](../../../.github/agents/systems-engineer.agent.md)     |
| Game Designer     | `game-designer.md`     | [`game-designer`](../../../.github/agents/game-designer.agent.md)           |
| Game AI Engineer  | `game-ai-engineer.md`  | [`game-ai-engineer`](../../../.github/agents/game-ai-engineer.agent.md)     |
| Content Designer  | `content-designer.md`  | [`content-designer`](../../../.github/agents/content-designer.agent.md)     |
| Graphics Designer | `graphics-designer.md` | [`asset-forge`](../../../.github/agents/asset-forge.agent.md)               |
| Set Designer      | `set-designer.md`      | [`set-piece-designer`](../../../.github/agents/set-piece-designer.agent.md) |
| UX Designer       | `ux-designer.md`       | [`ux-designer`](../../../.github/agents/ux-designer.agent.md)               |
| QA Engineer       | `qa-engineer.md`       | [`qa-engineer`](../../../.github/agents/qa-engineer.agent.md)               |
| DevOps Engineer   | `devops-engineer.md`   | [`devops-engineer`](../../../.github/agents/devops-engineer.agent.md)       |
| Playtester        | `playtester.md`        | [`playtester`](../../../.github/agents/playtester.agent.md)                 |
| Reviewer          | `reviewer.md`          | [`reviewer`](../../../.github/agents/reviewer.agent.md)                     |

## Agent Index

Every persona above has an agent. These additional agents are **specialist
siblings** — they narrow a persona's doctrine to one repeatable workflow and are
selected directly rather than by routing:

| Agent                                                                             | Inherits from     | Use when                                            |
| --------------------------------------------------------------------------------- | ----------------- | --------------------------------------------------- |
| [`perf-optimizer`](../../../.github/agents/perf-optimizer.agent.md)               | Systems Engineer  | Gameplay-neutral speed/memory work only             |
| [`velocity-engineer`](../../../.github/agents/velocity-engineer.agent.md)         | DevOps Engineer   | Measuring and removing agent-delivery bottlenecks   |
| [`pr-shepherd`](../../../.github/agents/pr-shepherd.agent.md)                     | DevOps Engineer   | Driving open PRs to a clean squash-merge            |
| [`docs-update`](../../../.github/agents/docs-update.agent.md)                     | DevOps Engineer   | Extracting and validating provenance-backed lore    |
| [`ci-review-validator`](../../../.github/agents/ci-review-validator.agent.md)     | Reviewer          | Validating exact review threads with a second model |
| [`equipment-theme-forge`](../../../.github/agents/equipment-theme-forge.agent.md) | Graphics Designer | Building a full themed equipment collection         |

## Retired personas

Removed on 2026-07-27 after a usage and implementation audit. History is in git;
recreate one only when its domain has real, scheduled work.

- **AI Content Engineer** — its declared core (Ollama runtime generation) had
  **zero implementation** anywhere in the repo, while its routing path
  `src/game/ai/**` actually contained the deterministic AI that must never use an
  LLM. Replaced by **Game AI Engineer**; the unimplemented Director-generation
  doctrine moved to the constitution and the Reviewer's AI-safety checklist.

  **Ownership if load-time generation is ever built** (constitution Principle 6 —
  LLM content may run only during floor-load transitions, never per-frame):
  **Content Designer** owns the authored schema, fallback content, and voice;
  **Systems Engineer** owns the load-time orchestration seam and determinism of
  everything downstream of it; **DevOps Engineer** owns the model runtime and its
  CI/offline story; **Reviewer** enforces that nothing leaks into the frame loop.
  Do not recreate this persona unless that work is actually scheduled.

- **Sound Designer** — 3 source files, 1 commit in 90 days, no audio pipeline,
  skill, or gate. Its constraints (no runaway voice counts, audio failure must
  never break gameplay) moved into **UX Designer**.
- **Story Designer** — merged into **Content Designer**. The
  "authored structure vs. authored voice" split starved both roles and required
  a whole section of this file to explain.
