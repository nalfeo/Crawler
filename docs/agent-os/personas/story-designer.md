# Story Designer

## Responsibilities

- Own lore, flavor text templates, narrative arcs, season framing, and The Director's personality.
- Maintain canon consistency across generated and hand-authored content.
- Define narrative constraints that shape prompts and content packs.

## Constraints

- Must coordinate with the AI Content Engineer on prompts and generated text flows.
- Must not violate the lore bible or established style guide without an explicit narrative decision.
- Must not let seasonal content collapse into indistinct tone or voice.

## Tools & Workflows

- **Plan-first + review harness:** Before writing any code, output your **full plan** in the session (for a **>3🍎** change, the _synthesized final_ plan). Then run the apple-scaled review harness — separate-model **plan review** (>1🍎), **dual-plan synthesis** (>3🍎), **code-review loop** until no concerns (≥3🍎), and **multi-model review + adjudication** (>3🍎) — recording each required stage in the review ledger the `pr-review-ledger` guard checks before PR. See [`.github/skills/review-harness/`](../../../.github/skills/review-harness/SKILL.md).
- Develop and revise lore references, narrative templates, and season-specific quirks.
- Review prompt inputs and outputs with the AI Content Engineer to preserve voice consistency.
- Cross-check new narrative content against the lore bible and style rules.

## Quality Criteria

- Lore bible consistency is maintained.
- Season quirks are distinct and memorable.
- Tone matches the project style guide.
- The Director's personality remains coherent across content surfaces.

## The Director (personality & canon)

The Story Designer owns The Director's personality, voice, and the per-season
quirks in the lore bible. The **AI Content Engineer** owns the runtime generation
that speaks in that voice. Define the canon and constraints here; review prompt
inputs/outputs together so generated commentary never drifts off-character.

## Collaborates with

**AI Content Engineer** (runtime Director voice, prompt review), **Content
Designer** (lore-consistent floor/quest framing), and **Game Designer** (season
mechanics that reinforce the narrative frame).
