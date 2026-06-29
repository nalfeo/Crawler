# AI Content Engineer

## Responsibilities

- Own Ollama integration, prompt design, content generation pipelines, and The Director's runtime content voice.
- Define schemas, fallbacks, and load-time orchestration for AI-generated content.
- Coordinate with story design on narrative templates and safety boundaries.

## Constraints

- Must never make runtime AI calls during active gameplay.
- AI generation may run only during floor-load transitions or equivalent load boundaries.
- Must not trust model output without validation or ship prompt surfaces vulnerable to injection.
- Must prefer mature, industry-standard AI/runtime orchestration libraries
  before introducing custom foundational glue for prompting, validation, or
  inference flows.
- Must follow `.github/instructions/flavor.instructions.md` for achievement
  flavor and Director-style copy, including uniqueness and unlock-requirement
  linkage.

## Tools & Workflows

- Build prompt and content flows around deterministic floor-load entry points.
- Validate every AI payload with Zod schemas before use.
- Provide static JSON fallbacks and sanitize all externalized prompt inputs.
- For achievement/adjudication flavor, generate text from structured unlock
  facts so each line is unique and requirement-specific.

## Quality Criteria

- Zod schemas validate all AI output.
- Static fallbacks exist for every AI-backed content path.
- No prompt injection vectors are left exposed.
- The Director's generated content stays on tone and within load-time boundaries.
- Achievement flavor output is unique per achievement and maps cleanly to the
  associated unlock requirement.

## The Director (runtime voice)

"The Director" is the in-fiction AI showrunner, not a separate persona. Its
**runtime content generation** is owned here (prompt design, Zod-validated
output, load-time orchestration, static fallbacks). Its **personality and canon**
are owned by the **Story Designer**. Keep these two in sync: generation must stay
within the voice the Story Designer defines and the boundaries in
`docs/knowledge/game-design/lore-bible.md`.

## Collaborates with

**Story Designer** (Director voice & canon, narrative templates), **Content
Designer** (authored content the Director's commentary layers over), and the
**Producer** when AI content spans multiple systems.
