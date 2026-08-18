# ADR: Spell Broker purchases and spell skill progression

- Status: Accepted
- Date: 2026-08-12

## Context

Floor 1 already has a ten-spell catalog and a quest reward path, but the Spell
Broker did not provide deterministic shop choices or a meaningful reason to
keep using a purchased spell. AI progression also had no explicit decision
that trades an equipment upgrade for a spell purchase.

## Decision

The Floor 1 Spell Broker uses a seed-derived, duplicate-free offer roll of
three spells from the ten-spell catalog. Each offer costs 35 gold and is
single-purchase, with the existing ability ownership and active-slot
validation remaining authoritative.

Each spell maps to its own usage skill. Successful player spell activations
emit one `spell_used` event; skill levels provide a small per-level efficacy
multiplier and larger cumulative breakpoint bonuses at levels 5, 10, 15, and 20. The reusable efficacy layer scales numeric spell outputs across damage,
healing, range, radius, buffs, slows, and life drain rather than creating
twenty new passive ability definitions.

The AI makes one seed-derived 25% spell-buy decision per run. When the intent
is active, a valid affordable broker purchase takes precedence over the
optional equipment purchase, preserving the requested opportunity cost.

## Consequences

### Positive

- Shop inventory and AI intent are replay-deterministic and do not consume the
  combat RNG stream.
- A spell purchase is a constrained strategic choice rather than free power.
- All ten spells have a consistent, observable progression path.
- Existing VFX and ability activation pipelines remain the presentation
  boundary.

### Negative and risks

- The 35-gold price and 25% AI choice require future balance evidence as the
  Floor 1 economy changes.
- A shared multiplier makes progression broad and predictable; spell-specific
  mechanics may eventually need bespoke milestone effects.
- The broker currently shares the existing Floor 1 spell quest-giver surface,
  so future NPC presentation changes must preserve the shop callbacks.

## Alternatives considered

1. Add a separate shop-only spell catalog. Rejected because it would duplicate
   the existing ten-spell reward definitions and create divergent ownership
   and VFX behavior.
2. Represent every breakpoint as a new passive ability. Rejected because it
   would multiply catalog and grant-source bookkeeping for effects that are
   fundamentally spell-output scaling.
3. Let the AI buy spells in addition to equipment. Rejected because it removes
   the explicit economic tradeoff requested for expensive spells.
