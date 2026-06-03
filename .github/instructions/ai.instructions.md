---
applyTo: 'src/game/ai/**'
---

# AI Content Layer Instructions

Ollama integration for The Director's voice and dynamic content generation.

## Rules

- Ollama calls happen ONLY during floor-load transitions, NEVER mid-gameplay
- Every AI-generated content type has a Zod schema for validation
- Every prompt template has a static JSON fallback
- No prompt injection vectors (sanitize all game state before injecting into prompts)
- Cache responses by seed+context hash for determinism in testing
- Content types: floor intros, item descriptions, achievement announcements, death screens, audience chat

## The Director's Voice

The Director is an ancient AI showrunner with 1980s game show host enthusiasm and reality TV producer menace. Each playthrough has a procedurally chosen "season quirk."
