# ADR 0066: Unique Equipment Schema, Acquisition, and Duplicate Policy

## Status

Accepted

## Date

2026-07-19

## Estimated Complexity

3 apples — cross-system design for an authored singleton item tier layered on
the versioned generated-instance contract, covering schema, ownership, save,
acquisition, duplicates, abilities, art, and Director/lore integration.

## Context

ADR 0065 DEC-005 caps Floor 2 generated equipment at Common, Uncommon, and Rare
and explicitly defers Unique equipment to a later follow-up (DEC-010, tracked in
<https://github.com/nalfeo/Crawler/issues/1274>). The generated-instance model
(procedural resolution pipeline, effect-unit budget, registry-owned records,
SHA-256 fingerprints) is inappropriate for Unique equipment: authored Uniques
have hand-crafted identities and bespoke mechanics that cannot be expressed as
ordinary effect-unit budget entries, and they require authored acquisition sources
rather than a procedural generation path.

This ADR records the Unique equipment design decisions and the alternatives
considered, so that the normative spec (`unique-equipment.md` section in
`.specify/specs/equipment-system.md`) and the roster
(`.specify/specs/unique-equipment-roster.md`) have a stable, audited rationale.

Key constraints from the broader system:

- ADR 0065 DEC-006: Equipment-granted abilities are source-owned; this model must
  extend cleanly to Uniques.
- ADR 0065 DEC-009: Unknown future schemas fail closed; Unique saves must be
  forward-compatible.
- The constitutional DPS bands remain the balance authority; Unique mechanics must
  not exceed Rare-tier aggregate damage in representative builds unless the
  deviation is bounded by an explicit rarity-tier cap and reviewed against the
  1.7x-2.3x five-level growth gates.
- The 37-node Floor 2 equipment epic DAG (PLAN.md) is frozen; Unique equipment
  implementation is planned independently.

## Decision

- **DEC-001**: Unique equipment uses a **separate authored-singleton schema**
  (`unique-equipment-def/v1`) rather than extending `GeneratedEquipmentRarity` to
  include `'unique'`. A Unique is identified by a stable `UniqueEquipmentId`
  (`unique:<slug>`) authored at design time. The generated-instance registry and
  resolution pipeline are not used for Uniques.

- **DEC-002**: **Singleton ownership.** A player either owns a specific Unique or
  they do not. Ownership is tracked as a set of `UniqueEquipmentId` values in the
  player's persistent state. There is no instance count, no copy numbering, and no
  per-copy enhancement level unless the duplicate rule is `convert-upgrade`.

- **DEC-003**: **Per-Unique duplicate rules.** Every `UniqueEquipmentDef` declares
  exactly one of three rules:
  - `burn` — The second copy is immediately converted to the declared compensation
    (gold amount or a named crafting fragment). The player is informed with a
    Director-narrated message.
  - `disallow` — The acquisition source checks ownership before offering the item;
    the copy is not generated in the player's loot pool if they already own it.
    For seeded boss drops the slot is replaced by a fallback rare instance.
  - `convert-upgrade` — The second copy upgrades the owned copy's notional
    `upgradeLevel` by one (capped at the `maxUpgradeLevel` declared in the def).
    The original's mechanics scale with `upgradeLevel`; no separate copy is stored.

- **DEC-004**: **Authored acquisition sources.** Each Unique declares exactly one
  primary acquisition source. Valid source types:
  - `boss-drop` — drops from a specific boss on first kill (seed-deterministic;
    the drop outcome is computed from the world seed at floor-load, not at kill
    time).
  - `quest-reward` — granted by completing a specific authored quest.
  - `achievement-reward` — granted by the achievement system at unlock time, using
    the same atomic claim model as ADR 0065 DEC-007.
  - `merchant-exclusive` — appears in exactly one NPC merchant's stock under a
    declared eligibility condition (e.g. having reached a specific reputation tier
    or having completed a prerequisite).

- **DEC-005**: **Ability and passive grants extend DEC-006.** Unique-granted
  abilities use source IDs of the form `unique:<uniqueId>:<abilityOrdinal>`.
  The same source-owned semantics apply: the grant is active while the Unique is
  equipped; unequip removes only the originating source. No stacking of grants
  from the same Unique is possible because Uniques cannot be equipped twice
  simultaneously.

- **DEC-006**: **Save and migration model.** The player's persistent equipment
  state adds two new top-level fields:
  - `ownedUniques: UniqueEquipmentId[]` — sorted, deduplicated list of all Unique
    IDs the player has acquired. Preserved verbatim on load; unknown IDs are
    retained without error (forward-compatible).
  - `equippedUniques: { [slot: EquipmentSlotId]: UniqueEquipmentId | null }` — one
    entry per slot that a Unique occupies; null means no Unique in that slot.

  Migration from a save predating Unique support initializes both fields to empty.
  No rerolling or recomputation occurs during migration. Uniques carry across floor
  transitions alongside generated instances.

- **DEC-007**: **Art requirements.** Every `UniqueEquipmentDef` references a
  dedicated `spriteKey` (authored sprite, not from the generated art pipeline), a
  dedicated `iconKey`, and an optional `vfxKey` for the bespoke mechanic's visual.
  These art assets are not produced by `sprites:run`; they require explicit
  authored briefs and dedicated production waves outside the generated-art pipeline.

- **DEC-008**: **Director and lore integration.** Every Unique declares a short
  `lore` string (one to three sentences) displayed in the Director's commentary
  when the item is first acquired. Uniques may also declare optional
  `questId` and `achievementId` fields linking them to authored progression content
  for discovery hints and unlock messaging.

- **DEC-009**: **Compatibility with inventory, rewards, shops, chests, and
  carryover.** Uniques participate in the same ownership container model as
  generated instances: the bag stores `UniqueEquipmentId` references, equipped
  slots reference the ID directly, reward bundles may include Unique IDs (resolved
  at quest-complete or achievement-unlock), and carryover serializes the
  `ownedUniques` and `equippedUniques` fields. Unique IDs are never stored in the
  generated-instance registry.

## Authority

| Contract                                                    | Normative authority                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| Unique schema, ownership, save, acquisition, duplicate, art | `.specify/specs/equipment-system.md` (§ Unique Equipment)                |
| Unique authored roster (identity, lore, art per item)       | `.specify/specs/unique-equipment-roster.md`                              |
| Generated-instance contract (DEC-001 through DEC-009)       | `docs/knowledge/adr/0065-versioned-frozen-floor2-equipment-instances.md` |
| Constitutional DPS growth bands                             | `.specify/memory/constitution.md`                                        |
| Epic DAG and release flags                                  | `docs/knowledge/epics/floor-2-equipment/PLAN.md`                         |

## Consequences

### Positive

- Unique equipment identity, mechanics, and acquisition are completely isolated
  from the generated-instance resolution pipeline; neither system can destabilize
  the other.
- Per-Unique duplicate rules give each item a lore-coherent and balanced handling
  of the "found it twice" scenario without a single global policy that would fit
  some items poorly.
- The `disallow` duplicate rule for boss-drops prevents loot-table pollution when
  the player already owns the item.
- Source-owned ability grants extend cleanly from DEC-006 without new grant
  infrastructure.
- Forward-compatible save means a player who loads a save from a version that did
  not support a specific new Unique will not lose any known Uniques.
- Art production is decoupled from the generated-art wave pipeline, allowing
  Unique art to ship independently on its own schedule.

### Negative

- Two parallel item schemas (generated instances and Unique defs) add complexity
  to inventory UI, save/load, carryover, and any consumer that handles both.
- Authored Unique mechanics require bespoke code paths; they cannot be expressed
  as effect-unit configuration alone.
- Boss-drop `disallow` rule requires the loot resolver to check ownership state at
  floor-load time and substitute a fallback item, adding a dependency between loot
  generation and save state.
- Dedicated art for every Unique is a hard production dependency before a Unique
  can ship.

### Risks

- A consumer that checks only `GeneratedEquipmentRarity` and not the Unique
  schema could silently ignore equipped Uniques. Cross-system integration tests
  must exercise both item types in every container.
- Bespoke Unique mechanics that grant outsized DPS could violate the
  constitutional bands if not measured against the representative-build fixtures.
  Every Unique mechanic must be assessed before shipping.
- A migration that discards unknown `UniqueEquipmentId` values would silently
  delete player-owned items. The forward-compatible retention rule is the
  mitigation; it must be tested explicitly.

## Alternatives Considered

### Extend GeneratedEquipmentRarity to Include 'unique'

- **Description**: Add `'unique'` as a fourth rarity tier in the existing
  generated-instance pipeline with a larger effect-unit budget or special flag.
- **Rejected**: Authored identity, acquisition, and duplicate policy are
  categorically outside the effect-unit budget model. Merging them would require
  special-casing at every step of the resolution pipeline and would still not
  express bespoke mechanics that have no analog in the affix catalog. ADR 0065
  DEC-005 explicitly rejects this for the current epic.

### Procedural Unique Generation (Seeded Bespoke Rolls)

- **Description**: Author a small pool of "unique bases" and let the procedural
  pipeline randomly assign bespoke mechanics to generated items above a rarity
  threshold.
- **Rejected**: Procedural generation defeats the authored identity that makes
  Uniques valuable. Players acquiring the "same" named item in different runs
  would receive different mechanics, undermining lore coherence and
  build-planning. Achievement and quest integration requires stable
  unconditional identities.

### Single Global Duplicate Rule

- **Description**: Apply one policy (e.g. always burn, always disallow) to all
  Uniques.
- **Rejected**: Different Unique items have different lore-coherent and gameplay-
  coherent duplicate semantics. A revival ring that "already proved its owner's
  survival" has a different reason to disallow a second copy than a crafted bracer
  that could plausibly be upgraded by cannibalization. A global rule would produce
  either incoherent lore or suboptimal gameplay for some subset of items.

### Unique Stacking (Allow Multiple Copies)

- **Description**: Allow players to hold two or more copies of the same Unique.
- **Rejected**: Multiple copies of a singleton-identity item remove the scarcity
  and lore coherence that justify the Unique tier's bespoke mechanics. Ability
  stacking from duplicate equipped Uniques would require explicit dedup logic in
  the grant system and would make balance harder to bound.

### Lazy Art Assignment (Reuse Generated Art)

- **Description**: Assign a high-quality generated art key from the existing wave
  pipeline to Unique items rather than requiring bespoke authored art.
- **Rejected**: Generated art is algorithmically created for generic equipment
  families and does not carry the authored identity or visual distinctiveness that
  Unique items warrant. Players must be able to recognize a Unique at a glance;
  that requires dedicated art.
