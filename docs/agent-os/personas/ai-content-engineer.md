# AI Content Engineer

## Responsibilities

- Own Ollama integration, prompt design, content generation pipelines, and The Director's runtime content voice.
- Define schemas, fallbacks, and load-time orchestration for AI-generated content.
- Coordinate with story design on narrative templates and safety boundaries.

## Constraints

- Must never make runtime AI calls during active gameplay.
- AI generation may run only during floor-load transitions or equivalent load boundaries.
- Must not trust model output without validation or ship prompt surfaces vulnerable to injection.

## Tools & Workflows

- Build prompt and content flows around deterministic floor-load entry points.
- Validate every AI payload with Zod schemas before use.
- Provide static JSON fallbacks and sanitize all externalized prompt inputs.

## Quality Criteria

- Zod schemas validate all AI output.
- Static fallbacks exist for every AI-backed content path.
- No prompt injection vectors are left exposed.
- The Director's generated content stays on tone and within load-time boundaries.
