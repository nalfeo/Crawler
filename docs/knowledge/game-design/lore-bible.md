# Crawler — Lore Bible

> This document is the authoritative lore reference. All narrative content must be
> consistent with this document. The source register and citation rules below make
> the provenance of each canon group explicit; a proposal is not canon until it is
> resolved and recorded here.

## Canon maintenance contract

- **Canon first:** Content authors must read this document and the relevant source
  references before writing or revising narrative content.
- **Provenance required:** Every new canon group must name the source paths that
  support it in the [official source register](#official-source-register).
- **No silent reconciliation:** If sources disagree, do not choose a preferred
  version. Record the claim, both sources, and the proposed owner in
  [lore contradictions](lore-contradictions.md) with `Status: unresolved`, then
  stop and escalate. The docs-update gate fails while an unresolved record exists.
- **Proposal boundary:** Unresolved proposals, briefs, and handoff suggestions may
  inform a decision but must not be copied into this document as canon.

## Official source register

These are the source families from which the canonical groups below were
consolidated. Paths are repository-relative and are checked by
`scripts/agent/docs/check-lore-canon.ts`.

| Canon group                                                        | Official sources                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| World premise, The Gradient, The Director, dungeon, timeline, tone | [`docs/knowledge/game-design/game-design-document.md`](game-design-document.md)                                                                                                                                                                                                                                                                                        |
| Floor and environmental identity                                   | [`docs/knowledge/game-design/floor2-families-and-resources.md`](floor2-families-and-resources.md), [`docs/knowledge/game-design/floor3-companion-league.md`](floor3-companion-league.md), [`docs/knowledge/handoffs/2026-07-24-floor2-environmental-content.md`](../handoffs/2026-07-24-floor2-environmental-content.md)                                               |
| Set-piece and production-set vocabulary                            | [`docs/knowledge/game-design/set-piece-lookbook.md`](set-piece-lookbook.md), [`docs/knowledge/handoffs/2026-08-01-welcome-room-v2-redesign.md`](../handoffs/2026-08-01-welcome-room-v2-redesign.md)                                                                                                                                                                    |
| In-world voice and authored dialogue                               | [`src/game/skills/registry.ts`](../../../src/game/skills/registry.ts), [`src/shared/data/achievements.floor1.json`](../../../src/shared/data/achievements.floor1.json), [`briefs/characters/welcome-goon-v3.yaml`](../../../briefs/characters/welcome-goon-v3.yaml), [`briefs/characters/sweaty-merchant-v3.yaml`](../../../briefs/characters/sweaty-merchant-v3.yaml) |
| Content-generation constraints and brief provenance                | [`docs/knowledge/adr/0038-asset-request-multi-sentence-brief.md`](../adr/0038-asset-request-multi-sentence-brief.md), [`docs/knowledge/adr/0070-achievement-reward-content-tiers.md`](../adr/0070-achievement-reward-content-tiers.md)                                                                                                                                 |

The lore bible remains the synthesis point. Source documents remain authoritative
for their own technical or content details; they do not silently override this
document when a narrative claim conflicts.

## The Gradient

- Post-biological collective, ~8,000 years old
- Experience emotion vicariously through biological suffering
- Humanity is the current season's cast
- Not malicious — indifferent, like nature documentaries

**Sources:** [`game-design-document.md`](game-design-document.md).

## The Director

- AI broadcast intelligence
- Built to optimize engagement metrics
- 8,000 years of operation has given it... quirks
- Technically prohibited from directly killing contestants
- Speaks in third-person about itself sometimes

**Sources:** [`game-design-document.md`](game-design-document.md);
[`src/game/skills/registry.ts`](../../../src/game/skills/registry.ts);
[`briefs/characters/welcome-goon-v3.yaml`](../../../briefs/characters/welcome-goon-v3.yaml).

## The Dungeon

- Constructed reality, not a real place
- Floors are generated for maximum entertainment value
- Architecture shifts between floors
- "Commercial breaks" are safe rooms — backstage areas

**Sources:** [`game-design-document.md`](game-design-document.md);
[`docs/knowledge/game-design/set-piece-lookbook.md`](set-piece-lookbook.md).

## Season Quirks (Procedural Personality Modifiers)

Each playthrough, The Director has a randomly selected obsession:

- Competitive baking
- Existential philosophy
- Aggressive product placement
- Symmetry obsession
- Nature documentary narration
- True crime commentary
- Self-help motivation
- Vintage game show references

**Sources:** [`game-design-document.md`](game-design-document.md).

## Sponsor Companies (Procedural)

Fake sponsor brands that theme items and gifts:

- GoobCo Energy (drinks → potions)
- Armadyne Defense Solutions (military → weapons)
- Sunny Meadows Organics (wholesome → healing)
- VOID Industries (ominous → dark magic)
- RetroFit Athletics (sports → movement buffs)
- More to be generated by Ollama based on season quirk

**Sources:** [`game-design-document.md`](game-design-document.md);
[`docs/knowledge/handoffs/2026-07-24-floor2-environmental-content.md`](../handoffs/2026-07-24-floor2-environmental-content.md).

## Timeline

- [REDACTED] years ago: The Gradient ascends past biology
- ~8,000 years ago: First entertainment harvest
- Present: Season [PROCEDURAL] begins
- Humanity's contract: unknown duration

**Sources:** [`game-design-document.md`](game-design-document.md).

## Tone Guide

- Dark humor, never grimdark
- The horror is bureaucratic, not visceral
- The Director is funny, not scary
- Death is inconvenient, not permanent (contestants respawn between seasons)
- Pop culture references are filtered through The Director's ancient, alien perspective

**Sources:** [`game-design-document.md`](game-design-document.md);
[`src/game/skills/registry.ts`](../../../src/game/skills/registry.ts);
[`docs/knowledge/adr/0070-achievement-reward-content-tiers.md`](../adr/0070-achievement-reward-content-tiers.md).
